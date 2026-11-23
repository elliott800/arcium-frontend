// POST { login, password } -> { token, username }: signs the seed workbench (arcium-signals) in with an
// Arcium account. Any approved account with a confirmed email may read the Data Hub's bars.
// DELETE with the bearer token signs it out.

import { type NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/db';
import { createSession, destroySession } from '@/lib/auth';
import { clientIp, getUserByLogin, rateLimit } from '@/lib/signup';
import { bearerToken } from '@/lib/workbench';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const login = String(body.login ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!login || !password) return NextResponse.json({ error: 'Username or email, and password, required.' }, { status: 400 });
  if (!rateLimit(`login:${clientIp(req)}`, 20, 15 * 60_000) || !rateLimit(`login:${login}`, 10, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, { status: 429 });
  }
  const user = await getUserByLogin(login);
  if (!user || !user.active || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 });
  }
  if (!user.email_verified_at || user.approval !== 'approved') {
    return NextResponse.json({ error: 'This account is not approved for the Data Hub yet.' }, { status: 403 });
  }
  const token = await createSession(user.user_id, 'arcium-signals workbench');
  return NextResponse.json({ token, username: user.username });
}

export async function DELETE(req: NextRequest) {
  await destroySession(bearerToken(req));
  return NextResponse.json({ ok: true });
}
