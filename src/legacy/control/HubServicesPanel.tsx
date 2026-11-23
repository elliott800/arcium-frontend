'use client';

// Legacy panel (Control panel > Hub services): the Data Hub's background services and their controls.

import { useEffect, useState } from 'react';

interface ServiceRow {
  machine_name: string;
  process_name: string;
  pid: number | null;
  health: string;
  paused: boolean;
  seconds_since_tick: number | null;
  summary: Record<string, unknown>;
  last_error: string | null;
}

const HEALTH_COLOR: Record<string, string> = {
  running: '#22c55e', paused: '#f59e0b', stale: '#f43f5e', stopped: '#6b7280', error: '#f43f5e',
};

function summaryLine(s: Record<string, unknown>): string {
  const keys = ['hooks_enabled', 'hooks_error', 'rows_last_tick', 'seeds', 'versions', 'uploads_pending', 'uploads_rejected'];
  return keys.filter(k => s?.[k] !== undefined).map(k => `${k.replace(/_/g, ' ')}: ${s[k]}`).join(' · ');
}

/** "42s ago", "7 min ago", "15 h ago", "3 d ago". */
function ago(seconds: number): string {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/** Admin: health and control of the hub's universal services. */
export default function HubServicesPanel() {
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [msg, setMsg] = useState('');

  async function load() {
    const data = await fetch('/api/admin/services', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : [])).catch(() => []);
    setRows(data);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  async function send(r: ServiceRow, command: 'pause' | 'resume' | 'reload') {
    const res = await fetch('/api/admin/services', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_name: r.machine_name, process_name: r.process_name, command }),
    });
    setMsg(res.ok ? `${command} sent to ${r.process_name}` : `could not send ${command}`);
    setTimeout(() => setMsg(''), 4000);
    setTimeout(load, 1500);
  }

  return (
    <div className="p-admin-section">
      <div className="p-action-group-label">Hub services</div>
      {rows.length === 0 ? (
        <p style={{ fontSize: 11, opacity: 0.7, margin: 0 }}>No hub service has reported yet.</p>
      ) : (
        <div className="p-admin-scroll">
        <table className="p-admin-table" style={{ fontSize: 11 }}>
          <thead><tr><th>Service</th><th>Status</th><th>Last tick</th><th>Summary</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.machine_name}/${r.process_name}`}>
                <td>{r.process_name}</td>
                <td style={{ color: HEALTH_COLOR[r.health] ?? undefined }}>{r.health}</td>
                <td>{r.seconds_since_tick == null ? '—' : ago(r.seconds_since_tick)}</td>
                <td style={{ whiteSpace: 'normal' }} title={r.last_error ?? undefined}>
                  {summaryLine(r.summary)}{r.last_error ? ' · ⚠ ' + r.last_error.slice(0, 80) : ''}
                </td>
                <td>
                  {r.paused
                    ? <button className="p-dash-btn" onClick={() => send(r, 'resume')}>Resume</button>
                    : <button className="p-dash-btn" onClick={() => send(r, 'pause')}>Pause</button>}
                  {' '}
                  <button className="p-dash-btn" onClick={() => send(r, 'reload')}>Reload</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {msg && <p style={{ fontSize: 11, margin: 0 }}>{msg}</p>}
    </div>
  );
}
