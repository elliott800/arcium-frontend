// Stored credentials for the control panel: names only, never the encrypted values.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await getDb().prepare(`
    SELECT c.id, c.owner_username AS owner, c.kind, c.label, c.machine_name, c.created_at, c.updated_at,
           (SELECT count(*)::int FROM accounts a WHERE a.broker_credential_id = c.id) AS used_by_accounts
    FROM credentials c ORDER BY c.kind, c.owner_username, c.label
  `).all();
  return NextResponse.json(rows);
}
