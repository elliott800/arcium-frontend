// The account's sign-in name: a second name a person signs in with and is shown as (e.g. "elliott800"), while
// users.username stays the internal key every user-scoped table, machine and hub list is linked by. Renaming that
// key would mean relinking every table, so the sign-in name sits beside it instead.

import { getDb } from '@/lib/db';

export const LOGIN_NAME = /^[a-z0-9][a-z0-9_.-]{2,29}$/;

let ready: Promise<void> | null = null;
/** users.login_name, added on first use (additive). */
export function ensureLoginName(): Promise<void> {
  ready ??= (async () => {
    await getDb().prepare('ALTER TABLE users ADD COLUMN IF NOT EXISTS login_name text').run();
    await getDb().prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_login_name_idx ON users (login_name) WHERE login_name IS NOT NULL').run();
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/** The name to show for an account: its sign-in name, else its username. */
export async function displayName(userId: string, username: string): Promise<string> {
  await ensureLoginName();
  const row = await getDb().prepare('SELECT login_name FROM users WHERE user_id = ?').get(userId) as { login_name: string | null } | undefined;
  return row?.login_name || username;
}
