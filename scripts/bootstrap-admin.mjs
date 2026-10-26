import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {connectionUrl} from './lib/service-databases.mjs';
const file=['.env','.env.local'].find(existsSync);
if(file)for(const [k,v] of Object.entries(parseEnv(readFileSync(file,'utf8'))))process.env[k]??=v;
const subject=process.argv[2];
assert.ok(subject && subject.length<=255,'Usage: npm run auth:bootstrap -- <subject from GET /api/auth/me>');
const url=new URL(process.env.IDENTITY_DATABASE_URL_UNPOOLED||connectionUrl(process.env.DATABASE_URL_UNPOOLED,'psi_identity'));if(!['localhost','127.0.0.1'].includes(url.hostname))url.searchParams.set('sslmode','verify-full');
const db=new pg.Client({connectionString:url.toString()});
try{
 await db.connect();await db.query('BEGIN');
 await db.query('LOCK TABLE identity.app_users IN SHARE ROW EXCLUSIVE MODE');
 const admins=await db.query("SELECT 1 FROM identity.app_users WHERE role='ADMIN' LIMIT 1");
 assert.equal(admins.rowCount,0,'An administrator already exists; use the admin API to manage roles');
 const result=await db.query("UPDATE identity.app_users SET role='ADMIN' WHERE subject=$1 RETURNING subject",[subject]);
 assert.equal(result.rowCount,1,'User not found: sign in and call GET /api/auth/me first');
 await db.query('COMMIT');console.log('First administrator granted. The next API request will use ADMIN permissions.');
}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end();}
