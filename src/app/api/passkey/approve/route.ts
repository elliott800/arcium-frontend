// Admins: GET the keys waiting for admin approval; POST { id, approved } approves or withdraws one.
// The admin dashboard's Approvals tab (Release 1, r1.5.2) is built on this.

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ensurePasskeyTable, publicKeyInfo, type PasskeyRow } from '@/lib/passkeys';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  await ensurePasskeyTable();
  const rows = await getDb().prepare(`SELECT p.*, u.username FROM passkeys p JOIN users u ON u.user_id = p.user_id
    WHERE u.role = 'admin' AND NOT p.admin_approved ORDER BY p.created_at`).all() as (PasskeyRow & { username: string })[];
  return NextResponse.json({ waiting: rows.map(r => ({ ...publicKeyInfo(r), username: r.username })) });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id, approved } = await req.json().catch(() => ({}));
  await ensurePasskeyTable();
  const r = await getDb().prepare('UPDATE passkeys SET admin_approved = ? WHERE id = ?').run(!!approved, String(id ?? ''));
  return NextResponse.json({ ok: r.changes > 0 });
}
