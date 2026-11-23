// Passkeys: a key saved in the person's password manager or device (Windows Hello, iPhone, Chrome, 1Password) that
// signs them in under their own username with one click. Keys belong to the app host (APP_ORIGIN), the one Arcium
// sign-in every hub sends people to.
//
// Admin access: a key opens an admin account only once it is approved. A key saved while signed in as an admin is
// approved at once (the owner adding their own device); any other key of an admin account waits for an admin to
// approve it (POST /api/passkey/approve, later the admin dashboard's Approvals tab).

import { type NextRequest, type NextResponse } from 'next/server';
import type { AuthenticatorTransportFuture, WebAuthnCredential } from '@simplewebauthn/server';
import { getDb } from '@/lib/db';
import { APP_ORIGIN } from '@/lib/hosts';

export const RP_NAME = 'Arcium Signals';
export const RP_ORIGIN = APP_ORIGIN;
export const RP_ID = new URL(APP_ORIGIN).hostname;

const CHALLENGE_COOKIE = 'arcium_pk_challenge';

export interface PasskeyRow {
  id: string; user_id: string; public_key: string; counter: string | number; transports: string | null;
  rp_id: string; name: string; admin_approved: boolean; created_at: string; last_used_at: string | null;
}

let ready: Promise<void> | null = null;
/** The passkeys table, made on first use (additive; nothing else changes). */
export function ensurePasskeyTable(): Promise<void> {
  ready ??= (async () => {
    await getDb().prepare(`CREATE TABLE IF NOT EXISTS passkeys (
        id             text PRIMARY KEY,
        user_id        text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        public_key     text NOT NULL,
        counter        bigint NOT NULL DEFAULT 0,
        transports     text,
        rp_id          text NOT NULL,
        name           text NOT NULL,
        admin_approved boolean NOT NULL DEFAULT false,
        created_at     timestamptz NOT NULL DEFAULT now(),
        last_used_at   timestamptz
      )`).run();
    await getDb().prepare('CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id)').run();
  })().catch(e => { ready = null; throw e; });
  return ready;
}

export function toCredential(row: PasskeyRow): WebAuthnCredential {
  return {
    id: row.id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
    counter: Number(row.counter),
    transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[]) : undefined,
  };
}

export async function passkeysOf(userId: string): Promise<PasskeyRow[]> {
  await ensurePasskeyTable();
  return getDb().prepare('SELECT * FROM passkeys WHERE user_id = ? AND rp_id = ? ORDER BY created_at')
    .all(userId, RP_ID) as Promise<PasskeyRow[]>;
}

export async function passkeyById(id: string): Promise<PasskeyRow | undefined> {
  await ensurePasskeyTable();
  return getDb().prepare('SELECT * FROM passkeys WHERE id = ? AND rp_id = ?').get(id, RP_ID) as Promise<PasskeyRow | undefined>;
}

/** What the browser may see of a key. */
export function publicKeyInfo(row: PasskeyRow) {
  return { id: row.id, name: row.name, admin_approved: !!row.admin_approved, created_at: row.created_at, last_used_at: row.last_used_at };
}

// The challenge of a ceremony in progress rides in a short-lived, HttpOnly cookie scoped to the passkey API.
export function setChallenge(res: NextResponse, challenge: string): void {
  res.cookies.set(CHALLENGE_COOKIE, challenge, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api/passkey', maxAge: 300,
  });
}

export function takeChallenge(req: NextRequest, res: NextResponse): string | undefined {
  res.cookies.set(CHALLENGE_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/api/passkey', maxAge: 0 });
  return req.cookies.get(CHALLENGE_COOKIE)?.value;
}
