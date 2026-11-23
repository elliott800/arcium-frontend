// The options for signing in with a saved passkey. No username: the device offers the keys it holds for this site.

import { type NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { clientIp, rateLimit } from '@/lib/signup';
import { RP_ID, setChallenge } from '@/lib/passkeys';

export async function POST(req: NextRequest) {
  if (!rateLimit(`passkey:${clientIp(req)}`, 30, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, { status: 429 });
  }
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
  const res = NextResponse.json(options);
  setChallenge(res, options.challenge);
  return res;
}
