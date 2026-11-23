// Signed in: the options to save a new passkey for this account on this device.

import { type NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { RP_ID, RP_NAME, passkeysOf, setChallenge, toCredential } from '@/lib/passkeys';

export async function POST(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const existing = await passkeysOf(account.user_id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: account.username,
    userDisplayName: account.username,
    userID: new TextEncoder().encode(account.user_id),
    attestationType: 'none',
    excludeCredentials: existing.map(r => { const c = toCredential(r); return { id: c.id, transports: c.transports }; }),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const res = NextResponse.json(options);
  setChallenge(res, options.challenge);
  return res;
}
