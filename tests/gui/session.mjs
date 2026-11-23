// Test sessions for the GUI suite.
//   local: a throwaway owner session row in the local database (.env.local DATABASE_URL);
//          the owner's must_reset_password flag is lifted for the run and restored after.
//   remote: sign in through /api/login with GUI_LOGIN / GUI_PASSWORD.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const require = createRequire(process.cwd() + '/package.json');

export async function openSession(base) {
  if (process.env.GUI_LOGIN && process.env.GUI_PASSWORD) {
    const r = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: process.env.GUI_LOGIN, password: process.env.GUI_PASSWORD }),
    });
    const cookie = (r.headers.get('set-cookie') || '').match(/arcium_session=([^;]+)/);
    if (!r.ok || !cookie) throw new Error(`sign-in failed: ${r.status}`);
    return { token: cookie[1], close: async () => { await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: `arcium_session=${cookie[1]}` } }); } };
  }
  if (!existsSync('.env.local')) throw new Error('no .env.local: set GUI_LOGIN / GUI_PASSWORD for a remote site');
  const { Client } = require('pg');
  const url = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(l => l.startsWith('DATABASE_URL='))
    .slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
  const db = new Client({ connectionString: url });
  await db.connect();
  const owner = (await db.query(
    "SELECT user_id, must_reset_password FROM users WHERE role = 'admin' AND approval = 'approved' ORDER BY created_at LIMIT 1")).rows[0];
  if (!owner) throw new Error('no approved admin in the local database');
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query('UPDATE users SET must_reset_password = false WHERE user_id = $1', [owner.user_id]);
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
    [hash, owner.user_id]);
  return {
    token,
    close: async () => {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
      await db.query('UPDATE users SET must_reset_password = $2 WHERE user_id = $1', [owner.user_id, owner.must_reset_password]);
      await db.end();
    },
  };
}
