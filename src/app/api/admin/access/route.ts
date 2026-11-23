// The owner's access switches (Control panel > Users): which accounts may use the portal's functions.
// GET -> [{ user_id, username, email, portal_access, portal_requested_at, created_at }]  (approved accounts, not the
//        owner's, not test sessions)
// POST { user_id, on } -> grants or takes away access

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await getDb().prepare(`
    SELECT user_id, username, username_email AS email, portal_access, portal_requested_at, created_at
    FROM users WHERE approval = 'approved' AND coalesce(role, 'user') <> 'admin' AND demo_expires_at IS NULL
      AND coalesce(username, '') <> 'demo_template'
    ORDER BY (portal_requested_at IS NOT NULL AND NOT portal_access) DESC, username`).all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { user_id, on } = await req.json().catch(() => ({}));
  const r = await getDb().prepare(`UPDATE users SET portal_access = ?, portal_requested_at = CASE WHEN ? THEN NULL ELSE portal_requested_at END
                                   WHERE user_id = ? AND coalesce(role, 'user') <> 'admin' AND demo_expires_at IS NULL RETURNING username`)
    .get(!!on, !!on, String(user_id ?? '')) as { username: string } | undefined;
  return r ? NextResponse.json({ ok: true, username: r.username, portal_access: !!on }) : NextResponse.json({ error: 'No such account.' }, { status: 404 });
}
