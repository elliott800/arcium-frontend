// Load-balanced placement of accounts on optimization machines. A machine is
// eligible when it is registered (has a key), accepts accounts, and has sent
// a heartbeat recently; load = active accounts / capacity.

import { getDb } from '@/lib/db';

const ONLINE_SECONDS = 120;

export function siloNameFor(accountName: string): string {
  return `acct_${accountName}`;
}

/** The least-loaded eligible machine with spare capacity, or null. */
export async function pickMachine(): Promise<string | null> {
  const row = await getDb().prepare(`
    SELECT m.machine_name
    FROM machines m
    LEFT JOIN accounts a ON a.machine_name = m.machine_name AND NOT a.removed
    WHERE m.api_key_hash IS NOT NULL AND m.accepts_accounts AND m.capacity > 0
      AND m.last_heartbeat IS NOT NULL
      AND m.last_heartbeat::timestamptz > now() - make_interval(secs => ?)
    GROUP BY m.machine_name, m.capacity
    HAVING count(a.id) < m.capacity
    ORDER BY count(a.id)::float / m.capacity, count(a.id), m.machine_name
    LIMIT 1
  `).get(ONLINE_SECONDS) as { machine_name: string } | undefined;
  return row?.machine_name ?? null;
}

/** Assign one account (and bind its broker credential to the machine). */
export async function assignAccount(accountId: string, machineName: string): Promise<void> {
  const db = getDb();
  await db.prepare(`
    UPDATE accounts SET machine_name = ?, status = 'assigned', status_detail = NULL, updated_at = now()
    WHERE id = ?
  `).run(machineName, accountId);
  await db.prepare(`
    UPDATE credentials SET machine_name = ?, updated_at = now()
    WHERE id = (SELECT broker_credential_id FROM accounts WHERE id = ?)
  `).run(machineName, accountId);
}

/** Place every pending account that has an eligible machine. Returns how many were placed. */
export async function assignPendingAccounts(): Promise<number> {
  const pending = await getDb().prepare(
    `SELECT id FROM accounts WHERE machine_name IS NULL AND NOT removed ORDER BY created_at`
  ).all() as { id: string }[];
  let placed = 0;
  for (const a of pending) {
    const m = await pickMachine();
    if (!m) break;
    await assignAccount(a.id, m);
    placed++;
  }
  return placed;
}
