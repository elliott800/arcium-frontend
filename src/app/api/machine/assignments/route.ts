// A machine's desired state: the accounts it should run (with their broker
// credentials — only ever for that machine) and the ones it should remove.
// Pending accounts are placed here too, so a machine coming online picks up
// work without any scheduler. Auth: X-Machine-Name / X-Machine-Key headers.

import { type NextRequest, NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/public-origin';
import { getCredentialForMachine, getDb } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';
import { assignPendingAccounts } from '@/lib/accounts';

export async function GET(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  await assignPendingAccounts();
  const rows = await getDb().prepare(`
    SELECT a.id, a.owner_username, a.name, a.broker, a.broker_credential_id, a.seed_id, s.seed_name,
           a.data_connection, a.stack_rates, a.silo_name, a.status, a.paused, a.removed, a.updated_at
    FROM accounts a LEFT JOIN wh_seeds s ON s.id = a.seed_id
    WHERE a.machine_name = ? ORDER BY a.created_at
  `).all(machine) as Record<string, unknown>[];

  const origin = publicOrigin(req);
  const accounts = [];
  for (const r of rows) {
    const credentials = r.removed || !r.broker_credential_id
      ? null : await getCredentialForMachine(String(r.broker_credential_id), machine);
    const { broker_credential_id: _ignored, ...rest } = r;
    accounts.push({
      ...rest,
      credentials,
      seed_bundle_url: r.seed_id ? `${origin}/api/machine/seeds/${r.seed_id}` : null,
    });
  }
  return NextResponse.json({ machine_name: machine, accounts }, { headers: { 'Cache-Control': 'no-store' } });
}

// body: { account_id, status, detail? } — progress for one of this machine's accounts.
// status 'removed' on an account marked removed deletes it (and its credential).
const STATUSES = new Set(['provisioning', 'ready', 'error', 'removing', 'removed']);

export async function POST(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { account_id, status, detail } = await req.json().catch(() => ({}));
  if (!STATUSES.has(status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  const db = getDb();
  const acct = await db.prepare('SELECT id, removed, broker_credential_id FROM accounts WHERE id = ? AND machine_name = ?')
    .get(String(account_id ?? ''), machine) as { id: string; removed: boolean; broker_credential_id: string | null } | undefined;
  if (!acct) return NextResponse.json({ error: 'not your account' }, { status: 404 });

  if (status === 'removed' && acct.removed) {
    await db.prepare('DELETE FROM accounts WHERE id = ?').run(acct.id);
    if (acct.broker_credential_id) await db.prepare('DELETE FROM credentials WHERE id = ?').run(acct.broker_credential_id);
    return NextResponse.json({ ok: true, deleted: true });
  }
  await db.prepare('UPDATE accounts SET status = ?, status_detail = ?, updated_at = now() WHERE id = ?')
    .run(status, detail ? String(detail).slice(0, 2000) : null, acct.id);
  return NextResponse.json({ ok: true });
}
