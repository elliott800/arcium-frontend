// body: { response, name } -> the key is saved to this account. Saved while signed in as an admin, it is approved
// for admin use at once; otherwise it waits for approval should the account ever hold the admin role.

import { type NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { RP_ID, RP_ORIGIN, ensurePasskeyTable, takeChallenge } from '@/lib/passkeys';

export async function POST(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const res = NextResponse.json({ ok: true });
  const challenge = takeChallenge(req, res);
  if (!challenge) return NextResponse.json({ error: 'That took too long. Try again.' }, { status: 400 });
  let info;
  try {
    const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge,
      expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID, requireUserVerification: false });
    if (!v.verified) throw new Error('not verified');
    info = v.registrationInfo;
  } catch {
    return NextResponse.json({ error: 'The key could not be checked. Try again.' }, { status: 400 });
  }
  const name = String(body.name ?? '').trim().slice(0, 60) || 'Passkey';
  await ensurePasskeyTable();
  await getDb().prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, rp_id, name, admin_approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).run(
    info.credential.id, account.user_id, Buffer.from(info.credential.publicKey).toString('base64url'),
    info.credential.counter, info.credential.transports ? JSON.stringify(info.credential.transports) : null,
    RP_ID, name, account.role === 'admin');
  return NextResponse.json({ ok: true, approved: account.role === 'admin' }, { headers: res.headers });
}
