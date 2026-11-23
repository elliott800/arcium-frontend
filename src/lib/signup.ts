// Sign-up, email verification, password reset and approval notices.
// Tokens are emailed once; only their sha256 is stored (like sessions).

import { type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { hashToken, newToken } from '@/lib/auth';
import { sendMail } from '@/lib/mail';
import { ensureLoginName } from '@/lib/profile';

export const MIN_PASSWORD_LENGTH = 10;
const VERIFY_HOURS = 48;
const RESET_HOURS = 1;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface LoginRow {
  user_id: string; username: string; username_email: string; role: string | null; active: number;
  password_hash: string | null; must_reset_password: boolean; approval: string; email_verified_at: unknown;
}

export const normalizeEmail = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const isEmail = (s: string) => EMAIL.test(s);

/** A phone number as +digits (7–15 digits), '' when blank, or null when it isn't a phone number.
 *  Ten digits without a country code are taken as US/Canada. */
export function normalizePhone(s: unknown): string | null {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+') && digits.length === 10) digits = '1' + digits;
  return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
}

/** A user by username, sign-in name (src/lib/profile.ts) or email (case-insensitive). */
export async function getUserByLogin(identifier: string): Promise<LoginRow | undefined> {
  const id = String(identifier ?? '').trim().toLowerCase();
  if (!id) return undefined;
  if (id.includes('@')) {
    return getDb().prepare('SELECT * FROM users WHERE lower(username_email) = ?').get(id) as Promise<LoginRow | undefined>;
  }
  await ensureLoginName();
  return getDb().prepare('SELECT * FROM users WHERE username = ? OR login_name = ? ORDER BY (username = ?) DESC LIMIT 1')
    .get(id, id, id) as Promise<LoginRow | undefined>;
}

/** The site's public base URL for links in emails (SITE_URL on the server). */
export function siteBase(req: NextRequest): string {
  return `${(process.env.SITE_URL ?? req.nextUrl.origin).replace(/\/$/, '')}`;
}

export async function issueToken(userId: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
  const token = newToken();
  const db = getDb();
  // Only the newest link of each kind works.
  await db.prepare(`UPDATE auth_tokens SET used_at = now() WHERE user_id = ? AND purpose = ? AND used_at IS NULL`)
    .run(userId, purpose);
  await db.prepare(`
    INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
    VALUES (?, ?, ?, now() + make_interval(hours => ?))
  `).run(hashToken(token), userId, purpose, purpose === 'verify_email' ? VERIFY_HOURS : RESET_HOURS);
  return token;
}

/** Claims a token atomically; returns its user_id, or undefined if invalid/used/expired. */
export async function consumeToken(token: string, purpose: 'verify_email' | 'reset_password'): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await getDb().prepare(`
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > now()
    RETURNING user_id
  `).get(hashToken(token), purpose) as { user_id: string } | undefined;
  return row?.user_id;
}

// ── emails ───────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function layout(title: string, body: string, link?: { href: string; label: string }) {
  const button = link
    ? `<p style="margin:24px 0"><a href="${esc(link.href)}" style="background:#0D9FD8;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;display:inline-block">${esc(link.label)}</a></p>
       <p style="color:#5d6573;font-size:13px">Or paste this link into your browser:<br>${esc(link.href)}</p>`
    : '';
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#15181d;max-width:520px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}${button}
    <p style="color:#5d6573;font-size:12px;margin-top:32px">Arcium Signals</p></div>`;
}

export async function sendVerifyEmail(req: NextRequest, to: string, username: string, token: string) {
  const href = `${siteBase(req)}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to, subject: 'Confirm your Arcium Signals email',
    text: `Hi ${username},\n\nConfirm your email to finish signing up:\n${href}\n\nThe link expires in ${VERIFY_HOURS} hours. After that, an administrator approves your account and you'll get an email when you can sign in.\n\nIf you didn't sign up, ignore this email.`,
    html: layout('Confirm your email', `<p>Hi ${esc(username)},</p><p>Confirm your email to finish signing up. After that, an administrator approves your account and you'll get an email when you can sign in.</p>`,
      { href, label: 'Confirm email' }),
  });
}

export async function sendResetEmail(req: NextRequest, to: string, username: string, token: string) {
  const href = `${siteBase(req)}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to, subject: 'Reset your Arcium Signals password',
    text: `Hi ${username},\n\nReset your password here:\n${href}\n\nThe link expires in ${RESET_HOURS} hour. If you didn't ask for this, ignore this email; your password stays the same.`,
    html: layout('Reset your password', `<p>Hi ${esc(username)},</p><p>Use the button below to choose a new password. The link expires in ${RESET_HOURS} hour. If you didn't ask for this, ignore this email.</p>`,
      { href, label: 'Reset password' }),
  });
}

export async function sendApprovedEmail(req: NextRequest, to: string, username: string) {
  const href = `${siteBase(req)}`;
  await sendMail({
    to, subject: 'Your Arcium Signals account is approved',
    text: `Hi ${username},\n\nYour account is approved. Sign in with your username or email:\n${href}`,
    html: layout('Your account is approved', `<p>Hi ${esc(username)},</p><p>You can now sign in with your username or email.</p>`,
      { href, label: 'Sign in' }),
  });
}

/** Tells the owner about a confirmed sign-up: waiting for approval, or (approved) able to sign in and ask for access. */
export async function notifyAdminsOfSignup(req: NextRequest, username: string, email: string, waiting = true) {
  const admins = await getDb().prepare(
    `SELECT username_email FROM users WHERE role = 'admin' AND active = 1`
  ).all() as { username_email: string }[];
  const href = `${siteBase(req)}/w/control.users`;
  const title = waiting ? `Sign-up waiting for approval: ${username}` : `New Arcium account: ${username}`;
  const what = waiting ? 'confirmed their email and is waiting for your approval.'
    : 'confirmed their email and can sign in. Their functions stay locked until you grant access.';
  for (const a of admins) {
    await sendMail({
      to: a.username_email, subject: title,
      text: `${username} <${email}> ${what}\n\nControl panel > Users: ${href}`,
      html: layout(waiting ? 'Sign-up waiting for approval' : 'New Arcium account',
        `<p><strong>${esc(username)}</strong> &lt;${esc(email)}&gt; ${what}</p>`, { href, label: 'Open Control panel > Users' }),
    });
  }
}

// ── rate limiting (per process; enough to stop one client spamming email) ──

const hits = new Map<string, number[]>();

/** True if `key` has made fewer than `max` calls in the last `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
  return true;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
}
