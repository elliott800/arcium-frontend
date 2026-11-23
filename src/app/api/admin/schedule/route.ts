// Admin: the project schedule (Release 1: src/lib/schedule-release1.json) and which tasks are done.
// GET  -> { schedule, ticks: { [task_id]: 'YYYY-MM-DD' } }
//         Tasks marked doneOn in the JSON count as done until someone unticks them here.
// POST { id, done: true, done_on?: 'YYYY-MM-DD' }  tick (done_on defaults to today)
//      { id, done: false }                          untick

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { SCHEDULE, isTaskId } from '@/lib/schedule';
import { loadTicks } from '@/lib/schedule-status';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const ticks = await loadTicks();
  return NextResponse.json({ schedule: SCHEDULE, ticks });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await req.json().catch(() => ({}));
  const id = String(b.id ?? '');
  if (!isTaskId(id)) return NextResponse.json({ error: 'No such task.' }, { status: 404 });
  const doneOn = b.done === true ? String(b.done_on || new Date().toISOString().slice(0, 10)) : null;
  if (doneOn && !/^\d{4}-\d{2}-\d{2}$/.test(doneOn)) {
    return NextResponse.json({ error: 'done_on must be YYYY-MM-DD.' }, { status: 400 });
  }
  await getDb().prepare(`
    INSERT INTO schedule_ticks (task_id, done_on, ticked_by, updated_at) VALUES (?, ?, ?, now())
    ON CONFLICT (task_id) DO UPDATE SET done_on = EXCLUDED.done_on, ticked_by = EXCLUDED.ticked_by, updated_at = now()
  `).run(id, doneOn, admin.username);
  return NextResponse.json({ ok: true, id, done_on: doneOn });
}
