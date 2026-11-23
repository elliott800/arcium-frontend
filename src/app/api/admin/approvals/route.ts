// GET -> sign-ups not yet decided (confirmed emails first)

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { sendApprovedEmail } from '@/lib/signup';
import { mailConfigured } from '@/lib/mail';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await getDb().prepare(`
    SELECT user_id, username, username_email AS email, created_at, email_verified_at, approval
    FROM users WHERE approval = 'pending'
    ORDER BY (email_verified_at IS NULL), created_at
  `).all();
  return NextResponse.json(rows);
}

// body: { user_id, action: 'approve' | 'reject' }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { user_id, action } = await req.json().catch(() => ({}));
  if (!user_id || !['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'user_id and action (approve | reject) required.' }, { status: 400 });
  }
  // Until the site can send email, approving an account also vouches for its
  // email address (there was no way to send the confirmation link).
  const vouch = action === 'approve' && !mailConfigured();
  const user = await getDb().prepare(`
    UPDATE users SET approval = ?, approved_by = ?, approved_at = now(),
           email_verified_at = CASE WHEN ? THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END
    WHERE user_id = ? AND approval = 'pending'
    RETURNING username, username_email, email_verified_at
  `).get(action === 'approve' ? 'approved' : 'rejected', admin.username, vouch, user_id) as
    { username: string; username_email: string; email_verified_at: unknown } | undefined;
  if (!user) return NextResponse.json({ error: 'No pending sign-up with that id.' }, { status: 404 });

  let emailed = false;
  if (action === 'approve' && user.email_verified_at) {
    try { await sendApprovedEmail(req, user.username_email, user.username); emailed = true; }
    catch (err) { console.error('[approvals] approval email failed:', err); }
  }
  return NextResponse.json({ ok: true, emailed });
}
