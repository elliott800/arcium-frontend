// API (admin): list invitations and create one (Control panel > Users).

import { type NextRequest, NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/public-origin';
import { getDb, getUserByEmail } from '@/lib/db';
import { hashToken, newToken, requireAdmin } from '@/lib/auth';

const INVITE_DAYS = 7;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await getDb().prepare(`
    SELECT email, role, created_by, created_at, expires_at, used_at,
           (used_at IS NULL AND expires_at > now()) AS open
    FROM invites ORDER BY created_at DESC LIMIT 200
  `).all();
  return NextResponse.json(rows);
}

// body: { email, role? } -> { invite_url } (the token is shown once)
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { email, role } = await req.json().catch(() => ({}));
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }
  if (await getUserByEmail(normalized)) {
    return NextResponse.json({ error: 'That email already has an account.' }, { status: 409 });
  }
  const token = newToken();
  await getDb().prepare(`
    INSERT INTO invites (token_hash, email, role, created_by, expires_at)
    VALUES (?, ?, ?, ?, now() + make_interval(days => ?))
  `).run(hashToken(token), normalized, role === 'admin' ? 'admin' : 'user', admin.email, INVITE_DAYS);

  const inviteUrl = `${publicOrigin(req)}/invite?token=${encodeURIComponent(token)}`;
  return NextResponse.json({ ok: true, email: normalized, expires_in_days: INVITE_DAYS, invite_url: inviteUrl });
}
