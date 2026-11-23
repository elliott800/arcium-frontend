// API (public): confirm an email address, or send a fresh confirmation link.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb, verifyPassword } from '@/lib/db';
import {
  clientIp, consumeToken, getUserByLogin, issueToken, notifyAdminsOfSignup, rateLimit, sendVerifyEmail,
} from '@/lib/signup';

// body: { token } -> confirms the email; the account then waits for approval.
// body: { login, password, resend: true } -> sends a fresh confirmation link.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  if (body.resend) {
    if (!rateLimit(`verify-resend:${clientIp(req)}`, 5, 60 * 60_000)) {
      return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
    }
    const user = await getUserByLogin(body.login);
    if (!user?.password_hash || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 });
    }
    if (user.email_verified_at) return NextResponse.json({ ok: true, already: true });
    await sendVerifyEmail(req, user.username_email, user.username, await issueToken(user.user_id, 'verify_email'));
    return NextResponse.json({ ok: true });
  }

  const userId = await consumeToken(String(body.token ?? ''), 'verify_email');
  if (!userId) return NextResponse.json({ error: 'This link is invalid, already used, or expired.' }, { status: 404 });
  const user = await getDb().prepare(`
    UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
    WHERE user_id = ? RETURNING username, username_email, approval
  `).get(userId) as { username: string; username_email: string; approval: string } | undefined;
  if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

  try { await notifyAdminsOfSignup(req, user.username, user.username_email, user.approval === 'pending'); }
  catch (err) { console.error('[verify-email] admin notification failed:', err); }
  return NextResponse.json({ ok: true, approval: user.approval });
}
