// body: { login_name?, phone? } -> the signed-in account's sign-in name and phone number. A blank value clears it.
// The username (the internal key) never changes here; see src/lib/profile.ts.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { LOGIN_NAME, ensureLoginName } from '@/lib/profile';
import { normalizePhone } from '@/lib/signup';

export async function POST(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  await ensureLoginName();
  const db = getDb();

  if ('login_name' in body) {
    const name = String(body.login_name ?? '').trim().toLowerCase();
    if (name && !LOGIN_NAME.test(name)) {
      return NextResponse.json({ error: 'Use 3 to 30 letters, numbers, dots, dashes or underscores, starting with a letter or number.' }, { status: 400 });
    }
    if (name && name !== account.username) {
      const taken = await db.prepare('SELECT 1 FROM users WHERE (username = ? OR login_name = ?) AND user_id <> ? LIMIT 1')
        .get(name, name, account.user_id);
      if (taken) return NextResponse.json({ error: 'That name is taken.' }, { status: 409 });
    }
    await db.prepare('UPDATE users SET login_name = ? WHERE user_id = ?').run(name && name !== account.username ? name : null, account.user_id);
  }

  if ('phone' in body) {
    const phone = normalizePhone(body.phone);
    if (phone === null) return NextResponse.json({ error: 'Enter the phone number with its country code, or leave it blank.' }, { status: 400 });
    if (phone) {
      const taken = await db.prepare('SELECT 1 FROM users WHERE phone = ? AND user_id <> ? LIMIT 1').get(phone, account.user_id);
      if (taken) return NextResponse.json({ error: 'That phone number is on another account.' }, { status: 409 });
    }
    await db.prepare('UPDATE users SET phone = ? WHERE user_id = ?').run(phone || null, account.user_id);
  }

  const row = await db.prepare('SELECT login_name, phone FROM users WHERE user_id = ?').get(account.user_id) as { login_name: string | null; phone: string | null };
  return NextResponse.json({ ok: true, display_name: row.login_name || account.username, login_name: row.login_name, phone: row.phone });
}
