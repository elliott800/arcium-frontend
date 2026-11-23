// API: sign out (ends the session; a demo session also deletes its throwaway account).

import { type NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, destroySession, getSessionUser, sessionToken } from '@/lib/auth';
import { purgeDemoUsers } from '@/lib/demo';

export async function POST(req: NextRequest) {
  // Ending a demo test session deletes its throwaway account straight away.
  const user = await getSessionUser(req);
  await destroySession(sessionToken(req));
  if (user?.demo_expires_at) await purgeDemoUsers([user.username]);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
