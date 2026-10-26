import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdtempSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {verifyIsolation} from './lib/service-databases.mjs';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
// Runs only against an explicitly selected expiring test branch. It retains immutable
// financial test documents there; remove the branch after review rather than deleting history.
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const envName=['.env','.env.local'].find(n=>existsSync(join(projectRoot,n)));
const local={...(envName?parseEnv(readFileSync(join(projectRoot,envName),'utf8')):{}),...process.env};
const root=resolve(local.SERVICE_REPOSITORIES_ROOT||resolve(projectRoot,'..'))+'/';
const connection=new URL(local.DATABASE_URL_UNPOOLED);
assert.match(local.NEON_BRANCH||'',/^(accounting-test-|database-test-)/,'Explicit isolated test environment required');
assert.equal(connection.hostname,local.ACCOUNTING_TEST_EXPECTED_HOST,'Confirm isolated branch hostname through ACCOUNTING_TEST_EXPECTED_HOST');
const state={name:local.NEON_BRANCH,id:local.NEON_BRANCH,host:connection.hostname};
const credentials=JSON.parse(readFileSync(resolve(projectRoot,local.SERVICE_CREDENTIALS_FILE||'.env.services.json')));
for(const name of ['identity','rental','metering','billing','notifications'])assert.ok(credentials[name]?.role&&credentials[name]?.password,'Missing restricted credentials for '+name);
assert.ok(local.PUBSUB_EMULATOR_JAR,'Set PUBSUB_EMULATOR_JAR to the installed Google emulator JAR');
const work=pathToFileURL(mkdtempSync(join(tmpdir(),'psi-accounting-'))+'/');
const {Client,Pool}=createRequire(join(projectRoot,'package.json'))('pg');
const url=new URL(local.DATABASE_URL_UNPOOLED);url.hostname=state.host;if(!['localhost','127.0.0.1'].includes(url.hostname))url.searchParams.set('sslmode','verify-full');
const databases=Object.fromEntries(Object.entries(credentials).map(([name,c])=>{const u=new URL(c.DATABASE_URL_UNPOOLED);assert.equal(u.hostname,state.host,'Credential host mismatch');assert.equal(u.pathname,'/psi_'+name,'Separate service database required');const pool=new Pool({connectionString:u.toString(),max:1,idleTimeoutMillis:10000,connectionTimeoutMillis:30000,keepAlive:true});pool.on('error',e=>console.warn('Test DB connection closed: '+e.code));return [name,pool];}));
const java=local.JAVA_HOME?join(local.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
const children=[];const outputs={};let checks=0;
const ports={identity:18301,rental:18302,metering:18303,billing:18304,notifications:18305,gateway:18306};
const broker='127.0.0.1:18315';const project='printer-rental-local';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const issuer='http://127.0.0.1:18316';
const jwks=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[{...publicKey.export({format:'jwk'}),kid:'isolated-e2e',use:'sig',alg:'EdDSA'}]}));});
function token(sub){const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const now=Math.floor(Date.now()/1000);const value=encode({alg:'EdDSA',kid:'isolated-e2e'})+'.'+encode({iss:issuer,sub,email:sub+'@example.com',iat:now,exp:now+3600});return value+'.'+sign(null,Buffer.from(value),privateKey).toString('base64url');}
function redact(value){for(const v of [url.toString(),...Object.values(credentials).flatMap(x=>Object.values(x))].filter(v=>typeof v==='string'&&v.length>10))value=value.replaceAll(v,'[redacted]');return value;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(name,fn){for(let i=0;i<100;i++){try{const result=await fn();if(result)return result;}catch{}await delay(500);}throw new Error('Timeout: '+name);}
function launch(name,args,env={}){outputs[name]='';const p=spawn(java,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(p);p.on('error',e=>{outputs[name]+='\n'+e.message;});for(const stream of [p.stdout,p.stderr])stream.on('data',b=>outputs[name]+=b.toString());return p;}
async function start(kind,repo,jar,extra={}){
 const c=credentials[kind];const target=c?new URL(c.DATABASE_URL_UNPOOLED):url;const jdbc=`jdbc:postgresql://${target.hostname}:${target.port||5432}${target.pathname}?sslmode=${target.searchParams.get('sslmode')||'verify-full'}&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory&currentSchema=${kind}`;
 const env={SERVICE_SCHEMA:kind,DB_URL:jdbc,DB_USERNAME:c?.role||'',DB_PASSWORD:c?.password||'',DB_MIGRATION_URL:jdbc,DB_MIGRATION_USERNAME:c?.role||'',DB_MIGRATION_PASSWORD:c?.password||'',NEON_AUTH_BASE_URL:issuer+'/auth',NEON_AUTH_JWKS_URL:issuer+'/jwks',IDENTITY_SERVICE_URL:'http://127.0.0.1:'+ports.identity,RENTAL_SERVICE_URL:'http://127.0.0.1:'+ports.rental,PUBSUB_EMULATOR_HOST:broker,PUBSUB_PROJECT:project,INTERNAL_AUTH_MODE:'emulator',OUTBOX_INITIAL_DELAY_MS:'1000',OUTBOX_FIXED_DELAY_MS:'1000',INBOX_INITIAL_DELAY_MS:'1000',...extra};
 const p=launch(kind,['-Xmx128m','-XX:+UseSerialGC','-XX:ActiveProcessorCount=2','-Xss512k','-XX:ReservedCodeCacheSize=24m','-jar',root+repo+'/target/'+jar+'.jar','--server.address=127.0.0.1','--server.port='+ports[kind]],env);
 await until(kind+' startup',()=>{if(p.exitCode!==null)throw new Error(kind+' exited');return outputs[kind].includes('Started ');});console.log('STARTED '+kind);
}
async function brokerCall(path,body={}){const r=await fetch('http://'+broker+'/v1/projects/'+project+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,'Broker '+path+' '+r.status);}
async function api(path,sub,{method='GET',body,status=200}={}){const r=await fetch('http://127.0.0.1:'+ports.gateway+path,{method,headers:{...(sub?{Authorization:'Bearer '+token(sub)}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const txt=await r.text();assert.equal(r.status,status,`${method} ${path}: ${r.status} ${txt}`);checks++;return txt?JSON.parse(txt):null;}
try{
 assert.equal(await verifyIsolation(credentials),36);console.log('PASS 36 separate-database isolation checks');
 await new Promise(r=>jwks.listen(18316,'127.0.0.1',r));
 launch('pubsub',['-Xmx160m','-XX:+UseSerialGC','-XX:ActiveProcessorCount=2','-jar',local.PUBSUB_EMULATOR_JAR,'--host=127.0.0.1','--port=18315']);
 await until('Pub/Sub startup',async()=>{const r=await fetch('http://'+broker+'/v1/projects/'+project+'/topics');return r.ok;});
 for(const name of ['rental','metering','billing'])await brokerCall('/topics/'+name+'-events-v1');
 const subs=[['rental-metering-v1','rental','metering'],['rental-billing-v1','rental','billing'],['metering-billing-v1','metering','billing'],['metering-notifications-v1','metering','notifications'],['billing-notifications-v1','billing','notifications']];
 for(const [name,source,target]of subs)await brokerCall('/subscriptions/'+name,{topic:`projects/${project}/topics/${source}-events-v1`,pushConfig:{pushEndpoint:`http://127.0.0.1:${ports[target]}/internal/events`},ackDeadlineSeconds:10});
 await start('identity','psi-identity-service','identity-service');
 await start('rental','psi-rental-service','rental-service');
 await start('metering','psi-metering-service','metering-service',{PUBSUB_SUBSCRIPTIONS:`projects/${project}/subscriptions/rental-metering-v1`});
 await start('billing','psi-billing-service','billing-service',{PUBSUB_SUBSCRIPTIONS:`projects/${project}/subscriptions/rental-billing-v1,projects/${project}/subscriptions/metering-billing-v1`});
 await start('notifications','psi-notification-service','notification-service',{PUBSUB_SUBSCRIPTIONS:`projects/${project}/subscriptions/metering-notifications-v1,projects/${project}/subscriptions/billing-notifications-v1`});
 await start('gateway','psi-api-gateway','api-gateway',{DOCUMENT_SERVICE_URL:'http://127.0.0.1:1',NOTIFICATION_SERVICE_URL:'http://127.0.0.1:'+ports.notifications,METERING_SERVICE_URL:'http://127.0.0.1:'+ports.metering,BILLING_SERVICE_URL:'http://127.0.0.1:'+ports.billing});
 const mark='accounting-e2e-'+randomUUID();const alice=mark+'-alice',bob=mark+'-bob',staff=mark+'-staff';
 await api('/api/billing/account',null,{status:401});
 for(const sub of [alice,bob,staff])await api('/api/auth/me',sub);
 await databases.identity.query("UPDATE identity.app_users SET role='EMPLOYEE' WHERE subject=$1",[staff]);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Vilnius'}).format(new Date());
 const printer=await api('/api/printers',staff,{method:'POST',status:201,body:{serialNumber:mark,manufacturer:'Isolated test',model:'A3 colour',colorCapable:true}});
 let request=await api('/api/rental-requests',alice,{method:'POST',status:201,body:{customerName:'Isolated accounting',customerEmail:'test@example.com',estimatedMonthlyPages:100,colorPrintingRequired:true,startDate:today,endDate:today}});
 for(const change of [{status:'IN_REVIEW'},{printerId:printer.id},{status:'APPROVED'}])request=await api('/api/rental-requests/'+request.id+(change.printerId?'/printer':'/status'),staff,{method:'PATCH',body:{version:request.version,...change}});
 let contract=await api('/api/contracts',staff,{method:'POST',status:201,body:{rentalRequestId:request.id,requestVersion:request.version,monthlyFee:31,includedMonoPages:0,includedColorPages:0,monoPagePrice:0.01,colorPagePrice:0.03}});
 contract=await api(`/api/contracts/${contract.id}/activate`,staff,{method:'POST',body:{version:contract.version,initialMonoReading:0,initialColorReading:0,initialReadingDate:today}});
 await api(`/api/contracts/${contract.id}/accounting`,staff,{method:'POST',body:{a3Capable:true,baseline:[0,0,0,0],vatPercent:21,paymentTermDays:14}});
 const stream=await until('contract snapshot through Pub/Sub',()=>api(`/api/metering/contracts/${contract.id}`,alice));
 await until('billing contract snapshot through Pub/Sub',()=>api(`/api/billing/contracts/${contract.id}`,alice));
 await api(`/api/metering/contracts/${contract.id}`,bob,{status:403});
 await api('/api/metering/policies/DEVICE',staff,{method:'POST',body:{key:printer.id,minimumPerDay:0,maximumPerDay:10000,version:0}});
 const submission={requestKey:randomUUID(),version:stream.version,asOf:today,counters:[100,20,10,5]};
 const reading=await api(`/api/metering/contracts/${contract.id}/readings`,alice,{method:'POST',body:submission});assert.equal(reading.reading.status,'ACCEPTED');
 assert.equal((await api(`/api/metering/contracts/${contract.id}/readings`,alice,{method:'POST',body:submission})).reading.id,reading.reading.id);
 await until('reading through Pub/Sub',async()=>Number((await databases.billing.query('SELECT count(*) n FROM billing.reading_projections WHERE contract_id=$1',[contract.id])).rows[0].n)===1);
 contract=await api(`/api/contracts/${contract.id}/complete`,staff,{method:'POST',body:{version:contract.version,finalMonoReading:110,finalColorReading:25,finalReadingDate:today}});
 await until('completion through Pub/Sub',async()=>{const x=await api(`/api/billing/contracts/${contract.id}`,alice);return x.status==='COMPLETED';});
 const issue={requestKey:randomUUID(),period:today.slice(0,7)};
 await api(`/api/billing/contracts/${contract.id}/invoices`,alice,{method:'POST',body:issue,status:403});
 const invoice=await api(`/api/billing/contracts/${contract.id}/invoices`,staff,{method:'POST',body:issue});
 // Exact expected cents for one planned rental day; each displayed VAT line rounds separately.
 const [year,month]=today.split('-').map(Number);const days=new Date(Date.UTC(year,month,0)).getUTCDate();
 const fixedCents=Math.round(3100/days),netCents=fixedCents+210,vatCents=Math.round(fixedCents*21/100)+44,gross=(netCents+vatCents)/100;
 assert.equal(Number(invoice.invoice.calculation.net),netCents/100);assert.equal(Number(invoice.invoice.amountDue),gross);
 assert.equal((await api(`/api/billing/contracts/${contract.id}/invoices`,staff,{method:'POST',body:issue})).invoice.id,invoice.invoice.id);
 await api(`/api/billing/invoices/${invoice.invoice.id}`,bob,{status:403});
 const payment={id:randomUUID(),ownerSubject:alice,amount:(netCents+vatCents+125)/100,receivedOn:today,reference:mark};
 await api('/api/billing/payments',alice,{method:'POST',body:payment,status:403});
 await api('/api/billing/payments',staff,{method:'POST',body:payment});await api('/api/billing/payments',staff,{method:'POST',body:payment});
 const balance=await api('/api/billing/account',alice);assert.equal(Number(balance.outstanding),0);assert.equal(Number(balance.advance),1.25);assert.equal(Number(balance.received),payment.amount);
 assert.equal((await api(`/api/billing/invoices/${invoice.invoice.id}`,alice)).status,'PAID');
 await until('accounting notifications through Pub/Sub',async()=>{const n=await api('/api/notifications?size=100',alice);return n.content.some(x=>(x.type||x.eventType)==='InvoiceIssued')&&n.content.some(x=>(x.type||x.eventType)==='PaymentReceived');});
 const proof={branch:state.id,verifiedAt:new Date().toISOString(),checks,services:6,broker:'Google Pub/Sub emulator',signature:'real Ed25519 JWT with isolated local JWKS (no production Auth changes)',databaseIsolation:true,net:netCents/100,vat:vatCents/100,gross,payment:payment.amount,advance:1.25,immutableTestDataRetainedOnlyOnExpiringBranch:true};
 console.log('Evidence directory: '+fileURLToPath(work));
 writeFileSync(new URL('accounting-e2e-proof.json',work),JSON.stringify(proof,null,2));console.log('PASS '+JSON.stringify(proof));
}catch(e){console.error(redact(e.stack));process.exitCode=1;}finally{for(const p of children)p.kill();jwks.close();await Promise.all(Object.values(databases).map(db=>db.end().catch(()=>{})));for(const [name,out]of Object.entries(outputs))writeFileSync(new URL('accounting-e2e-'+name+'.log',work),redact(out));}
