// API (public): create an Arcium account. body: { username, email, password, phone? } -> { ok, emailed }
// Open when ARCIUM_SIGNUP_OPEN=true. The account is approved; it signs in once its email is confirmed (the link this
// sends) and lands on its user dashboard (/home), where its functions stay locked until the owner grants access
// (Control panel > Users). When the server cannot send email the account waits for the owner's approval instead,
// which also vouches for the address; under npm run sim (no email) the address counts as confirmed.

import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb, hashPassword, USERNAME_PATTERN } from '@/lib/db';
import { SIGNUP_OPEN } from '@/lib/site-mode';
import { mailConfigured } from '@/lib/mail';
import { ensureLoginName } from '@/lib/profile';
import { isSimUrl } from '@/lib/sim-db';
import {
  MIN_PASSWORD_LENGTH, clientIp, isEmail, issueToken, normalizeEmail, normalizePhone, rateLimit, sendVerifyEmail,
} from '@/lib/signup';

const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'demo', 'demo_template', 'arcium', 'arciumsignals',
  'api', 'portal', 'machine', 'hub', 'null', 'undefined']);

export async function POST(req: NextRequest) {
  if (!SIGNUP_OPEN) return NextResponse.json({ error: 'Sign-up is closed right now.' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? '').trim().toLowerCase();
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const phone = normalizePhone(body.phone);

  if (!USERNAME_PATTERN.test(username)) {
    return NextResponse.json({ error: 'Username: 3–32 characters, starting with a letter; lowercase letters, numbers and _ only.' }, { status: 400 });
  }
  if (RESERVED.has(username) || username.startsWith('tester_')) return NextResponse.json({ error: 'That username is reserved.' }, { status: 400 });
  if (!isEmail(email)) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  if (phone === null) return NextResponse.json({ error: 'Enter the phone number with its country code, or leave it blank.' }, { status: 400 });

  const db = getDb();
  await ensureLoginName();   // a new username may not be someone's sign-in name either
  const taken = await db.prepare(
    `SELECT (username = ? OR login_name = ?) AS by_name, (phone IS NOT NULL AND phone = ?) AS by_phone
     FROM users WHERE username = ? OR login_name = ? OR lower(username_email) = ? OR (phone IS NOT NULL AND phone = ?) LIMIT 1`,
  ).get(username, username, phone || null, username, username, email, phone || null) as { by_name: boolean; by_phone: boolean } | undefined;
  if (taken) {
    return NextResponse.json({ error: taken.by_name ? 'That username is taken.'
      : taken.by_phone ? 'That phone number already has an account. Sign in instead.'
        : 'That email already has an account. Sign in instead.' }, { status: 409 });
  }
  // Counted only for sign-ups that create an account: those are the ones that send email.
  if (!rateLimit(`signup:${clientIp(req)}`, 5, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many sign-ups from here. Try again in an hour.' }, { status: 429 });
  }

  const sim = isSimUrl(process.env.DATABASE_URL);
  const mail = mailConfigured();
  const userId = randomUUID();
  try {
    await db.prepare(`
      INSERT INTO users (user_id, username, username_email, phone, created_at, active, type_of_subscriber, role,
                         password_hash, approval, email_verified_at)
      VALUES (?, ?, ?, ?, ?, 1, 'free', 'user', ?, ?, ?)
    `).run(userId, username, email, phone || null, new Date().toISOString(), hashPassword(password),
      mail || sim ? 'approved' : 'pending', !mail && sim ? new Date().toISOString() : null);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'That username or email was just taken.' }, { status: 409 });
    }
    throw err;
  }

  if (!mail) return NextResponse.json({ ok: true, emailed: false, approval: sim ? 'approved' : 'pending' });
  try {
    await sendVerifyEmail(req, email, username, await issueToken(userId, 'verify_email'));
  } catch (err) {
    console.error('[signup] verification email failed:', err);
    await db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    return NextResponse.json({ error: 'Could not send the confirmation email. Please try again later.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, emailed: true });
}
