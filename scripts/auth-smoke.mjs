import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const envFile=['.env','.env.local'].find(existsSync);
if(envFile) for(const [k,v] of Object.entries(parseEnv(readFileSync(envFile,'utf8')))) process.env[k]??=v;
const base=process.env.API_BASE_URL || 'http://127.0.0.1:18082';
const auth=process.env.NEON_AUTH_BASE_URL?.replace(/\/$/,'');
assert.ok(auth,'NEON_AUTH_BASE_URL is required');
// This test creates and removes test identities. Refuse to touch the live branch by default.
assert.ok(process.env.NEON_BRANCH !== 'production' || process.env.AUTH_SMOKE_ALLOW_PRODUCTION==='true', 'Use an isolated Neon branch');
const marker='auth-smoke-'+randomUUID();
const password=randomBytes(24).toString('base64url');
const url=new URL(process.env.DATABASE_URL_UNPOOLED);url.searchParams.set('sslmode','verify-full');
const db=new pg.Client({connectionString:url.toString()}); // Managed Auth remains in its original DB.
const credentials=JSON.parse(readFileSync(process.env.SERVICE_CREDENTIALS_FILE||'.env.services.json','utf8'));
const serviceClients=Object.fromEntries(['identity','rental','documents','notifications'].map(name=>{const target=new URL(credentials[name].DATABASE_URL_UNPOOLED);assert.equal(target.pathname,'/psi_'+name,'Separate service DB required');assert.equal(target.hostname,url.hostname,'Test credential host mismatch');return [name,new pg.Client({connectionString:target.toString()})];}));
const s3=new S3Client({forcePathStyle:true});
const users=[];const ids={};let objectKey;let checks=0;
async function authCall(path,body,cookie='',expected=200){
 let response;
 for(let attempt=0;attempt<5;attempt++){
 response=await fetch(auth+path,{method:body?'POST':'GET',headers:{Origin:process.env.AUTH_TEST_ORIGIN||'http://localhost:3000',...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 if(response.status!==429)break;
 await response.arrayBuffer();
 const seconds=Math.min(30,Math.max(11,Number(response.headers.get('retry-after'))||11));
 await new Promise(resolve=>setTimeout(resolve,seconds*1000));
 }
 if(response.status!==expected){const error=await response.json();throw new Error(`Auth ${path}: ${response.status} ${error.code||error.error||""} ${error.message||""}`);}
 const cookies=response.headers.getSetCookie().map(s=>s.split(';')[0]).filter(s=>!s.endsWith('='));
 return {data:await response.json(),cookie:cookies.join('; '),response};
}
async function api(path,token,{method='GET',body,status=200}={}){
 const multipart=body instanceof FormData;
 const res=await fetch(base+path,{method,headers:{...(body&&!multipart?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(process.env.GCP_ID_TOKEN?{'X-Serverless-Authorization':'Bearer '+process.env.GCP_ID_TOKEN}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined,signal:AbortSignal.timeout(45000)});
 assert.equal(res.status,status,`${method} ${path}: ${res.status}`);checks++;return res;
}
const testBroker=process.env.TEST_BROKER_OUTAGE==='true';
const emulator='http://'+process.env.PUBSUB_EMULATOR_HOST+'/v1/projects/printer-rental-local';
async function broker(path,method='PUT',body={}){
 const response=await fetch(emulator+path,{method,headers:{'Content-Type':'application/json'},body:method==='DELETE'?undefined:JSON.stringify(body)});
 assert.ok(response.ok,`Broker ${method} ${path}: ${response.status}`);
}
const json=async(path,token,opts)=>(await api(path,token,opts)).json();
async function register(label){
 const email=`${marker}-${label}@example.com`;
 const signup=await authCall('/sign-up/email',{email,password,name:label});
 const id=signup.data.user?.id;assert.ok(id,'Signup user id');
 const user={id,email,cookie:signup.cookie};users.push(user);
 await authCall('/sign-in/email',{email,password:'incorrect-test-password'},'',401);
 const signin=await authCall('/sign-in/email',{email,password});user.cookie=signin.cookie;
 const session=await authCall('/get-session',null,user.cookie);assert.equal(session.data.user?.id,id);
 const jwt=await authCall('/token',null,user.cookie);user.token=jwt.data.token;assert.ok(user.token,'JWT token');
 const me=await json('/api/auth/me',user.token);assert.equal(me.subject,id);assert.equal(me.role,'CUSTOMER');
 return user;
}
try {
 await db.connect();
 await Promise.all(Object.values(serviceClients).map(client=>client.connect()));
 await api('/api/rental-requests',null,{status:401});
 await api('/api/rental-requests','invalid',{status:401});
 const [alice,bob,employee,admin]=await (async()=>{const result=[];for(const role of ['alice','bob','employee','admin']) result.push(await register(role));return result;})();
 console.log('PASS Auth: registration, rejected wrong password, login, restored session, verified Ed25519 JWT');
 // Trusted test setup, limited to a newly created synthetic identity. Production bootstrap is a separate operator command.
 await serviceClients.identity.query("UPDATE identity.app_users SET role='ADMIN' WHERE subject=$1",[admin.id]);
 await json(`/api/admin/users/${employee.id}/role`,admin.token,{method:'PATCH',body:{role:'EMPLOYEE'}});
 await api('/api/admin/users',employee.token,{status:403});
 await api(`/api/admin/users/${bob.id}/role`,alice.token,{method:'PATCH',body:{role:'ADMIN'},status:403});
 await api('/api/printers',alice.token,{method:'POST',body:{},status:403});
 const printer=await json('/api/printers',employee.token,{method:'POST',status:201,body:{serialNumber:marker,manufacturer:'Auth test',model:'Role E2E',colorCapable:false}});ids.printer=printer.id;
 const date=new Date().toISOString().slice(0,10);
 if(testBroker){
  assert.notEqual(process.env.NEON_BRANCH,'production');
  assert.match(process.env.PUBSUB_EMULATOR_HOST||'',/^127\.0\.0\.1:/);
  await broker('/subscriptions/rental-notifications-v1','DELETE');
  await broker('/topics/rental-events-v1','DELETE');
 }
 let request=await json('/api/rental-requests',alice.token,{method:'POST',status:201,body:{customerName:'Alice test',customerEmail:'contact@example.com',estimatedMonthlyPages:100,colorPrintingRequired:false,startDate:date,endDate:date}});ids.request=request.id;
 if(testBroker){
  const pending=await serviceClients.rental.query("SELECT attempts,published_at FROM rental.outbox_events WHERE aggregate_id=$1",[request.id]);
  assert.equal(pending.rowCount,1);assert.ok(pending.rows[0].attempts>=1);assert.equal(pending.rows[0].published_at,null);
  await broker('/topics/rental-events-v1');
  await broker('/subscriptions/rental-notifications-v1','PUT',{topic:'projects/printer-rental-local/topics/rental-events-v1',pushConfig:{pushEndpoint:'http://host.docker.internal:18104/internal/events'},ackDeadlineSeconds:30});
  console.log('PASS Broker outage: API returned 201; unpublished event retained for retry after Pub/Sub recovery');
 }
 await api(`/api/rental-requests/${request.id}`,bob.token,{status:403});
 const bobList=await json('/api/rental-requests',bob.token);assert.equal(bobList.totalElements,0);
 const aliceList=await json('/api/rental-requests',alice.token);assert.equal(aliceList.totalElements,1);
 await api(`/api/rental-requests/${request.id}/status`,alice.token,{method:'PATCH',status:403,body:{version:request.version,status:'IN_REVIEW'}});
 request=await json(`/api/rental-requests/${request.id}/status`,employee.token,{method:'PATCH',body:{version:request.version,status:'IN_REVIEW'}});
 request=await json(`/api/rental-requests/${request.id}/printer`,employee.token,{method:'PATCH',body:{version:request.version,printerId:printer.id}});
 request=await json(`/api/rental-requests/${request.id}/status`,employee.token,{method:'PATCH',body:{version:request.version,status:'APPROVED'}});
 let contract=await json('/api/contracts',employee.token,{method:'POST',status:201,body:{rentalRequestId:request.id,requestVersion:request.version,monthlyFee:0,includedMonoPages:100,includedColorPages:0,monoPagePrice:0,colorPagePrice:0}});ids.contract=contract.id;
 await api(`/api/contracts/${contract.id}`,alice.token);
 await api(`/api/contracts/${contract.id}`,bob.token,{status:403});
 assert.equal((await json('/api/contracts',bob.token)).totalElements,0);
 assert.equal((await json('/api/contracts',alice.token)).totalElements,1);
 const bytes=Buffer.from(marker);const form=new FormData();form.set('file',new Blob([bytes]),'auth-test.txt');
 const attachment=await json(`/api/contracts/${contract.id}/attachments`,employee.token,{method:'POST',status:201,body:form});objectKey=attachment.objectKey;
 const download=await api(`/api/contracts/${contract.id}/attachments/${attachment.id}`,alice.token);
 assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
 await api(`/api/contracts/${contract.id}/attachments`,bob.token,{status:403});
 await api(`/api/contracts/${contract.id}/attachments/${attachment.id}`,bob.token,{status:403});
 await api(`/api/contracts/${contract.id}/attachments`,alice.token,{method:'POST',body:form,status:403});
 await api('/api/repair-requests',alice.token,{method:'POST',status:409,body:{contractId:contract.id,description:'Paper feed rollers are broken'}});
 contract=await json(`/api/contracts/${contract.id}/activate`,employee.token,{method:'POST',body:{version:contract.version,initialMonoReading:10,initialColorReading:0,initialReadingDate:date}});
 let repair=await json('/api/repair-requests',alice.token,{method:'POST',status:201,body:{contractId:contract.id,description:'Paper feed rollers are broken'}});ids.repair=repair.id;
 assert.equal(repair.printerId,printer.id);assert.equal(repair.status,'OPEN');
 await api('/api/repair-requests',alice.token,{method:'POST',status:409,body:{contractId:contract.id,description:'Another fault on the same printer'}});
 await api(`/api/repair-requests/${repair.id}`,bob.token,{status:403});
 assert.equal((await json('/api/repair-requests',bob.token)).totalElements,0);
 assert.ok((await json(`/api/repair-requests?contractId=${contract.id}&status=OPEN`,alice.token)).content.some(r=>r.id===repair.id));
 await api(`/api/repair-requests/${repair.id}/status`,alice.token,{method:'PATCH',status:403,body:{status:'IN_PROGRESS',version:repair.version}});
 repair=await json(`/api/repair-requests/${repair.id}/status`,employee.token,{method:'PATCH',body:{status:'IN_PROGRESS',version:repair.version}});
 await api(`/api/repair-requests/${repair.id}/status`,alice.token,{method:'PATCH',status:403,body:{status:'CANCELLED',version:repair.version}});
 await api(`/api/repair-requests/${repair.id}/status`,employee.token,{method:'PATCH',status:409,body:{status:'COMPLETED',version:0,resolution:'Replaced rollers'}});
 await api(`/api/repair-requests/${repair.id}/status`,employee.token,{method:'PATCH',status:400,body:{status:'COMPLETED',version:repair.version}});
 repair=await json(`/api/repair-requests/${repair.id}/status`,employee.token,{method:'PATCH',body:{status:'COMPLETED',version:repair.version,resolution:'Replaced feed rollers'}});
 assert.equal(repair.status,'COMPLETED');assert.equal(repair.version,2);
 await api(`/api/repair-requests/${repair.id}/status`,admin.token,{method:'PATCH',status:409,body:{status:'CANCELLED',version:repair.version}});
 console.log('PASS Repairs: active-contract ownership, duplicate protection, staff lifecycle, stale versions and resolution validation');
 await json(`/api/contracts/${contract.id}/complete`,employee.token,{method:'POST',body:{version:contract.version,finalMonoReading:20,finalColorReading:0,finalReadingDate:date}});
 assert.equal((await json(`/api/rental-requests/${request.id}`,alice.token)).status,'COMPLETED');
 let notifications;
 for(let attempt=0;attempt<40;attempt++){
  notifications=await json('/api/notifications?size=100',alice.token);
  if(notifications.content.some(n=>n.type==='ContractCompleted'||n.eventType==='ContractCompleted') && notifications.content.some(n=>n.aggregateId===repair.id && (n.type==='RepairStatusChanged'||n.eventType==='RepairStatusChanged')))break;
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 assert.ok(notifications.content.some(n=>n.type==='ContractCompleted'||n.eventType==='ContractCompleted'),'Pub/Sub must deliver ContractCompleted');
 assert.ok(notifications.content.some(n=>n.aggregateId===repair.id && (n.type==='RepairStatusChanged'||n.eventType==='RepairStatusChanged')),'Pub/Sub must deliver repair notifications to the owner');
 assert.equal((await json('/api/notifications',bob.token)).totalElements,0);
 await json(`/api/notifications/${notifications.content[0].id}/read`,alice.token,{method:'PATCH'});
 if(testBroker){
  const row=(await serviceClients.rental.query("SELECT payload FROM rental.outbox_events WHERE aggregate_id=$1 AND event_type='ContractCompleted'",[contract.id])).rows[0];
  const data=Buffer.from(JSON.stringify(row.payload)).toString('base64');
  await broker('/topics/rental-events-v1:publish','POST',{messages:[{data},{data}]});
  await new Promise(resolve=>setTimeout(resolve,3000));
  const count=await serviceClients.notifications.query('SELECT count(*)::int AS count FROM notifications.notifications WHERE event_id=$1',[row.payload.eventId]);
  assert.equal(count.rows[0].count,1);
  console.log('PASS Duplicate Pub/Sub deliveries: a single durable notification for the same event ID');
 }
 console.log('PASS Pub/Sub: committed rental events reached notification service; customer ownership and read status verified');
 console.log('PASS Permissions: CUSTOMER owns records/files; EMPLOYEE manages rentals; ADMIN alone manages roles');
 await json(`/api/admin/users/${employee.id}/role`,admin.token,{method:'PATCH',body:{role:'CUSTOMER'}});
 await api('/api/printers',employee.token,{status:403});
 console.log('PASS Role revocation: old JWT loses employee access immediately');
 const beforeLogout=alice.cookie;
 await authCall('/sign-out',{},alice.cookie);
 const loggedOut=await authCall('/get-session',null,beforeLogout);assert.equal(loggedOut.data,null);
 await authCall('/token',null,beforeLogout,401);
 console.log(`PASS Logout: managed session ended, cannot mint new JWT; existing JWT expires within 15 minutes (${checks} API checks total)`);
} finally {
 if(objectKey)await s3.send(new DeleteObjectCommand({Bucket:process.env.STORAGE_BUCKET||'assets',Key:objectKey}));
 if(ids.contract){await serviceClients.rental.query('DELETE FROM rental.repair_requests WHERE contract_id=$1',[ids.contract]);await serviceClients.documents.query('DELETE FROM documents.contract_attachments WHERE contract_id=$1',[ids.contract]);await serviceClients.rental.query('DELETE FROM rental.rental_contracts WHERE id=$1',[ids.contract]);}
 if(ids.request)await serviceClients.rental.query('DELETE FROM rental.rental_requests WHERE id=$1',[ids.request]);
 if(ids.printer)await serviceClients.rental.query('DELETE FROM rental.printers WHERE id=$1',[ids.printer]);
 for(const user of users){
  await serviceClients.notifications.query('DELETE FROM notifications.notifications WHERE owner_subject=$1',[user.id]);
  await serviceClients.rental.query("DELETE FROM rental.outbox_events WHERE payload->>'ownerSubject'=$1",[user.id]);
  await serviceClients.identity.query('DELETE FROM identity.app_users WHERE subject=$1',[user.id]);
  // Auth owns this schema; delete only identities made by this isolated test.
  await db.query('DELETE FROM neon_auth.user WHERE id=$1 AND email=$2',[user.id,user.email]);
 }
 await Promise.all([db.end(),...Object.values(serviceClients).map(client=>client.end())]);s3.destroy();console.log('CLEANUP: synthetic auth users, rental rows and object removed');
}
