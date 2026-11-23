// body: { login, password } — login is a username or an email.
// An account's status is only reported after the right password, so this
// can't be used to find out who has an account.

import { type NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/db';
import { createSession, mayUseSite, setSessionCookie } from '@/lib/auth';
import { isDemo, DEMO_SITE_URL } from '@/lib/site-mode';
import { clientIp, getUserByLogin, rateLimit } from '@/lib/signup';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const login = String(body.login ?? body.email ?? '').trim().toLowerCase();
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
  if (!user.email_verified_at) {
    return NextResponse.json({ error: 'Confirm your email first — check your inbox for the link.', code: 'EMAIL_UNVERIFIED' },
      { status: 403 });
  }
  if (user.approval === 'pending') {
    return NextResponse.json({ error: 'Your account is waiting for approval. You\'ll get an email when it\'s ready.',
      code: 'PENDING_APPROVAL' }, { status: 403 });
  }
  if (user.approval !== 'approved') {
    return NextResponse.json({ error: 'This account was not approved.', code: 'NOT_APPROVED' }, { status: 403 });
  }
  // Live site: only the owner reaches the portal. Everyone else still signs in
  // here (their Arcium account, used by the other Arcium sites through single
  // sign-on) and lands on the account page; the portal API refuses their session.
  const portal = mayUseSite(user);

  const token = await createSession(user.user_id, req.headers.get('user-agent'));
  const res = NextResponse.json({
    ok: true,
    username: user.username,
    email: user.username_email,
    role: user.role ?? 'user',
    demo: isDemo,
    must_reset_password: !!user.must_reset_password,
    portal,
    demo_url: DEMO_SITE_URL || null,
  });
  setSessionCookie(res, token);
  return res;
}
