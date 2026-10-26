import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import pg from 'pg';

export const services = Object.freeze(['identity','rental','documents','notifications','metering','billing']);
export const identifier = value => '"' + value.replaceAll('"','""') + '"';
export const databaseName = service => {
  assert.ok(services.includes(service), 'Unknown service');
  return 'psi_' + service;
};
export function connectionUrl(base, database, credentials) {
  const url = new URL(base);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
  if (database) url.pathname = '/' + database;
  if (credentials) { url.username = credentials.role; url.password = credentials.password; }
  return url.toString();
}
export function requireDirect(url) {
  assert.ok(!new URL(url).hostname.includes('-pooler'), 'Use a direct connection for provisioning and migration');
}
export async function connected(url) {
  const client = new pg.Client({connectionString:url, connectionTimeoutMillis:30000});
  try { await client.connect(); return client; } catch (error) { await client.end().catch(()=>{}); throw error; }
}
export function saveCredentials(path, state) {
  writeFileSync(path, JSON.stringify(state,null,2), {mode:0o600});
}

// Never rotate existing passwords or replace an existing database.
export async function provisionDatabases({adminUrl, pooledUrl=adminUrl, state, save=()=>{}, createSchema=true}) {
  requireDirect(adminUrl);
  const admin = await connected(adminUrl);
  try {
    const owner = (await admin.query('SELECT current_user name')).rows[0].name;
    for (const service of services) {
      const role = databaseName(service), name = databaseName(service);
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount > 0;
      assert.ok(!exists || state[service]?.password, 'Existing role requires original credentials: ' + role);
      if (state[service]) assert.equal(state[service].role,role,'Unexpected service role');
      state[service] ??= {role,password:randomBytes(32).toString('base64url')};
      save(state); // Persist before CREATE ROLE so interruption cannot lose a password.
      if (!exists) await admin.query(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${state[service].password.replaceAll("'","''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      const attributes = (await admin.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[role])).rows[0];
      assert.ok(!attributes.rolsuper && !attributes.rolcreatedb && !attributes.rolcreaterole,'Excessive service privileges');
      await admin.query(`GRANT ${identifier(role)} TO ${identifier(owner)}`);
      const database = (await admin.query('SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=$1',[name])).rows[0];
      if (database) assert.equal(database.owner,role,'Unexpected database owner');
      else await admin.query(`CREATE DATABASE ${identifier(name)} OWNER ${identifier(role)} TEMPLATE template0`);
      await admin.query(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
      for (const other of services.filter(value=>value!==service)) {
        if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[databaseName(other)])).rowCount)
          assert.equal((await admin.query("SELECT has_database_privilege($1,$2,'CONNECT') allowed",[databaseName(other),name])).rows[0].allowed,false,'Unexpected cross-service CONNECT grant');
      }
      const target = await connected(connectionUrl(adminUrl,name));
      try {
        await target.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        if (createSchema) {
          await target.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(service)} AUTHORIZATION ${identifier(role)}`);
          assert.equal((await target.query('SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1',[service])).rows[0].owner,role,'Unexpected schema owner');
          await target.query(`REVOKE ALL ON SCHEMA ${identifier(service)} FROM PUBLIC`);
        }
      } finally { await target.end(); }
      state[service] = {...state[service],database:name,DATABASE_URL:connectionUrl(pooledUrl,name,state[service]),DATABASE_URL_UNPOOLED:connectionUrl(adminUrl,name,state[service])};
      save(state);
    }
  } finally { await admin.end(); }
  return state;
}

// Compare full row contents, table definitions, indexes and sequence positions.
export async function fingerprint(client, schema) {
  const tables = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows;
  const result = {};
  for (const {tablename} of tables) {
    const rows = (await client.query(`SELECT md5(row_to_json(t)::text) hash FROM ${identifier(schema)}.${identifier(tablename)} t ORDER BY hash`)).rows;
    const columns = (await client.query('SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',[schema,tablename])).rows;
    // PostgreSQL may rewrite equivalent predicate casts when restoring an index
    // created by an older server version. Compare its catalog structure here;
    // pg_restore executes the exact source predicate from the native dump.
    const indexes = (await client.query(`SELECT ic.relname name,am.amname method,i.indisunique,i.indisprimary,i.indisexclusion,i.indisvalid,i.indnkeyatts,i.indnatts,i.indkey::text keys,i.indclass::oid[]::text opclasses,(i.indpred IS NOT NULL) partial FROM pg_index i JOIN pg_class tc ON tc.oid=i.indrelid JOIN pg_namespace n ON n.oid=tc.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam WHERE n.nspname=$1 AND tc.relname=$2 ORDER BY ic.relname`,[schema,tablename])).rows;
    result[tablename] = {rows:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),columns,indexes};
  }
  const sequences = {};
  for (const {sequencename} of (await client.query('SELECT sequencename FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',[schema])).rows)
    sequences[sequencename] = (await client.query(`SELECT last_value::text,is_called FROM ${identifier(schema)}.${identifier(sequencename)}`)).rows[0];
  return {tables:result,sequences};
}
export async function verifyIsolation(state) {
  let checks = 0;
  for (const service of services) {
    const own = await connected(state[service].DATABASE_URL_UNPOOLED);
    try {
      assert.equal((await own.query('SELECT current_database() name')).rows[0].name,databaseName(service)); checks++;
      for (const other of services.filter(value=>value!==service)) {
        const wrong = new pg.Client({connectionString:connectionUrl(state[service].DATABASE_URL_UNPOOLED,databaseName(other)),connectionTimeoutMillis:10000});
        try { await assert.rejects(wrong.connect(), error=>error.code==='42501','Other service DB must deny CONNECT'); checks++; }
        finally { await wrong.end().catch(()=>{}); }
      }
    } finally { await own.end(); }
  }
  return checks;
}
