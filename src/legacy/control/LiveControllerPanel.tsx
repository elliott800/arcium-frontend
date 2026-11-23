'use client';

// The live controllers: what each machine's launcher last reported (every minute) and the controls the site can
// send it through the machine's command queue (the heartbeat runs them within a poll).

import { useCallback, useEffect, useState } from 'react';
import { useNow } from '@/ui/kit';

interface LiveStatus {
  commit?: string; paused?: boolean; processes?: number | null; up_seconds?: number; heartbeat_pid?: number | null;
  training?: Record<string, number>; silos?: string[]; launcher_log?: string[];
}
interface Machine { machine_name: string; hostname: string | null; last_heartbeat: string | null; live_status: LiveStatus | null; live_status_at: string | null }

const ago = (t: string | null) => {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const uptime = (s?: number) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export default function LiveControllerPanel() {
  const now = useNow();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => {
    fetch('/api/admin/machines').then(r => (r.ok ? r.json() : [])).then(setMachines).catch(() => setMachines([]));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function send(machine: string, action: string, silo?: string) {
    if (action === 'update' && !window.confirm(`Update ${machine}'s live controller from GitHub? It waits up to 30 minutes for training to finish, backs up, pulls, checks and restarts.`)) return;
    const r = await fetch('/api/admin/machines/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_name: machine, action, silo }) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? { ok: true, text: `Sent ${action}${silo ? ` (${silo})` : ''} to ${machine}: it runs within about a second; the status below updates as soon as the laptop reports.` }
                : { ok: false, text: d.error || 'Could not send the command.' });
    for (let i = 1; i <= 20; i++) setTimeout(load, i * 1000);   // every second for 20 s: shows the change as it lands
  }

  if (!machines) return <p className="c-hint">Loading…</p>;
  const live = machines.filter(m => m.live_status);
  return (
    <>
      <p className="c-hint">Each machine&rsquo;s live controller reports here every 15 seconds, and at once after a command. Commands go through the machine&rsquo;s
        command queue: its heartbeat runs them within a poll, and the launcher on the machine does the work (every process
        it runs is in one job, so stopping and pausing reach every worker).</p>
      {msg && <p className={msg.ok ? 'c-ok' : 'c-warn'}>{msg.text}</p>}
      {!live.length && <p className="c-warn">No live controller has reported yet. A launcher reports after it starts on the new code.</p>}
      {live.map(m => {
        const s = m.live_status!;
        const training = s.training ?? {};
        const silos = [...new Set([...(s.silos ?? []), ...Object.keys(training)])];
        const stale = !m.live_status_at || now - new Date(m.live_status_at).getTime() > 3 * 60_000;
        return (
          <section key={m.machine_name} className="c-panel c-live">
            <h2 className="c-h2">{m.machine_name} <span className={`c-count${stale ? ' bad' : ''}`}>{stale ? 'not reporting' : s.paused ? 'paused' : 'running'}</span></h2>
            <div className="c-live-facts">
              <span>Commit <b>{s.commit ?? '—'}</b></span>
              <span>Up <b>{uptime(s.up_seconds)}</b></span>
              <span>Processes <b>{s.processes ?? '—'}</b></span>
              <span>Heartbeat <b>{s.heartbeat_pid ? 'running' : 'stopped'}</b></span>
              <span>Reported <b>{ago(m.live_status_at)}</b></span>
            </div>
            <table className="c-table">
              <thead><tr><th>Silo</th><th>Training</th><th /></tr></thead>
              <tbody>{silos.map(silo => (
                <tr key={silo}>
                  <td><strong>{silo}</strong></td>
                  <td>{training[silo] ? `yes (pid ${training[silo]})` : 'no'}</td>
                  <td>{training[silo]
                    ? <button className="p-dash-btn" onClick={() => send(m.machine_name, 'untrain', silo)}>Stop training</button>
                    : <button className="p-dash-btn p-dash-btn--accent" onClick={() => send(m.machine_name, 'train', silo)}>Train</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="c-form-row">
              {s.paused
                ? <button className="p-dash-btn p-dash-btn--accent" onClick={() => send(m.machine_name, 'resume')}>Resume</button>
                : <button className="p-dash-btn" onClick={() => send(m.machine_name, 'pause')}>Pause</button>}
              <button className="p-dash-btn" onClick={() => send(m.machine_name, 'restart')}>Restart heartbeat</button>
              <button className="p-dash-btn" onClick={() => send(m.machine_name, 'update')}>Update from GitHub</button>
              <button className="p-dash-btn" onClick={() => send(m.machine_name, 'status')}>Report now</button>
            </div>
            {s.launcher_log?.length ? <pre className="c-live-log">{s.launcher_log.slice(-8).join('\n')}</pre> : null}
          </section>
        );
      })}
    </>
  );
}
