// POST (machine key) <launcher status> -> { ok }
// The live controller's launcher reports its status every minute (commit, paused, training runs, process count,
// the end of its log). The control panel's Live controller tab shows it and sends commands back.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';

export async function POST(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON status body required' }, { status: 400 });
  // Keep it small without breaking the JSON: shorten the logs until it fits.
  let status = JSON.stringify(body);
  for (const n of [12, 5, 0]) {
    if (status.length <= 60000) break;
    const logs = (body.train_logs ?? {}) as Record<string, string[]>;
    body.train_logs = Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : []]));
    body.launcher_log = Array.isArray(body.launcher_log) ? body.launcher_log.slice(-n) : [];
    status = JSON.stringify(body);
  }
  if (status.length > 60000) return NextResponse.json({ error: 'status too large' }, { status: 413 });
  await getDb().prepare('UPDATE machines SET live_status = ?::jsonb, live_status_at = now() WHERE machine_name = ?').run(status, machine);
  return NextResponse.json({ ok: true });
}
