'use client';

// The few pieces every dashboard shares: fetch-and-refresh, a sortable table, times, and sending a
// command to a machine's live controller. Styling is the m-* classes in src/shell/shell.css.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

/** The time now, refreshed every `every` ms: for "5 min ago" labels and staleness checks. Read the clock through
 *  this, never Date.now() while rendering (React may render twice; the label would jump). */
export function useNow(every = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** GET a JSON route; refreshes every `every` ms (0 = once). `reload()` fetches again now. */
export function useJson<T>(url: string | null, every = 0): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (!url) return;
    fetch(url, { cache: 'no-store' })
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error || `${r.status} ${r.statusText}`);
        setData(body as T); setError('');
      })
      .catch(e => setError(String(e.message || e)));
  }, [url]);
  useEffect(() => {
    reload();
    if (!every) return;
    const t = setInterval(reload, every);
    return () => clearInterval(t);
  }, [reload, every]);
  return { data, error, reload };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any JSON reply; callers read the fields they expect
export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

/** Queue a command on a machine's live controller (train, untrain, pause, resume, restart, update, status,
 *  engine_start, engine_stop). The machine's heartbeat runs it within about a second. */
export function sendControl(machine_name: string, action: string, extra: Record<string, unknown> = {}) {
  return postJson('/api/admin/machines/control', { machine_name, action, ...extra });
}

export function ago(t: string | number | null | undefined): string {
  if (t == null || t === '') return 'never';
  const ms = typeof t === 'number' ? t : new Date(t).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago`
    : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

export const num = (v: unknown, digits = 2) =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits);

export interface Column<R> {
  key: string;
  label: string;
  value?: (r: R) => unknown;         // what sorts (default: r[key])
  render?: (r: R) => ReactNode;      // what shows (default: the value)
  numeric?: boolean;
}

/** A table that sorts by any column (click the header). */
export function Table<R>({ rows, columns, rowKey, empty = 'Nothing here yet.', onRow, selected }: {
  rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; empty?: string;
  onRow?: (r: R) => void; selected?: string | null;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    const get = (r: R) => (col?.value ? col.value(r) : (r as Record<string, unknown>)[sort.key]);
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      const nx = Number(x), ny = Number(y);
      const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y));
      return c * sort.dir;
    });
  }, [rows, columns, sort]);
  if (!rows.length) return <div className="m-table-wrap"><div className="m-empty">{empty}</div></div>;
  return (
    <div className="m-table-wrap">
      <table className="m-table">
        <thead><tr>{columns.map(c => (
          <th key={c.key} className={c.numeric ? 'm-num' : undefined}
            aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 1 ? -1 : 1 }))}>
            {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </th>
        ))}</tr></thead>
        <tbody>{sorted.map(r => {
          const k = rowKey(r);
          return (
            <tr key={k} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: 'pointer' } : undefined}
              className={selected === k ? 'm-selected' : undefined}>
              {columns.map(c => {
                const v = c.value ? c.value(r) : (r as Record<string, unknown>)[c.key];
                return <td key={c.key} className={c.numeric ? 'm-num' : undefined}>{c.render ? c.render(r) : v == null ? '—' : String(v)}</td>;
              })}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

/** A page with a title, a one-line description and optional actions on the right. */
export function Page({ title, intro, actions, children }: { title: string; intro?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="m-page">
      <div className="m-head">
        <h1>{title}</h1>{intro && <p>{intro}</p>}
        {actions && <div className="m-row" style={{ marginLeft: 'auto' }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Notice({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={msg.ok ? 'm-badge good' : 'm-error'} role="status">{msg.text}</p>;
}
