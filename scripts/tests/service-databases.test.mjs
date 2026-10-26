import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {services,connected,connectionUrl,databaseName,provisionDatabases,verifyIsolation,fingerprint} from '../lib/service-databases.mjs';
import {migrate} from '../migrate-service-databases.mjs';

async function postgres(fixture,run) {
  const name='psi-db-test-'+randomUUID(),password=randomUUID();
  const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,...options});
  let started=false;
  try {
    docker(['run','--detach','--name',name,'--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=legacy','postgres:17-alpine'],{env:{...process.env,POSTGRES_PASSWORD:password}}); started=true;
    for(let i=0;i<100;i++) {
      try {docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','legacy']);break;}catch{await new Promise(r=>setTimeout(r,200));}
      if(i===99)throw new Error('Test PostgreSQL did not start');
    }
    const port=docker(['port',name,'5432/tcp']).trim().split(':').at(-1);
    const url=`postgresql://postgres:${password}@127.0.0.1:${port}/legacy?sslmode=disable`;
    docker(['exec','--interactive',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','legacy'],{input:readFileSync(fixture,'utf8'),stdio:['pipe','pipe','pipe']});
    await run(url);
  } finally {if(started)docker(['rm','--force',name]);}
}

test('fresh PostgreSQL init creates six isolated databases; provisioning preserves credentials and is repeatable',async()=>{
  await postgres(new URL('../../deploy/postgres-init.sql',import.meta.url),async url=>{
    const state=Object.fromEntries(services.map(service=>[service,{role:databaseName(service),password:service+'_local'}]));
    await provisionDatabases({adminUrl:url,state});
    assert.equal(await verifyIsolation(state),36);
    for(const service of services){
      const client=await connected(state[service].DATABASE_URL_UNPOOLED);
      try {await client.query(`CREATE TABLE ${service}.preserved(id integer PRIMARY KEY); INSERT INTO ${service}.preserved VALUES (42)`);}finally{await client.end();}
    }
    const old=structuredClone(state);
    await provisionDatabases({adminUrl:url,state});
    assert.deepEqual(state,old);
    for(const service of services){
      const client=await connected(state[service].DATABASE_URL_UNPOOLED);
      try {assert.equal((await client.query(`SELECT id FROM ${service}.preserved`)).rows[0].id,42);}finally{await client.end();}
    }
    await assert.rejects(provisionDatabases({adminUrl:url,state:{}}),/original credentials/);
  });
});

test('shared schemas migrate without losing rows, Flyway history, indexes or sequences; retry refuses overwrite',async()=>{
  await postgres(new URL('./fixtures/shared-database.sql',import.meta.url),async url=>{
    const state=Object.fromEntries(services.map(service=>[service,{role:databaseName(service),password:service+'_local'}]));
    const source=await connected(url),before={};
    try {
      for(const service of services){
        await source.query(`SET ROLE psi_${service}; CREATE TABLE ${service}.flyway_schema_history(installed_rank integer PRIMARY KEY,version text,success boolean); INSERT INTO ${service}.flyway_schema_history VALUES(1,'1',true); CREATE TABLE ${service}.sample(id serial PRIMARY KEY,amount numeric(12,2),description text NOT NULL); INSERT INTO ${service}.sample(amount,description) VALUES(12.34,'LietuviÅ¡ki duomenys'),(-1.25,'correction'); RESET ROLE`);
        before[service]=await fingerprint(source,service);
      }
      const folder=mkdtempSync(join(tmpdir(),'psi-db-migration-'));
      const proof=await migrate({adminUrl:url,state,directory:join(folder,'backup')});
      assert.equal(proof.isolationChecks,36);
      for(const service of services){
        assert.deepEqual(await fingerprint(source,service),before[service],'Source must remain unchanged');
        const target=await connected(state[service].DATABASE_URL_UNPOOLED);
        try{assert.equal((await target.query(`INSERT INTO ${service}.sample(amount,description) VALUES(0,'next') RETURNING id`)).rows[0].id,3);}finally{await target.end();}
      }
      await assert.rejects(migrate({adminUrl:url,state,directory:join(folder,'retry')}),/Destination is not empty/);
      for(const service of services)assert.equal((await source.query(`SELECT count(*)::int n FROM ${service}.sample`)).rows[0].n,2);
      const wrong=await connected(connectionUrl(url,'psi_rental'));
      try{assert.deepEqual((await wrong.query("SELECT nspname FROM pg_namespace WHERE nspname=ANY($1) ORDER BY nspname",[services])).rows,[{nspname:'rental'}]);}finally{await wrong.end();}
    }finally{await source.end();}
  });
});
