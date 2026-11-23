// Demo database setup for the demo deployment (ARCIUM_SITE_MODE=demo).
//
//   node scripts/demo-db.mjs create <demo database url> [--hub-schema <path to datahub repo hub_services/common/schema.sql>]
//
// Creates the demo database if it doesn't exist and applies the hub services
// tables (wh_*). The site's own tables are created by the site on first start,
// exactly as on the live database, so both share one schema definition.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const [cmd, url, ...rest] = process.argv.slice(2);
if (cmd !== 'create' || !url) {
  console.error('usage: node scripts/demo-db.mjs create <demo database url> [--hub-schema <schema.sql>]');
  process.exit(2);
}
const hubSchema = rest[rest.indexOf('--hub-schema') + 1] && rest.includes('--hub-schema')
  ? rest[rest.indexOf('--hub-schema') + 1] : null;

const target = new URL(url);
const dbName = decodeURIComponent(target.pathname.slice(1));
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`unsafe database name: ${dbName}`);
if (!/demo/.test(dbName)) throw new Error(`refusing: "${dbName}" doesn't look like a demo database (name must contain "demo")`);

const admin = new URL(url);
admin.pathname = '/postgres';
const a = new pg.Client({ connectionString: admin.toString() });
await a.connect();
const exists = (await a.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount > 0;
if (!exists) {
  await a.query(`CREATE DATABASE ${dbName}`);
  console.log(`created database ${dbName}`);
} else {
  console.log(`database ${dbName} already exists`);
}
await a.end();

if (hubSchema) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(readFileSync(hubSchema, 'utf8'));
  await c.end();
  console.log(`applied hub schema from ${hubSchema}`);
}
