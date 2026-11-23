// The owner's project schedule: Release 1 (schedule-release1.json: private, a sample here), the one the site shows and ticks.
//   Schedule 0, Schedule 1 and the per-project agent schedules were taken down (Nov 16); a copy is in
//   archiving/backup/arciumsignals_schedules_archive_2026-11-15.zip. Each phase ends in a milestone (milestone, date): the page shows those key events with the tasks folded.
// A change to Release 1 is a revision recorded in `revisions`. scripts/schedule_pdf.py prints it as a fillable PDF.
// Which tasks are done lives in the schedule_ticks table. A task id never changes once used, so a tick stays on its
// task: add new tasks with new ids rather than renumbering (Release 1 ids start with "r1."; tasks carried over from
// Schedule 1 keep their "s1." ids).

import fs from 'node:fs';
import sample from './schedule-release1.json';
import { privatePath } from '@/lib/private-content';

export interface ScheduleTask { id: string; text: string; due?: string; doneOn?: string; requested?: string; note?: string }
export interface ScheduleGroup { title: string; tasks: ScheduleTask[] }
export interface SchedulePhase {
  id: string; title: string; weeks: string; dates: string; goal: string; gate: string; groups: ScheduleGroup[];
  milestone?: string;   // the key event this phase ends in, shown as the phase's row
  date?: string;        // the milestone's target date (YYYY-MM-DD)
}
export interface Revision { version: string; date: string; change: string }
export interface Schedule {
  id: string; name: string; version: string; scope: string; revisions: Revision[];
  title: string; start: string; release: string; phases: SchedulePhase[]; later: ScheduleTask[];
}

// The real Release 1 is private (ARCIUM_PRIVATE_DIR, src/lib/private-content.ts); this repository holds a sample.
function load(): Schedule {
  const file = privatePath('schedule-release1.json', '');
  if (file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Schedule; }
    catch (e) { console.error(`[schedule] ${file} is not readable JSON, using the sample:`, e); }
  }
  return sample as Schedule;
}

export const SCHEDULE = load();

export function allTasks(): ScheduleTask[] {
  return [...SCHEDULE.phases.flatMap(p => p.groups.flatMap(g => g.tasks)), ...SCHEDULE.later];
}

export function isTaskId(id: string): boolean {
  return allTasks().some(t => t.id === id);
}
