// Hub services (source_manager, seed_warehouse, tick_recorder) report health
// in wh_process_state and take commands from wh_process_control.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

const STALE_SECONDS = 120;
const ALLOWED_COMMANDS = new Set(['pause', 'resume', 'reload']);

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await getDb().prepare(`
    SELECT machine_name, process_name, pid, started_at, last_tick_at, status, paused,
           tick_count, summary, last_error,
           EXTRACT(EPOCH FROM (now() - last_tick_at))::int AS seconds_since_tick
    FROM wh_process_state ORDER BY process_name
  `).all() as { status: string; seconds_since_tick: number | null }[];
  return NextResponse.json(rows.map(r => ({
    ...r,
    health: (r.status === 'running' || r.status === 'paused') && (r.seconds_since_tick ?? 1e9) > STALE_SECONDS
      ? 'stale' : r.status,
  })));
}

// body: { machine_name, process_name, command: 'pause' | 'resume' | 'reload' }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { machine_name, process_name, command } = await req.json().catch(() => ({}));
  if (!machine_name || !process_name || !ALLOWED_COMMANDS.has(command)) {
    return NextResponse.json({ error: 'machine_name, process_name and command (pause|resume|reload) required' }, { status: 400 });
  }
  const row = await getDb().prepare(`
    INSERT INTO wh_process_control (machine_name, process_name, command, requested_by)
    VALUES (?, ?, ?, ?) RETURNING id
  `).get(machine_name, process_name, command, admin.email) as { id: number };
  return NextResponse.json({ ok: true, control_id: row.id });
}
