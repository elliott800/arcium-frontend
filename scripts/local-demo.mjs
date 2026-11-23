// A local demo database for development: simulated silos, models, engines and curves, no production access.
//
//   npm run demo:create     create the database named in .env.local (its name must contain "demo")
//   npm run dev             start the site once: it creates its tables on the first request (open the page)
//   npm run demo:seed       fill it with simulated systems (scripts/demo-seed.mjs)
//
// .env.local for this (see .env.example):  DATABASE_URL=postgresql://<user>:<password>@localhost:5432/arcium_demo
//                                          ARCIUM_SITE_MODE=demo   ARCIUM_SECRET_KEY=<any 32+ characters>
// Then "Start a test session" on the sign-in page opens the workspace on the simulated machine.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cmd = process.argv[2];
let env = '';
try { env = readFileSync('.env.local', 'utf8'); } catch { console.error('no .env.local: copy .env.example and fill it in'); process.exit(2); }
const url = (env.match(/^DATABASE_URL=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('.env.local has no DATABASE_URL'); process.exit(2); }
const name = decodeURIComponent(new URL(url).pathname.slice(1));
if (!/demo/i.test(name)) { console.error(`refusing: the database "${name}" is not a demo database (its name must contain "demo")`); process.exit(2); }
if (!/^ARCIUM_SITE_MODE=demo\s*$/m.test(env)) console.warn('note: set ARCIUM_SITE_MODE=demo in .env.local for test sessions');

const script = { create: ['scripts/demo-db.mjs', 'create', url], seed: ['scripts/demo-seed.mjs', url] }[cmd];
if (!script) { console.error('usage: node scripts/local-demo.mjs create | seed'); process.exit(2); }
const r = spawnSync(process.execPath, script, { stdio: 'inherit' });
process.exit(r.status ?? 1);
