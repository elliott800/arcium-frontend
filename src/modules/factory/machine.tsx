'use client';

// The controller machines (the laptop today): what each launcher last reported — every 15 s, and at once
// after a command — with its training runs, engines and controls. Commands go through the machine's command
// queue (POST /api/admin/machines/control); the heartbeat runs them within about a second.
import { useState } from 'react';
import { Notice, Page, Table, ago, num, sendControl, useJson } from '@/ui/kit';

export interface EngineState {
  pid: number | null; state: string; cycle: number; max_cycles: number | null; started: number | null;
  updated: number | null; balance: number | null; equity: number | null; error: string | null; exit_code: number | null;
}
export interface LiveStatus {
  commit?: string; paused?: boolean; processes?: number | null; up_seconds?: number; heartbeat_pid?: number | null;
  training?: Record<string, number>; training_started?: Record<string, number | null>; silos?: string[];
  launcher_log?: string[]; train_logs?: Record<string, string[]>; engines?: Record<string, Record<string, EngineState>>;
}
export interface Machine {
  machine_name: string; hostname: string | null; platform: string | null; last_heartbeat: string | null;
  live_status: LiveStatus | null; live_status_at: string | null;
}

export const isStale = (m: Machine) => !m.live_status_at || Date.now() - new Date(m.live_status_at).getTime() > 3 * 60_000;
const uptime = (s?: number) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export interface MachinesStatus { machines: Machine[]; can_control: boolean; demo: boolean }

/** The machines' last reports (GET /api/machines/status): anyone signed in reads it; can_control is the owner
 *  on the live site (the demo's machine is simulated and takes no commands). */
export function useMachines() {
  const r = useJson<MachinesStatus>('/api/machines/status', 5000);
  return { data: r.data?.machines ?? null, control: !!r.data?.can_control, demo: !!r.data?.demo, error: r.error, reload: r.reload };
}

export function useControl(reload: () => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (machine: string, action: string, extra: Record<string, unknown> = {}) => {
    const { ok, data } = await sendControl(machine, action, extra);
    setMsg(ok ? { ok: true, text: `Sent ${action.replace('_', ' ')} to ${machine}.` } : { ok: false, text: data.error || 'Could not send the command.' });
    for (let i = 1; i <= 10; i++) setTimeout(reload, i * 1500);
  };
  return { msg, send };
}

