// GET -> the signed-in Arcium account (for the account and sign-on pages), or 401.
// Only the live site holds Arcium accounts; the demo's sessions are throwaway.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { isSimUrl } from '@/lib/sim-db';
import { isDemo, DEMO_SITE_URL } from '@/lib/site-mode';
import { displayName } from '@/lib/profile';

export async function GET(req: NextRequest) {
  // The demo site signs no one in to the other sites; the simulated backend (npm run sim) does, so the Services Hub
  // and the Arcade can be tried locally.
  if (isDemo && !isSimUrl(process.env.DATABASE_URL)) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Not signed in.', code: 'NOT_SIGNED_IN' }, { status: 401 });
  return NextResponse.json({ username: account.username, display_name: await displayName(account.user_id, account.username),
    email: account.email, phone: account.phone,
    role: account.role, portal: account.portal, demo_url: DEMO_SITE_URL || null });
}
