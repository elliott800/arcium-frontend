// Server side of the schedules: which tasks are done, and a short status of Release 1 for the
// Dashboards menu (src/app/_public/AppSwitcher.tsx, public/arcium-nav.js).

import { getDb } from '@/lib/db';
import { SCHEDULE, allTasks } from '@/lib/schedule';

/** { task_id: 'YYYY-MM-DD' } for every done task. Tasks marked doneOn in the JSON count as done
 *  until someone unticks them; a schedule_ticks row with no date records such an untick. */
export async function loadTicks(): Promise<Record<string, string>> {
  const rows = await getDb().prepare(
    `SELECT task_id, to_char(done_on, 'YYYY-MM-DD') AS done_on FROM schedule_ticks`,
  ).all() as { task_id: string; done_on: string | null }[];
  const ticks: Record<string, string | null> = {};
  for (const t of allTasks()) if (t.doneOn) ticks[t.id] = t.doneOn;
  for (const r of rows) ticks[r.task_id] = r.done_on;
  for (const k of Object.keys(ticks)) if (!ticks[k]) delete ticks[k];
  return ticks as Record<string, string>;
}

export interface ScheduleStatus {
  name: string; version: string; done: number; total: number; overdue: number;
  phase: { number: number; title: string; dates: string } | null;
  next: { id: string; text: string; due: string; late: boolean }[];
}

/** Release 1 at a glance: progress, the current phase, and the next three dated open tasks. */
export async function scheduleStatus(today = new Date().toISOString().slice(0, 10)): Promise<ScheduleStatus> {
  const ticks = await loadTicks();
  const tasks = SCHEDULE.phases.flatMap(p => p.groups.flatMap(g => g.tasks));
  const open = tasks.filter(t => !ticks[t.id]);
  const i = SCHEDULE.phases.findIndex(p => p.groups.some(g => g.tasks.some(t => !ticks[t.id])));
  const dated = open.filter(t => t.due).sort((a, b) => a.due!.localeCompare(b.due!));
  return {
    name: SCHEDULE.name, version: SCHEDULE.version,
    done: tasks.length - open.length, total: tasks.length,
    overdue: dated.filter(t => t.due! < today).length,
    phase: i < 0 ? null : { number: i + 1, title: SCHEDULE.phases[i].title, dates: SCHEDULE.phases[i].dates },
    next: dated.slice(0, 3).map(t => ({ id: t.id, text: t.text, due: t.due!, late: t.due! < today })),
  };
}
