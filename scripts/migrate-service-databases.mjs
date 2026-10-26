import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {services,identifier,databaseName,connected,connectionUrl,requireDirect,provisionDatabases,saveCredentials,fingerprint,verifyIsolation} from './lib/service-databases.mjs';

function pgTool(tool,url,args) {
  const u=new URL(url), executable=process.env.PG_BIN?join(process.env.PG_BIN,tool+(process.platform==='win32'?'.exe':'')):tool;
  // Secrets belong in the child environment, never command arguments or logs.
  return new Promise((done,reject)=>{
    const child=spawn(executable,args,{env:{...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:u.searchParams.get('sslmode')||'verify-full'},stdio:['ignore','ignore','pipe']});
    let error=''; child.stderr.on('data',chunk=>error+=chunk);
    child.on('error',()=>reject(new Error(tool+' could not start; install PostgreSQL clients or set PG_BIN')));
    child.on('exit',code=>code===0?done():reject(new Error(tool+' failed; no cutover was performed ('+code+'). '+error.replaceAll(decodeURIComponent(u.password),'[redacted]').slice(-2000))));
  });
}

export async function migrate({adminUrl,pooledUrl=adminUrl,state,save=()=>{},directory}) {
  requireDirect(adminUrl);
  const source=await connected(adminUrl);
  try {
    assert.ok(!services.map(databaseName).includes((await source.query('SELECT current_database() name')).rows[0].name),'Source must be the original shared database');
    // Preflight all sources/destinations before provisioning or restoring anything.
    for (const service of services) {
      assert.ok((await source.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='flyway_schema_history'",[service])).rowCount,'Source Flyway history missing: '+service);
      if ((await source.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName(service)])).rowCount) {
        const target=await connected(connectionUrl(adminUrl,databaseName(service)));
        try { assert.equal((await target.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')")).rows[0].n,0,'Destination is not empty; refusing overwrite: '+service); }
        finally { await target.end(); }
      }
    }
    mkdirSync(dirname(directory),{recursive:true,mode:0o700});
    mkdirSync(directory,{recursive:false,mode:0o700});
    await provisionDatabases({adminUrl,pooledUrl,state,save,createSchema:false});
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot=(await source.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;
    const proof={verifiedAt:new Date().toISOString(),sourceDatabase:new URL(adminUrl).pathname.slice(1),services:{}};
    for (const service of services) {
      const before=await fingerprint(source,service),dump=join(directory,service+'.dump');
      await pgTool('pg_dump',adminUrl,['--format=custom','--no-owner','--no-privileges','--schema='+service,'--snapshot='+snapshot,'--file='+dump]);
      await pgTool('pg_restore',connectionUrl(adminUrl,databaseName(service)),['--dbname='+databaseName(service),'--exit-on-error','--single-transaction','--no-owner','--no-privileges','--role='+state[service].role,dump]);
      const target=await connected(state[service].DATABASE_URL_UNPOOLED);
      try {
        await target.query(`REVOKE ALL ON SCHEMA ${identifier(service)} FROM PUBLIC`);
        assert.deepEqual(await fingerprint(target,service),before,'Restored data/schema/sequence mismatch: '+service);
        assert.equal((await target.query(`SELECT count(*)::int n FROM ${identifier(service)}.flyway_schema_history WHERE NOT success`)).rows[0].n,0,'Failed source migration');
        proof.services[service]={database:databaseName(service),tables:Object.keys(before.tables).length,rows:Object.values(before.tables).reduce((n,t)=>n+t.rows,0),dataSchemaAndSequencesMatch:true};
      } finally { await target.end(); }
      console.log('PASS restored '+service+' with complete content verification');
    }
    proof.isolationChecks=await verifyIsolation(state);
    await source.query('COMMIT');
    writeFileSync(join(directory,'proof.json'),JSON.stringify(proof,null,2));
    console.log('PASS '+proof.isolationChecks+' own/cross-database access checks');
    return proof;
  } catch (error) { await source.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { await source.end(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const file=['.env','.env.local'].find(existsSync);
  if (file) for (const [key,value] of Object.entries(parseEnv(readFileSync(file,'utf8')))) process.env[key]??=value;
  // A snapshot cannot capture later writes: quiesce APIs AND background jobs first.
  assert.equal(process.env.CONFIRM_DATABASE_WRITERS_STOPPED,'true','Stop source writers and confirm before copying');
  const url=process.env.DATABASE_URL_UNPOOLED;
  assert.equal(new URL(url).hostname,process.env.MIGRATION_EXPECTED_HOST,'Explicitly confirm the source host');
  const path=process.env.SERVICE_CREDENTIALS_FILE||'.env.services.json',output=process.env.TARGET_SERVICE_CREDENTIALS_FILE;
  assert.ok(output && resolve(output)!==resolve(path),'Use a NEW target credential file');
  assert.ok(!existsSync(output),'Target credential file exists; inspect partial results before retrying');
  const state=JSON.parse(readFileSync(path,'utf8'));
  try { await migrate({adminUrl:url,pooledUrl:process.env.DATABASE_URL,state,save:value=>saveCredentials(output,value),directory:resolve(process.env.DATABASE_BACKUP_DIR||'.tools/database-migration-'+Date.now())}); }
  catch (error) { console.error('Migration failed: '+error.message); process.exitCode=1; }
}
