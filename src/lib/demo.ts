// Demo test sessions (demo site only). "Start a test session" creates a
// throwaway user, copies the simulated workspace that scripts/demo-seed.mjs
// wrote for `demo_template` into it, and signs the visitor in. Each visitor
// gets their own copy, so changes never leak between sessions. When the
// session expires or the visitor signs out, the user and every row it owns
// are deleted; nothing a visitor does outlives their session.

import { randomBytes, randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { getDb, getPool, ensureReady } from '@/lib/db';

export const DEMO_TEMPLATE_USER = 'demo_template';
export const DEMO_MACHINE = 'demo_machine';
export const DEMO_SESSION_HOURS = 2;
const MAX_LIVE_SESSIONS = 200;

/** Tables with a per-user column, found from the schema so new tables are covered automatically. */
// Both take the pool so the simulated database (src/lib/sim-db.ts) can use them while it is being set up.
async function userScopedTables(pool: Pool = getPool()): Promise<{ table: string; column: string }[]> {
  return (await pool.query(`
    SELECT table_name AS "table", column_name AS "column"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('username', 'owner_username')
      AND table_name NOT IN ('users', 'sessions')
    ORDER BY table_name
  `)).rows as { table: string; column: string }[];
}

/** Copy every template row to `username`, in one transaction. */
export async function copyTemplate(username: string, pool: Pool = getPool()): Promise<void> {
  const tables = (await userScopedTables(pool)).filter(t => t.column === 'username');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { table } of tables) {
      const cols = (await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND is_identity = 'NO' AND is_generated = 'NEVER'
          AND COALESCE(column_default, '') NOT LIKE 'nextval(%'
        ORDER BY ordinal_position`, [table])).rows.map(r => `"${r.column_name}"`);
      // The template's own name also appears as the person/trader of its
      // silos (and inside trader settings); the copy takes the new name there too.
      const select = cols.map(c =>
        c === '"username"' ? '$1'
        : c === '"person_name"' || c === '"trader_name"' ? `CASE WHEN ${c} = $2 THEN $1 ELSE ${c} END`
        : c === '"trader_settings"' ? `replace(${c}, '"' || $2 || '"', '"' || $1 || '"')`
        : c).join(', ');
      await client.query(
        `INSERT INTO "${table}" (${cols.join(', ')}) SELECT ${select} FROM "${table}" WHERE username = $2`,
        [username, DEMO_TEMPLATE_USER]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Delete demo users (and everything they own): the given ones, or all expired ones. */
export async function purgeDemoUsers(usernames?: string[]): Promise<number> {
  const db = getDb();
  const names = usernames ?? (await db.prepare(
    `SELECT username FROM users WHERE demo_expires_at IS NOT NULL AND demo_expires_at <= now()`,
  ).all() as { username: string }[]).map(r => r.username);
  const targets = names.filter(n => n && n !== DEMO_TEMPLATE_USER);
  if (!targets.length) return 0;
  for (const { table, column } of await userScopedTables()) {
    await db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ANY(?)`).run(targets);
  }
  // Only ever demo accounts: real users have no demo_expires_at.
  await db.prepare(`DELETE FROM users WHERE username = ANY(?) AND demo_expires_at IS NOT NULL`).run(targets);
  return targets.length;
}

export class DemoUnavailable extends Error {}

/** Create a throwaway user with its own copy of the demo workspace. */
export async function createDemoUser(): Promise<{ user_id: string; username: string; expires_at: string }> {
  await ensureReady();
  await purgeDemoUsers();
  const db = getDb();
  const template = await db.prepare(`SELECT 1 FROM silo_registry WHERE username = ? LIMIT 1`).get(DEMO_TEMPLATE_USER);
  if (!template) throw new DemoUnavailable('The demo data has not been loaded yet.');
  const live = await db.prepare(
    `SELECT count(*)::int AS n FROM users WHERE demo_expires_at > now()`).get() as { n: number };
  if (live.n >= MAX_LIVE_SESSIONS) throw new DemoUnavailable('The demo is busy right now. Try again in a few minutes.');

  const username = `tester_${randomBytes(4).toString('hex')}`;
  const userId = randomUUID();
  const row = await db.prepare(`
    INSERT INTO users (user_id, username_email, username, role, approval, email_verified_at, type_of_subscriber, demo_expires_at)
    VALUES (?, ?, ?, 'user', 'approved', now(), 'demo', now() + make_interval(hours => ?))
    RETURNING demo_expires_at
  `).get(userId, `${username}@demo.invalid`, username, DEMO_SESSION_HOURS) as { demo_expires_at: Date | string };
  try {
    await copyTemplate(username);
  } catch (err) {
    await purgeDemoUsers([username]);
    throw err;
  }
  return { user_id: userId, username, expires_at: new Date(row.demo_expires_at).toISOString() };
}

/** The simulated machine always reports in, so the portal shows it online.
 *  The portal polls often; one write every few seconds is plenty. */
let lastTouch = 0;
export async function touchDemoMachine(): Promise<void> {
  if (Date.now() - lastTouch < 5000) return;
  lastTouch = Date.now();
  await getDb().prepare(`UPDATE machines SET last_heartbeat = ? WHERE machine_name = ?`)
    .run(new Date().toISOString(), DEMO_MACHINE);
}
