// body: { response } -> signed in as the key's owner, with the same answer as /api/login.

import { type NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createSession, mayUseSite, setSessionCookie } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { isDemo } from '@/lib/site-mode';
import { RP_ID, RP_ORIGIN, passkeyById, takeChallenge, toCredential } from '@/lib/passkeys';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const scratch = NextResponse.json({});
  const challenge = takeChallenge(req, scratch);
  const fail = (error: string, status = 401, code?: string) =>
    NextResponse.json({ error, code }, { status, headers: scratch.headers });
  if (!challenge) return fail('That took too long. Try again.', 400);

  const row = body?.response?.id ? await passkeyById(String(body.response.id)) : undefined;
  if (!row) return fail('This device has no Arcium key for this site. Sign in with your password, then save a key from your account page.');
  let newCounter: number;
  try {
    const v = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: challenge,
      expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID, credential: toCredential(row), requireUserVerification: false });
    if (!v.verified) throw new Error('not verified');
    newCounter = v.authenticationInfo.newCounter;
  } catch {
    return fail('The key could not be checked. Try again.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a users row, read loosely as everywhere in src/lib/db.ts
  const user = await getDb().prepare('SELECT * FROM users WHERE user_id = ?').get(row.user_id) as Record<string, any> | undefined;
  if (!user || !user.active) return fail('This account is not active.', 403);
  if (!user.email_verified_at) return fail('Confirm your email first — check your inbox for the link.', 403, 'EMAIL_UNVERIFIED');
  if (user.approval !== 'approved') return fail('Your account is waiting for approval.', 403, 'PENDING_APPROVAL');
  if (user.role === 'admin' && !row.admin_approved) {
    return fail('This key is waiting for an admin to approve it. Sign in with your password meanwhile.', 403, 'KEY_PENDING');
  }
  await getDb().prepare('UPDATE passkeys SET counter = ?, last_used_at = now() WHERE id = ?').run(newCounter, row.id);

  const token = await createSession(user.user_id, req.headers.get('user-agent'));
  const res = NextResponse.json({
    ok: true, username: user.username, email: user.username_email, role: user.role ?? 'user', demo: isDemo,
    must_reset_password: !!user.must_reset_password, portal: mayUseSite(user as never),
  }, { headers: scratch.headers });
  setSessionCookie(res, token);
  return res;
}
