// The simulated backend: an in-process Postgres (PGlite) standing in for the real database, so the site runs
// with no database server, no Data Hub and no controllers. Used when DATABASE_URL is `sim:<folder>` (or
// `sim:memory`); `npm run sim` sets that up. The real site never uses it.
//
// What it holds, made on the first start and kept in the folder until `npm run sim -- --reset`:
//   sim/warehouse.sql      the Data Hub warehouse (wh_* tables): real table definitions and a small sample
//                          of real recordings with perturbed values (made by the private release tooling)
//   scripts/demo-seed.mjs  the simulated controller side: a machine, silos, models, systems, equity curves,
//                          portfolios and watchlists for the demo template user
// The site's own tables are created by db.ts as usual, between those two steps.
//
// It answers the calls db.ts makes on a node-postgres Pool: query(text, values), connect() -> client.query /
// client.release, with node-postgres's result shape and value types (bigint as text). PGlite is one connection,
// so a checked-out client holds it until release(); pool queries wait their turn.

import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const isSimUrl = (url: string | undefined): boolean => !!url && url.startsWith('sim:');

interface PgResult { rows: Record<string, unknown>[]; rowCount: number; fields: { name: string }[] }
export interface SimClient { query(text: string, values?: unknown[]): Promise<PgResult>; release(): void }
export interface SimPool {
  query(text: string, values?: unknown[]): Promise<PgResult>;
  connect(): Promise<SimClient>;
  on(): SimPool;
  end(): Promise<void>;
}

const PARSERS = { 20: (x: string) => x };     // int8 as text, like node-postgres

function shape(r: Results): PgResult {
  const rows = r.rows as Record<string, unknown>[];
  return { rows, rowCount: r.affectedRows || rows.length, fields: r.fields.map(f => ({ name: f.name })) };
}

async function run(db: PGlite, text: string, values?: unknown[]): Promise<PgResult> {
  if (values && values.length) return shape(await db.query(text, values, { parsers: PARSERS }));
  const all = await db.exec(text, { parsers: PARSERS });     // no parameters: may be several statements
  return all.length ? shape(all[all.length - 1]) : { rows: [], rowCount: 0, fields: [] };
}

function dataDir(url: string): string | undefined {
  const where = url.slice('sim:'.length).trim();
  return !where || where === 'memory' ? undefined : path.resolve(where);
}

async function open(url: string): Promise<PGlite> {
  const dir = dataDir(url);
  const fresh = !dir || !fs.existsSync(path.join(dir, 'PG_VERSION'));
  if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });   // PGlite makes only the last folder
  let db: PGlite;
  try {
    db = await PGlite.create(dir, { extensions: { pgcrypto } });   // db.ts uses gen_random_bytes etc.
  } catch (e) {
    throw new Error(`[sim] cannot open the simulated database in ${dir ?? 'memory'} (${(e as Error).message}). If the `
      + 'repository is in a synced folder (Google Drive, OneDrive, Dropbox), set ARCIUM_SIM_DIR in .env.local to a folder '
      + 'outside it; otherwise run npm run sim -- --reset.');
  }
  if (fresh) {
    const sql = fs.readFileSync(path.join(process.cwd(), 'sim', 'warehouse.sql'), 'utf8');
    await db.exec(sql);
    console.log('[sim] new simulated database: Data Hub warehouse loaded from sim/warehouse.sql');
  }
  return db;
}

// One instance per process: dev-mode module reloads must not open the same folder twice.
const g = globalThis as unknown as { __arciumSim?: { url: string; pool: SimPool } };

export function createSimPool(url: string): SimPool {
  if (g.__arciumSim?.url === url) return g.__arciumSim.pool;
  const ready = open(url);
  ready.catch(() => { if (g.__arciumSim?.url === url) delete g.__arciumSim; });   // the next request tries again
  let tail: Promise<void> = Promise.resolve();
  const lock = (): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const prev = tail;
    tail = prev.then(() => held);
    return prev.then(() => release);
  };
  const pool: SimPool = {
    async query(text, values) {
      const db = await ready;
      const unlock = await lock();
      try { return await run(db, text, values); } finally { unlock(); }
    },
    async connect() {
      const db = await ready;
      const unlock = await lock();
      let done = false;
      return {
        query: (text, values) => run(db, text, values),
        release: () => { if (!done) { done = true; unlock(); } },
      };
    },
    on() { return pool; },
    async end() { await (await ready).close(); },
  };
  g.__arciumSim = { url, pool };
  return pool;
}

// The simulated controller's machine credentials: `npm run mock:machine` signs its hook calls with these. They open
// only the simulated database (the key's hash is written there and nowhere else), so they are not secrets.
export const SIM_MACHINE = 'demo_machine';
export const SIM_MACHINE_KEY = 'sim-machine-key';

/** After db.ts has made its own tables: the simulated controller side, once per database. */
export async function seedSimulatedSystems(pool: SimPool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS sim_meta (key text PRIMARY KEY, value text NOT NULL)`);
  const done = await pool.query(`SELECT value FROM sim_meta WHERE key = $1`, ['systems_seeded']);
  if (!done.rows.length) {
    const { seedDemo } = await import('../../scripts/demo-seed.mjs');
    const client = await pool.connect();
    try {
      await seedDemo(client, { label: 'the simulated database', systems: 48 });   // about 100 entries per table at most
      await client.query(`INSERT INTO sim_meta (key, value) VALUES ($1, $2)`, ['systems_seeded', new Date().toISOString()]);
    } finally {
      client.release();
    }
    // An ordinary account without the portal's functions (alice / sim-user-password): it signs in to the user
    // dashboard (/home) and can ask for access, which the owner grants in Control panel > Users.
    const { hashPassword } = await import('./db');
    await pool.query(`INSERT INTO users (user_id, username, username_email, password_hash, role, approval, email_verified_at, active)
                      VALUES ('sim-user-alice', 'alice', 'alice@example.com', $1, 'user', 'approved', now(), 1)
                      ON CONFLICT DO NOTHING`, [hashPassword('sim-user-password')]);
    // The simulated owner sees the same simulated systems a test session gets.
    const owner = await pool.query(`SELECT username FROM users WHERE username_email = $1`, [process.env.ARCIUM_ADMIN_EMAIL ?? '']);
    const name = owner.rows[0]?.username;
    if (name) {
      const { copyTemplate } = await import('./demo');
      await copyTemplate(String(name), pool as unknown as Pool);
    }
  }
  // The simulated Data Hub source manager answers the commands the Data Hub page queues (src/lib/sim-hub.ts).
  const { startSimHub } = await import('./sim-hub');
  startSimHub(pool);
  // Every start (older .sim-db folders were made before the mock machine): register the simulated machine's key.
  const hash = createHash('sha256').update(SIM_MACHINE_KEY).digest('hex');
  await pool.query(`UPDATE machines SET api_key_hash = $1, api_key = NULL WHERE machine_name = $2`, [hash, SIM_MACHINE]);
}
