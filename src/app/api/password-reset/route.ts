// API (public): ask for a password reset link, and set a new password with it.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb, hashPassword } from '@/lib/db';
import { destroyUserSessions } from '@/lib/auth';
import {
  MIN_PASSWORD_LENGTH, clientIp, consumeToken, getUserByLogin, issueToken, rateLimit, sendResetEmail,
} from '@/lib/signup';

// body: { login }            -> emails a reset link if the account exists (the
//                               reply is the same either way, so it can't be
//                               used to find out who has an account)
// body: { token, password }  -> sets the new password and signs out everywhere
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  if (body.token) {
    const password = String(body.password ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
    }
    const userId = await consumeToken(String(body.token), 'reset_password');
    if (!userId) return NextResponse.json({ error: 'This link is invalid, already used, or expired.' }, { status: 404 });
    await getDb().prepare('UPDATE users SET password_hash = ?, must_reset_password = false WHERE user_id = ?')
      .run(hashPassword(password), userId);
    await destroyUserSessions(userId);
    return NextResponse.json({ ok: true });
  }

  const login = String(body.login ?? '').trim().toLowerCase();
  if (!login) return NextResponse.json({ error: 'Enter your username or email.' }, { status: 400 });
  if (!rateLimit(`reset:${clientIp(req)}`, 5, 60 * 60_000) || !rateLimit(`reset:${login}`, 3, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }
  const user = await getUserByLogin(login);
  if (user?.active && user.email_verified_at) {
    try {
      await sendResetEmail(req, user.username_email, user.username, await issueToken(user.user_id, 'reset_password'));
    } catch (err) {
      console.error('[password-reset] email failed:', err);
      return NextResponse.json({ error: 'Could not send the email. Please try again later.' }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true });
}
