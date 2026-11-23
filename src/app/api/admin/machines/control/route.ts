// POST { machine_name, action, silo? } -> { ok, command_id }
// Manage a machine's live controller from the site. The machine's heartbeat picks the command up on its next poll
// and runs controller/scripts/live_control.py, which calls the launcher on the machine:
//   train / untrain (silo)   start or stop a silo's training run (with all its workers)
//   pause / resume           suspend or continue training (the heartbeat keeps running, so resume can arrive)
//   restart                  restart the heartbeat (training keeps running)
//   update                   the safe update from GitHub (drain, back up, fast-forward, check, restart)
//   status                   report the launcher's status now (it also reports every minute)
//   engine_start (silo, kind, max_cycles?, sim_balance?)   run the silo's sim or live engine (live: OANDA practice only)
//   engine_stop (silo, kind, force?)                       stop it cleanly; force is the kill switch

import { type NextRequest, NextResponse } from 'next/server';
import { queuePendingScript } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

const ACTIONS = new Set(['train', 'untrain', 'pause', 'resume', 'restart', 'update', 'status', 'engine_start', 'engine_stop']);

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({}));
  const machine = String(body.machine_name ?? '').trim();
  const action = String(body.action ?? '').trim();
  const silo = String(body.silo ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(machine)) return NextResponse.json({ error: 'machine_name required' }, { status: 400 });
  if (!ACTIONS.has(action)) return NextResponse.json({ error: `action must be one of ${[...ACTIONS].join(', ')}` }, { status: 400 });
  if ((action === 'train' || action.startsWith('engine_')) && !silo) return NextResponse.json({ error: `${action} needs a silo` }, { status: 400 });
  const flags: Record<string, string | number | boolean> = { action, ...(silo ? { silo } : {}) };
  if (action.startsWith('engine_')) {
    const kind = String(body.kind ?? 'sim');
    if (kind !== 'sim' && kind !== 'live') return NextResponse.json({ error: 'kind must be sim or live' }, { status: 400 });
    flags.kind = kind;
    const cycles = Number(body.max_cycles), balance = Number(body.sim_balance);
    if (action === 'engine_start' && Number.isInteger(cycles) && cycles > 0 && cycles <= 1_000_000) flags.max_cycles = cycles;
    if (action === 'engine_start' && kind === 'sim' && Number.isFinite(balance) && balance > 0) flags.sim_balance = balance;
    if (action === 'engine_stop' && body.force === true) flags.force = true;
  }
  if (silo && !/^[A-Za-z0-9 _.-]{1,64}$/.test(silo)) return NextResponse.json({ error: 'bad silo name' }, { status: 400 });
  const row = await queuePendingScript({
    machine_name: machine, username: admin.username, script_path: 'controller/scripts/live_control.py',
    flags, priority: 10,
  }) as unknown as { id?: number } | undefined;
  return NextResponse.json({ ok: true, command_id: row?.id ?? null, machine_name: machine, action, silo: silo || null });
}
