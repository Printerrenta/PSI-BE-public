import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {services,databaseName,saveCredentials} from './lib/service-databases.mjs';
import {migrate} from './migrate-service-databases.mjs';
const file=['.env','.env.local'].find(existsSync);
if(file)for(const[k,v]of Object.entries(parseEnv(readFileSync(file,'utf8'))))process.env[k]??=v;
assert.equal(process.env.CONFIRM_DATABASE_WRITERS_STOPPED,'true','Stop all seven local application containers first');
// This command deliberately ignores Neon URLs from a copied .env.local.
const url=new URL('postgresql://postgres@127.0.0.1/rental?sslmode=disable');
url.password=process.env.POSTGRES_PASSWORD||'postgres_local';
url.port=process.env.MIGRATION_DB_PORT||'15432';
const output='.env.services.separate-local.json';
assert.ok(!existsSync(output),'Previous migration state exists; inspect it before retrying');
const state=Object.fromEntries(services.map(service=>[service,{role:databaseName(service),password:service+'_local'}]));
try{await migrate({adminUrl:url.toString(),state,save:value=>saveCredentials(output,value),directory:resolve('.tools/local-database-backup-'+Date.now())});}
catch(error){console.error('Local migration failed: '+error.message);process.exitCode=1;}
