// A signed-in account without the portal's functions asks the owner for access (the user dashboard, /home).
// POST -> { ok, requested_at }

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  if (account.portal) return NextResponse.json({ error: 'This account already has access.' }, { status: 400 });
  const r = await getDb().prepare(`UPDATE users SET portal_requested_at = COALESCE(portal_requested_at, now()) WHERE user_id = ?
                                   RETURNING portal_requested_at`).get(account.user_id) as { portal_requested_at: string };
  return NextResponse.json({ ok: true, requested_at: new Date(r.portal_requested_at).toISOString() });
}
