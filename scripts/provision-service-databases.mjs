import {readFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {provisionDatabases,saveCredentials,verifyIsolation} from './lib/service-databases.mjs';
const file=['.env','.env.local'].find(existsSync);
if(file)for(const[k,v]of Object.entries(parseEnv(readFileSync(file,'utf8'))))process.env[k]??=v;
if(process.env.NEON_BRANCH==='production'&&process.env.CONFIRM_PRODUCTION_PROVISION!=='true')throw new Error('Use an isolated development branch first');
const path=process.env.SERVICE_CREDENTIALS_FILE||'.env.services.json';
const state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
try {
 await provisionDatabases({adminUrl:process.env.DATABASE_URL_UNPOOLED,pooledUrl:process.env.DATABASE_URL,state,save:value=>saveCredentials(path,value)});
 console.log('PASS six separate databases; isolation checks: '+await verifyIsolation(state));
}catch(error){console.error('Provisioning failed: '+(error.code||error.name)+'. Original databases and passwords were not replaced.');process.exitCode=1;}
