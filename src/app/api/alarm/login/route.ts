// body: { login, password, device? } -> { token, username } : signs the ArciumAlarm phone app
// in with an Arcium account. Same checks as /api/login; the token goes in the app's
// encrypted storage and is sent as "Authorization: Bearer <token>".

import { type NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/db';
import { isDemo } from '@/lib/site-mode';
import { clientIp, getUserByLogin, rateLimit } from '@/lib/signup';
import { createDevice, mayUseAlarm } from '@/lib/alarm';

export async function POST(req: NextRequest) {
  if (isDemo) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const login = String(body.login ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!login || !password) {
    return NextResponse.json({ error: 'Username or email, and password, required.' }, { status: 400 });
  }
  if (!rateLimit(`login:${clientIp(req)}`, 20, 15 * 60_000) || !rateLimit(`login:${login}`, 10, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, { status: 429 });
  }

  const user = await getUserByLogin(login);
  if (!user || !user.active || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 });
  }
  const demoExpires = (user as { demo_expires_at?: unknown }).demo_expires_at ?? null;
  if (!mayUseAlarm({ ...user, demo_expires_at: demoExpires })) {
    return NextResponse.json({ error: 'This account can\'t use ArciumAlarm\'s Claude commands.', code: 'NOT_ALLOWED' }, { status: 403 });
  }

  const token = await createDevice(user.user_id, String(body.device ?? '') || req.headers.get('user-agent'));
  return NextResponse.json({ token, username: user.username });
}
