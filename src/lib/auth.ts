// Server-side sessions. The cookie holds a random token; the DB stores only
// its sha256, so a database leak doesn't hand out live sessions. Every route
// gets the user from here — never from a client-sent username.

import { type NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';
import { getDb, stripEmail } from '@/lib/db';
import { isDemo } from '@/lib/site-mode';

export const SESSION_COOKIE = 'arcium_session';
const SESSION_DAYS = 7;

export interface SessionUser {
  user_id: string;
  email: string;
  username: string;          // users.username — the key every user-scoped table uses
  role: 'admin' | 'user';
  must_reset_password: boolean;
  demo_expires_at: string | null;   // set for demo test sessions: when the account is deleted
}

/** Whether an account may hold a session on this deployment: verified and
 *  approved, and on the live site only admins (the owner) — everyone else
 *  uses the demo site. */
export function mayUseSite(u: { role: string | null; approval: string | null; email_verified_at: unknown }): boolean {
  if (u.approval !== 'approved' || !u.email_verified_at) return false;
  return isDemo || u.role === 'admin';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: string, userAgent?: string | null): Promise<string> {
  const token = newToken();
  await getDb().prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
    VALUES (?, ?, now() + make_interval(days => ?), ?)
  `).run(hashToken(token), userId, SESSION_DAYS, userAgent ?? null);
  await getDb().prepare('UPDATE users SET last_login = ? WHERE user_id = ?').run(new Date().toISOString(), userId);
  return token;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export async function destroyUserSessions(userId: string, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, hashToken(exceptToken));
  } else {
    await getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

interface SessionRow {
  user_id: string; username_email: string; username: string; role: string; must_reset_password: boolean;
  approval: string; email_verified_at: unknown; demo_expires_at: Date | string | null; phone: string | null;
}

async function sessionRow(token: string | undefined): Promise<SessionRow | undefined> {
  if (!token) return undefined;
  return getDb().prepare(`
    UPDATE sessions s SET last_seen_at = now()
    FROM users u
    WHERE s.token_hash = ? AND s.expires_at > now() AND u.user_id = s.user_id AND u.active = 1
      AND (u.demo_expires_at IS NULL OR u.demo_expires_at > now())
    RETURNING u.user_id, u.username_email, u.username, u.role, u.must_reset_password,
              u.approval, u.email_verified_at, u.demo_expires_at, u.phone
  `).get(hashToken(token)) as Promise<SessionRow | undefined>;
}

/** The signed-in user of the portal and its API (see mayUseSite). */
export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  const row = await sessionRow(token);
  if (!row || !mayUseSite(row)) return null;
  return {
    user_id: row.user_id,
    email: row.username_email,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    must_reset_password: !!row.must_reset_password,
    demo_expires_at: row.demo_expires_at ? new Date(row.demo_expires_at).toISOString() : null,
  };
}

export interface AccountUser {
  user_id: string; username: string; email: string; phone: string | null; role: 'admin' | 'user'; portal: boolean;
}

/** The signed-in Arcium account, whether or not it may use the portal: a
 *  confirmed, approved account that isn't a demo test session. This is what
 *  the account page and single sign-on use; the portal API never does. */
export async function accountFromToken(token: string | undefined): Promise<AccountUser | null> {
  const row = await sessionRow(token);
  if (!row || row.demo_expires_at || row.approval !== 'approved' || !row.email_verified_at) return null;
  return {
    user_id: row.user_id, username: row.username, email: row.username_email, phone: row.phone ?? null,
    role: row.role === 'admin' ? 'admin' : 'user', portal: mayUseSite(row),
  };
}

export function sessionToken(req: NextRequest): string | undefined {
  return req.cookies.get(SESSION_COOKIE)?.value;
}

export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  return userFromToken(sessionToken(req));
}

/** Returns the user, or a 401 response to return as-is. */
export async function requireUser(req: NextRequest): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  return user;
}

/** Returns the admin user, or a 401/403 response to return as-is. */
export async function requireAdmin(req: NextRequest): Promise<SessionUser | NextResponse> {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only.' }, { status: 403 });
  return user;
}

/** The username a read should be scoped to: an admin may name another user
 *  explicitly; everyone else always gets their own. */
export function scopedUsername(user: SessionUser, requested?: string | null): string {
  if (user.role === 'admin' && requested) return requested;
  return user.username;
}

/** Flags for a machine command: machine scripts act on `username`, so a
 *  non-admin can only ever target their own workspace. */
export function userFlags(user: SessionUser, flags: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = { ...(flags ?? {}) };
  if (user.role !== 'admin' || !out.username) out.username = user.username;
  return out;
}

/** True when `name` (an email or stripped username) refers to this user. */
export function isSelf(user: SessionUser, name: string | null | undefined): boolean {
  if (!name) return false;
  return name === user.email || name === user.username || stripEmail(name) === user.username;
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