export default function MachineModule() {
  const { data: machines, control, demo, error, reload } = useMachines();
  const { msg, send } = useControl(reload);
  const [log, setLog] = useState<string | null>(null);

  const live = (machines ?? []).filter(m => m.live_status);
  return (
    <Page title="Machine" intro={demo ? 'A simulated controller machine: its silos and engines, as the real one reports them.' : 'The controller machines that house silos and engines.'}>
      <Notice msg={msg} />
      {error && <p className="m-error">{error}</p>}
      {!machines && !error && <p className="m-muted">Loading…</p>}
      {machines && !live.length && <div className="m-card m-empty">No controller has reported yet. A launcher reports within a minute of starting.</div>}
      {live.map(m => {
        const s = m.live_status!;
        const stale = isStale(m);
        const training = s.training ?? {};
        const silos = [...new Set([...(s.silos ?? []), ...Object.keys(training), ...Object.keys(s.engines ?? {})])].sort();
        const engines = Object.entries(s.engines ?? {}).flatMap(([silo, kinds]) =>
          Object.entries(kinds).map(([kind, e]) => ({ id: `${silo}/${kind}`, silo, kind, ...e })));
        return (
          <section key={m.machine_name} className="m-card" data-machine={m.machine_name}>
            <div className="m-row">
              <h2 style={{ margin: 0 }}>{m.machine_name}</h2>
              <span className={`m-badge ${stale ? 'bad' : s.paused ? 'warn' : 'good'}`}>{stale ? 'not reporting' : s.paused ? 'paused' : 'online'}</span>
              <span className="m-muted">reported {ago(m.live_status_at)}</span>
            </div>
            <dl className="m-kv" style={{ margin: '10px 0' }}>
              <dt>Code</dt><dd className="m-num">{s.commit ?? '—'}</dd>
              <dt>Up</dt><dd>{uptime(s.up_seconds)}</dd>
              <dt>Heartbeat</dt><dd>{s.heartbeat_pid ? 'running' : 'stopped'}</dd>
              <dt>Processes</dt><dd>{s.processes ?? '—'}</dd>
            </dl>

            <h2>Silos</h2>
            <Table rows={silos.map(silo => ({ silo }))} rowKey={r => r.silo} columns={[
              { key: 'silo', label: 'Silo', render: r => <strong>{r.silo}</strong> },
              { key: 'training', label: 'Training', value: r => (training[r.silo] ? 1 : 0),
                render: r => training[r.silo] ? <span className="m-badge good">training (pid {training[r.silo]})</span> : <span className="m-badge">idle</span> },
              { key: 'act', label: '', render: r => (
                <div className="m-row">
                  {!control ? null : training[r.silo]
                    ? <button className="m-btn" onClick={() => send(m.machine_name, 'untrain', { silo: r.silo })}>Stop training</button>
                    : <button className="m-btn primary" disabled={stale} onClick={() => send(m.machine_name, 'train', { silo: r.silo })}>Train</button>}
                  {s.train_logs?.[r.silo]?.length ? <button className="m-btn" onClick={() => setLog(log === r.silo ? null : r.silo)}>Log</button> : null}
                </div>) },
            ]} />
            {log && s.train_logs?.[log] && <pre className="m-card m-num" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{s.train_logs[log].join('\n')}</pre>}

            <h2 style={{ marginTop: 14 }}>Engines</h2>
            <Table rows={engines} rowKey={r => r.id} empty="No engine has run on this machine since the launcher started." columns={[
              { key: 'silo', label: 'Engine', render: r => <strong>{r.silo}</strong> },
              { key: 'kind', label: 'Kind', render: r => (r.kind === 'live' ? 'practice live' : 'simulated') },
              { key: 'state', label: 'State', render: r => <span className={`m-badge ${r.state === 'running' ? 'good' : r.state === 'failed' ? 'bad' : ''}`}>{r.state}</span> },
              { key: 'cycle', label: 'Cycle', numeric: true, render: r => `${r.cycle}${r.max_cycles ? ` / ${r.max_cycles}` : ''}` },
              { key: 'equity', label: 'Equity', numeric: true, render: r => num(r.equity ?? r.balance) },
              { key: 'updated', label: 'Updated', render: r => ago(r.updated) },
              { key: 'act', label: '', render: r => control && r.pid ? (
                <div className="m-row">
                  <button className="m-btn" onClick={() => send(m.machine_name, 'engine_stop', { silo: r.silo, kind: r.kind })}>Stop</button>
                  <button className="m-btn danger" title="Kill switch: stop at once"
                    onClick={() => window.confirm(`Kill ${r.silo} (${r.kind}) now?`) && send(m.machine_name, 'engine_stop', { silo: r.silo, kind: r.kind, force: true })}>Kill</button>
                </div>) : r.error ? <span className="m-error" title={r.error}>error</span> : null },
            ]} />

            {control && <div className="m-row" style={{ marginTop: 14 }}>
              {s.paused
                ? <button className="m-btn primary" onClick={() => send(m.machine_name, 'resume')}>Resume</button>
                : <button className="m-btn" onClick={() => send(m.machine_name, 'pause')}>Pause training</button>}
              <button className="m-btn" onClick={() => send(m.machine_name, 'restart')}>Restart heartbeat</button>
              <button className="m-btn" onClick={() => send(m.machine_name, 'status')}>Report now</button>
            </div>}
            {s.launcher_log?.length ? (
              <details style={{ marginTop: 10 }}>
                <summary className="m-muted">Launcher log</summary>
                <pre className="m-num" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{s.launcher_log.slice(-12).join('\n')}</pre>
              </details>
            ) : null}
          </section>
        );
      })}
    </Page>
  );
}
