'use client';

// Data (owner): the Data Hub's stock watchlist (every stock in the tracked funds, plus any added here), the funds
// it tracks, each source connection's recording hooks, and recent source errors. Watchlist changes go to the
// hub's source manager (POST /api/admin/datahub), which applies them on its next pass.
import { useState } from 'react';
import { Notice, Page, Table, ago, postJson, useJson } from '@/ui/kit';

interface Datahub {
  connections: { connection: string; hooks: number; ok: number; failing: number; waiting: number; last_run: string | null }[];
  watchlist: { stage: string; n: number; note: string | null }[];
  watchlist_total: number;
  funds: { fund: string; key: string; status: string | null; holdings: number | null; updated: string | null }[];
  errors: { at: string; connection: string; hook_id: string; stage: string; problem: string }[];
  database_size: string | null;
}

export default function ControlData() {
  const { data: hub, error, reload } = useJson<Datahub>('/api/admin/datahub', 30000);
  const [symbols, setSymbols] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function watchlist(command: 'watchlist_add' | 'watchlist_remove' | 'watchlist_pass') {
    const list = symbols.split(/[\s,]+/).filter(Boolean);
    const { ok, data } = await postJson('/api/admin/datahub', { command, symbols: list });
    setMsg(!ok ? { ok: false, text: data.error ?? 'Could not send the command.' }
      : { ok: true, text: command === 'watchlist_pass' ? 'Asked the source manager to run a watchlist pass.'
        : `Sent ${data.symbols ?? list.length} symbol(s) to the source manager; they show here after its next pass.` });
    if (ok && command !== 'watchlist_pass') setSymbols('');
    setTimeout(reload, 4000);
  }

  const waiting = hub?.watchlist.find(w => w.stage === 'waiting')?.note;
  return (
    <Page title="Data" intro="The Data Hub's stock watchlist, tracked funds and source connections.">
      {error && <p className="m-error">{error}</p>}
      <section className="m-card">
        <h2>Stock watchlist <span className="m-badge">{hub?.watchlist_total ?? 0}</span></h2>
        <p className="m-muted">Every stock in the tracked funds, plus any added here. Added stocks get full monthly, weekly and
          daily history first, then intraday down to 1 minute (kept 90 days).</p>
        <div className="m-row">
          {(hub?.watchlist ?? []).map(w => <span key={w.stage} className={`m-badge ${w.stage === 'recording' ? 'good' : w.stage === 'waiting' ? 'warn' : ''}`} title={w.note ?? ''}>{w.n} {w.stage}</span>)}
          {hub && !hub.watchlist.length && <span className="m-muted">The first watchlist pass hasn&apos;t run yet.</span>}
        </div>
        {waiting && <p className="m-error">{waiting}</p>}
        <div className="m-row" style={{ marginTop: 10 }}>
          <input className="m-input" style={{ minWidth: 260 }} placeholder="Symbols to add or remove, e.g. PLTR, SOFI"
            aria-label="Symbols" value={symbols} onChange={e => setSymbols(e.target.value)} />
          <button className="m-btn primary" disabled={!symbols.trim()} onClick={() => watchlist('watchlist_add')}>Add</button>
          <button className="m-btn" disabled={!symbols.trim()} onClick={() => watchlist('watchlist_remove')}>Remove</button>
          <button className="m-btn" onClick={() => watchlist('watchlist_pass')}>Run a pass now</button>
        </div>
        <Notice msg={msg} />
      </section>
      <h2 style={{ fontSize: 14, margin: 0 }}>Funds tracked</h2>
      <Table rows={hub?.funds ?? []} rowKey={f => f.fund} empty={hub ? 'No funds tracked.' : 'Loading…'} columns={[
        { key: 'fund', label: 'Fund', render: f => <strong>{f.fund}</strong> },
        { key: 'source', label: 'Source', value: f => f.key.split('.')[0] },
        { key: 'holdings', label: 'Holdings', numeric: true },
        { key: 'status', label: 'Status', render: f => <span className={`m-badge ${f.status === 'ok' ? 'good' : f.status ? 'bad' : 'warn'}`}>{f.status ?? 'waiting'}</span> },
        { key: 'updated', label: 'Updated', render: f => ago(f.updated) },
      ]} />
      <h2 style={{ fontSize: 14, margin: 0 }}>Sources <span className="m-muted">· database {hub?.database_size ?? '—'}</span></h2>
      <Table rows={hub?.connections ?? []} rowKey={c => c.connection} empty={hub ? 'No sources.' : 'Loading…'} columns={[
        { key: 'connection', label: 'Connection', render: c => <strong>{c.connection}</strong> },
        { key: 'hooks', label: 'Hooks', numeric: true },
        { key: 'ok', label: 'OK', numeric: true },
        { key: 'failing', label: 'Failing', numeric: true, render: c => <span className={c.failing ? 'm-error' : ''}>{c.failing}</span> },
        { key: 'waiting', label: 'Waiting', numeric: true },
        { key: 'last_run', label: 'Last run', render: c => ago(c.last_run) },
      ]} />
      {hub && hub.errors.length > 0 && (
        <section className="m-card">
          <h2>Recent source errors</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {hub.errors.map((e, i) => <li key={i}><span className="m-muted">{ago(e.at)} · {e.connection} · {e.stage}</span> {e.problem}</li>)}
          </ul>
        </section>
      )}
    </Page>
  );
}
