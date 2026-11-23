// POST { machine_name, wait_minutes?, force? } -> { ok, command_id }
// Update a machine's live controller from GitHub, like a server deploy: the machine's heartbeat picks
// the command up on its next poll and runs controller/scripts/self_update.py, which drains running
// engines (waits up to wait_minutes, default 30), backs up, fast-forwards, checks and restarts, and rolls
// back on failure. Progress: the machine's live_logs/update.log, and the command's status.

import { type NextRequest, NextResponse } from 'next/server';
import { queuePendingScript } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({}));
  const name = String(body.machine_name ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return NextResponse.json({ error: 'machine_name required' }, { status: 400 });
  const wait = Math.max(0, Math.min(240, Number(body.wait_minutes ?? 30) || 0));
  const row = await queuePendingScript({
    machine_name: name, username: admin.username, script_path: 'controller/scripts/self_update.py',
    flags: { wait: wait, ...(body.force ? { force: true } : {}) }, priority: 10,
  }) as unknown as { id?: number } | undefined;
  return NextResponse.json({ ok: true, command_id: row?.id ?? null, machine_name: name, wait_minutes: wait });
}
