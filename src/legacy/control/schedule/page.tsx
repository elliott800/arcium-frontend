'use client';

// The owner's project schedule (Release 1): phases, groups and tasks from src/lib/schedule-release1.json, with
// ticks saved on the server (/api/admin/schedule). Prints as a form; the PDF is the fillable copy.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Schedule, ScheduleTask } from '@/lib/schedule';
import './schedule.css';

type Filter = 'all' | 'open' | 'overdue' | 'done';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'overdue', label: 'Overdue' }, { id: 'done', label: 'Done' },
];

const today = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD in local time
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso?: string) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : 'TBD');
const daysUntil = (iso: string) => Math.round((Date.parse(iso + 'T12:00:00') - Date.parse(today() + 'T12:00:00')) / 86400000);

export default function SchedulePage() {
  const [me, setMe] = useState<{ username: string; role: string } | null>(null);
  const [denied, setDenied] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [ticks, setTicks] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/me').then(r => (r.ok ? r.json() : null)).then(u => {
      if (!u) { window.location.href = '/?next=%2Fw%2Fcontrol.schedule'; return; }
      if (u.role !== 'admin') { setDenied(true); return; }
      setMe(u);
    }).catch(() => { window.location.href = '/'; });
    try { const f = localStorage.getItem('schedule_filter') as Filter | null; if (f && FILTERS.some(x => x.id === f)) setFilter(f); } catch {}
  }, []);

  useEffect(() => {
    if (!me) return;
    fetch('/api/admin/schedule').then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => { setSchedule(d.schedule); setTicks(d.ticks); })
      .catch(() => setError('Could not load the schedule.'));
  }, [me]);

  const pickFilter = (f: Filter) => { setFilter(f); try { localStorage.setItem('schedule_filter', f); } catch {} };

  const save = useCallback((id: string, doneOn: string | null) => {
    const before = ticks[id];
    setTicks(t => { const n = { ...t }; if (doneOn) n[id] = doneOn; else delete n[id]; return n; });
    setError('');
    fetch('/api/admin/schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, done: !!doneOn, done_on: doneOn }),
    }).then(r => { if (!r.ok) throw new Error(); }).catch(() => {
      setTicks(t => { const n = { ...t }; if (before) n[id] = before; else delete n[id]; return n; });
      setError('That change was not saved. Try again.');
    });
  }, [ticks]);

  const stats = useMemo(() => {
    if (!schedule) return null;
    const now = today();
    const phases = schedule.phases.map(p => {
      const tasks = p.groups.flatMap(g => g.tasks);
      const done = tasks.filter(t => ticks[t.id]).length;
      return { id: p.id, total: tasks.length, done, overdue: tasks.filter(t => !ticks[t.id] && t.due && t.due < now).length };
    });
    const total = phases.reduce((n, p) => n + p.total, 0);
    const done = phases.reduce((n, p) => n + p.done, 0);
    const overdue = phases.reduce((n, p) => n + p.overdue, 0);
    const open = schedule.phases.flatMap(p => p.groups.flatMap(g => g.tasks)).filter(t => !ticks[t.id] && t.due)
      .sort((a, b) => a.due!.localeCompare(b.due!));
    const current = schedule.phases.find(p => p.groups.some(g => g.tasks.some(t => !ticks[t.id]))) ?? null;
    return { phases, total, done, overdue, next: open.slice(0, 5), current };
  }, [schedule, ticks]);

  if (denied) return <div className="c-loading">The schedule is for the Arcium owner.</div>;
  if (!me || !schedule || !stats) return <div className="c-loading">{error || 'Loading…'}</div>;

  const now = today();
  const shows = (t: ScheduleTask) => {
    const done = !!ticks[t.id];
    if (filter === 'open') return !done;
    if (filter === 'done') return done;
    if (filter === 'overdue') return !done && !!t.due && t.due < now;
    return true;
  };
  const toRelease = daysUntil(schedule.release);

  const row = (t: ScheduleTask) => {
    const done = ticks[t.id];
    const late = !done && t.due && t.due < now;
    return (
      <li key={t.id} className={`s-task${done ? ' done' : ''}${late ? ' late' : ''}`}>
        <label className="s-check">
          <input type="checkbox" checked={!!done} onChange={e => save(t.id, e.target.checked ? now : null)} />
          <span className="s-text">{t.text}
            {(t.requested || t.note) && <em className="s-note">{[t.requested && `Requested ${short(t.requested)}`, t.note].filter(Boolean).join(' · ')}</em>}
          </span>
        </label>
        <span className="s-due" title={t.due ? `Expected ${t.due}` : 'Not dated yet'}>{short(t.due)}{late ? ' · late' : ''}</span>
        <span className="s-done">
          {/* Picking a date marks the task done on that date; clearing it marks the task open. */}
          <input type="date" value={done ?? ''} max={now} aria-label={`Completed on: ${t.text}`}
            onChange={e => save(t.id, e.target.value || null)} />
        </span>
      </li>
    );
  };

  return (
    <div className="c-wrap s-wrap">

      <main className="c-main s-main">
        <div className="s-head">
          <div>
            <h1 className="c-h1">{schedule.title} <span className="s-rev" title={schedule.revisions.map(r => `${r.version} (${r.date}): ${r.change}`).join('\n')}>rev {schedule.version}</span></h1>
            <p className="c-hint">{short(schedule.start)}, {schedule.start.slice(0, 4)} – {short(schedule.release)}, {schedule.release.slice(0, 4)}. A phase is done when it passes its gate. Tick a task or pick its completion date; changes save as you make them.</p>
            <p className="c-hint s-scope"><strong>Scope:</strong> {schedule.scope}</p>
          </div>
          <div className="s-actions s-noprint">
            <a className="s-btn primary" href="/control/schedule/pdf">Download PDF</a>
            <button type="button" className="s-btn" onClick={() => window.print()}>Print</button>
          </div>
        </div>

        <div className="c-cards">
          <div className="c-card s-card">
            <span className="c-card-label">Done</span>
            <span className="c-card-value">{Math.round((100 * stats.done) / stats.total)}%</span>
            <span className="c-card-note">{stats.done} of {stats.total} tasks</span>
          </div>
          <div className="c-card s-card">
            <span className="c-card-label">Current phase</span>
            <span className="c-card-value s-small">{stats.current ? stats.current.title : 'All done'}</span>
            <span className="c-card-note">{stats.current ? `${stats.current.weeks} · ${stats.current.dates}` : ''}</span>
          </div>
          <div className="c-card s-card">
            <span className="c-card-label">Overdue</span>
            <span className="c-card-value">{stats.overdue}</span>
            <span className={`c-card-note${stats.overdue ? ' bad' : ''}`}>{stats.overdue ? 'past their expected date' : 'nothing late'}</span>
          </div>
          <div className="c-card s-card">
            <span className="c-card-label">Release</span>
            <span className="c-card-value s-small">{short(schedule.release)}, {schedule.release.slice(0, 4)}</span>
            <span className="c-card-note">{toRelease > 0 ? `in ${toRelease} days` : toRelease === 0 ? 'today' : `${-toRelease} days ago`}</span>
          </div>
        </div>

        <h2 className="c-h2">Next up</h2>
        <ul className="s-next">
          {stats.next.length ? stats.next.map(t => (
            <li key={t.id}><span className={t.due! < now ? 'bad' : ''}>{short(t.due)}</span> {t.text}</li>
          )) : <li>Every dated task is done.</li>}
        </ul>

        <div className="s-filters s-noprint" role="group" aria-label="Show tasks">
          {FILTERS.map(f => (
            <button key={f.id} type="button" className={`s-chip${filter === f.id ? ' active' : ''}`} onClick={() => pickFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {error && <p className="c-warn">{error}</p>}

        {schedule.phases.map((p, i) => {
          const s = stats.phases[i];
          const groups = p.groups.map(g => ({ ...g, tasks: g.tasks.filter(shows) })).filter(g => g.tasks.length);
          if (!groups.length && filter !== 'all') return null;
          // Key events: each phase shows as its milestone and date; its tasks fold beneath (open when a filter is on)
          const met = s.total > 0 && s.done === s.total;
          return (
            <details key={`${p.id}-${filter}`} className={`s-phase s-milestone${met ? ' met' : ''}`} open={filter !== 'all' || undefined}>
              <summary className="s-phase-head">
                <span className="s-ms-mark" aria-hidden="true">{met ? '✓' : '◆'}</span>
                <h2>{p.milestone ?? p.title}</h2>
                <span className="s-ms-date">{p.date ? `${short(p.date)}, ${p.date.slice(0, 4)}` : p.dates}{p.date && !met && p.date < now ? ' · late' : ''}</span>
                <span className="s-ms-prog">{s.done}/{s.total}</span>
              </summary>
              <div className="s-phase-body">
                <p className="s-phase-title">Phase {i + 1} · {p.title} · {p.weeks} · {p.dates}</p>
                <p className="s-goal">{p.goal}</p>
                <p className="s-gate"><strong>Gate:</strong> {p.gate}</p>
                <div className="s-bar" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.done} aria-label={`Phase ${i + 1} progress`}>
                  <span style={{ width: `${(100 * s.done) / s.total}%` }} />
                </div>
                <p className="s-bar-note">{s.done} of {s.total} done{s.overdue ? ` · ${s.overdue} overdue` : ''}</p>
                <div className="s-cols" aria-hidden="true"><span>Task</span><span>Expected</span><span>Completed</span></div>
                {groups.map(g => (
                  <div key={g.title} className="s-group">
                    <h3>{g.title}</h3>
                    <ul>{g.tasks.map(row)}</ul>
                  </div>
                ))}
              </div>
            </details>
          );
        })}

        {schedule.later.some(shows) && (
          <section className="s-phase">
            <div className="s-phase-head later"><h2>Later, or waiting on your decision</h2></div>
            <div className="s-phase-body"><ul>{schedule.later.filter(shows).map(row)}</ul></div>
          </section>
        )}

      </main>
    </div>
  );
}
