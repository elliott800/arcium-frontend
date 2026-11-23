'use client';

// Sources: the providers the hub records from. Summary = each source's Recorder and Warehouse access and its request
// keys (endpoints). Controller = the access switches and Source maps: Add source registers a source API, and Map source
// stores its drill tree of main keys (what can be collected, and each key's parameters) with a downloadable markdown
// dictionary of it (src/lib/datahubSources.ts).

import { useEffect, useState } from 'react';
import DrillTable from './DrillTable';
import { api, hub, post } from './api';
import type { DhSource } from '@/lib/datahubTypes';
import type { SourceApi } from '@/lib/datahubSources';

function SourcesSummary({ sources, onConfigure }: { sources: DhSource[]; onConfigure: (c: string) => void }) {
  return (
    <section className="panel source-summary-panel" aria-label="Source summary">
      <div className="panel-heading"><div><h3>Source Summary</h3><p>Each source&apos;s endpoint access, its configured Recorder and Warehouse endpoints, and the readiness of its source map.</p></div></div>
      <div className="source-summary-table-wrap"><table className="source-summary-table source-operations-table">
        <thead><tr><th>Source</th><th>Recorder status</th><th>Recorder endpoints</th><th>Warehouse status</th><th>Warehouse endpoints</th></tr></thead>
        <tbody>{sources.map(s => {
          const on = s.keys.reduce((n, k) => n + k.on, 0), hooks = s.keys.reduce((n, k) => n + k.hooks, 0);
          const failing = s.keys.reduce((n, k) => n + k.failing, 0);
          const recKeys = s.keys.filter(k => k.on > 0).length, whKeys = s.keys.filter(k => k.stored_series > 0).length;
          return (
            <tr key={s.connection}>
              <td>{s.connection}</td>
              <td><span className={`endpoint-status ${on ? 'is-on' : 'is-off'}`}>{on ? 'On' : 'Off'}</span>{' '}
                <small className="form-help">{on.toLocaleString()} of {hooks.toLocaleString()} recording{failing ? ` · ${failing} failing` : ''}</small></td>
              <td>{recKeys} of {s.keys.length} configured</td>
              <td><span className={`endpoint-status ${s.warehouse ? 'is-on' : 'is-off'}`}>{s.warehouse ? 'On' : 'Off'}</span></td>
              <td>{whKeys} of {s.keys.length} with stored data</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <div className="source-summary-grid">
        {sources.map(s => (
          <article key={s.connection} className="source-summary-card">
            <header><div><h4>{s.connection}</h4><p>{s.type} connector · {s.keys.length} request key{s.keys.length === 1 ? '' : 's'}{s.error ? ` · last error: ${s.error.slice(0, 80)}` : ''}</p></div>
              <button type="button" className="secondary-action" onClick={() => onConfigure(s.connection)}>Configure source</button></header>
            <div className="source-summary-table-wrap"><table className="source-summary-table">
              <thead><tr><th>Request key</th><th>Recordings</th><th>On</th><th>Stored series</th><th>Stored rows</th></tr></thead>
              <tbody>{s.keys.map(k => (
                <tr key={k.key}><td>{k.key}</td><td>{k.hooks.toLocaleString()}</td><td>{k.on.toLocaleString()}</td>
                  <td>{k.stored_series.toLocaleString()}</td><td>{k.stored_rows.toLocaleString()}</td></tr>
              ))}</tbody>
            </table></div>
          </article>
        ))}
      </div>
      <p className="source-summary-note">Endpoint counts are the request keys configured for each source, not live provider availability; Warehouse endpoints count keys that already have stored data.
        Each source&apos;s map (its drill tree of what can be collected) is under Configure source.</p>
    </section>
  );
}

const KEYS_HELP = `candles fx/{instrument}/{data_rate} - Completed OHLCV bars
orderbook fx/{instrument}/orderbook - Order book snapshots`;

function SourceMaps({ provider, setProvider, rainbow }: { provider: string; setProvider: (c: string) => void; rainbow: boolean }) {
  const [apis, setApis] = useState<SourceApi[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ connection: '', connector: '', description: '', keys: '' });
  const load = () => api<{ sources: SourceApi[] }>(hub({ view: 'source_apis' })).then(r => setApis(r.sources)).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);
  const src = apis?.find(a => a.connection === provider) ?? apis?.[0];

  async function run(body: Record<string, unknown>, done: (r: { source?: SourceApi }) => string) {
    setBusy(true); setMsg('');
    try { const r = await post<{ source?: SourceApi }>(body); setMsg(done(r)); await load(); return r; }
    catch (e) { setMsg((e as Error).message); return null; } finally { setBusy(false); }
  }
  async function add() {
    const r = await run({ action: 'source_add', ...form }, x => `Added ${x.source?.connection} as a source API and stored its map (${x.source?.keys.length} keys).`);
    if (r?.source) { setProvider(r.source.connection); setAdding(false); setForm({ connection: '', connector: '', description: '', keys: '' }); }
  }

  if (!apis) return <p className="empty-state">{msg || 'Loading source maps…'}</p>;
  return (
    <section className="agent-terminal" aria-label="Source maps">
      <div className="panel-heading"><div><h4>Source maps</h4><p>Each source&apos;s map is its drill tree: the main keys it offers, the parameters each key takes and, for keys the hub records, the values it records. The map and its markdown are stored in the database.</p></div>
        <button type="button" className="secondary-action" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : 'Add source'}</button></div>
      {adding && (
        <div className="mapping-form" aria-label="Add source">
          <label>SOURCE NAME<input value={form.connection} onChange={e => setForm(f => ({ ...f, connection: e.target.value }))} placeholder="my_provider" /></label>
          <label>CONNECTOR<input value={form.connector} onChange={e => setForm(f => ({ ...f, connector: e.target.value }))} placeholder="rest, oanda, webull…" /></label>
          <label style={{ gridColumn: '1 / -1' }}>DESCRIPTION<input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What this source provides" /></label>
          <label style={{ gridColumn: '1 / -1' }}>KEYS (ONE PER LINE: KEY, PATH WITH {'{PARAMETERS}'}, - DESCRIPTION)
            <textarea rows={5} value={form.keys} onChange={e => setForm(f => ({ ...f, keys: e.target.value }))} placeholder={KEYS_HELP} /></label>
          <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="builder-action" disabled={busy} onClick={add}>Add source</button>
            <span>The source is registered as a source API and mapped; the Data Hub records it once it has a connector for it.</span>
          </div>
        </div>
      )}
      {src ? (<>
        <div className="builder-selection-bar">
          <label>SOURCE<select value={src.connection} onChange={e => setProvider(e.target.value)}>
            {apis.map(a => <option key={a.connection} value={a.connection}>{a.connection}{a.origin === 'added' ? ' (added)' : ''}{a.mapped ? '' : ' · not mapped'}</option>)}</select></label>
          <button type="button" className="builder-action" disabled={busy}
            onClick={() => run({ action: 'source_map', connection: src.connection }, x => `Mapped ${x.source?.connection}: ${x.source?.keys.length} keys stored with the map's markdown.`)}>
            {src.mapped ? 'Map source again' : 'Map source'}</button>
          {src.mapped && <a className="secondary-action" href={hub({ view: 'source_markdown', connection: src.connection })} download>Download markdown</a>}
          {src.origin === 'added' && <button type="button" className="secondary-action" disabled={busy}
            onClick={() => { if (window.confirm(`Remove ${src.connection} and its map?`)) run({ action: 'source_remove', connection: src.connection }, () => `Removed ${src.connection}.`); }}>Remove</button>}
          <span>{src.connector || 'no'} connector · {src.keys.length} key{src.keys.length === 1 ? '' : 's'}{src.updated_at ? ` · mapped ${src.updated_at.slice(0, 16).replace('T', ' ')}${src.updated_by ? ` by ${src.updated_by}` : ''}` : ''}</span>
        </div>
        {src.mapped
          ? <DrillTable nodes={src.tree} rainbow={rainbow} columns={{ first: `${src.connection} drill tree` }} />
          : <p className="empty-state">{src.connection} has not been mapped yet: Map source builds and stores its drill tree.</p>}
      </>) : <p className="empty-state">No sources yet: Add source registers one.</p>}
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </section>
  );
}

function SourcesController({ sources, reload, provider, setProvider, rainbow }: {
  sources: DhSource[]; reload: () => void; provider: string; setProvider: (c: string) => void; rainbow: boolean;
}) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const recOn = (s: DhSource) => s.keys.some(k => k.on > 0);

  async function access(channel: 'recorder' | 'warehouse', connections: string[], on: boolean) {
    if (channel === 'recorder' && !on) {
      const n = sources.filter(s => connections.includes(s.connection)).reduce((t, s) => t + s.keys.reduce((m, k) => m + k.on, 0), 0);
      if (!window.confirm(`Pause recording for ${connections.join(', ')}? That stops ${n.toLocaleString()} recordings until switched back on.`)) return;
    }
    setBusy(true); setMsg('');
    try {
      const r = await post<{ queued?: number; kept_off?: number }>({ action: 'access', channel, connections, on });
      setMsg(channel === 'warehouse'
        ? `Warehouse access ${on ? 'on' : 'off'} for ${connections.join(', ')}: its stored data is ${on ? 'listed' : 'hidden'} in the Warehouse views.`
        : `Recorder access ${on ? 'on' : 'off'} for ${connections.join(', ')}: ${r.queued?.toLocaleString() ?? 0} recordings ${on ? 'switched on' : 'paused'}${r.kept_off ? `; ${r.kept_off} stay off (switched off by the hub for a reason)` : ''}. The recorder applies it within a minute.`);
      setTimeout(reload, channel === 'warehouse' ? 0 : 8000);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  const all = sources.map(s => s.connection);

  return (
    <section className="panel" aria-label="Source controller">
      <div className="panel-heading"><div><h3>Source Controller</h3><p>Control which sources may feed the Recorder and appear in the Warehouse. Master controls switch every source; each source can then be adjusted on its own.</p></div></div>
      <div className="source-master-grid" aria-label="Master source access">
        {(['recorder', 'warehouse'] as const).map(ch => {
          const on = sources.every(s => (ch === 'recorder' ? recOn(s) : s.warehouse));
          return (
            <div key={ch} className="source-master-card">
              <span><strong>{ch === 'recorder' ? 'All Recorder access' : 'All Warehouse access'}</strong>
                <small>{ch === 'recorder' ? 'Record or pause every source' : 'List every source’s stored data in the Warehouse'}</small></span>
              <button className="switch" type="button" role="switch" aria-checked={on} disabled={busy} aria-label={`Master ${ch} access`} onClick={() => access(ch, all, !on)} />
            </div>
          );
        })}
      </div>
      <div className="source-list-heading"><div><h4>Available source endpoints</h4><p>Change an individual source after using a master control.</p></div><span>{sources.length} sources</span></div>
      <div className="source-endpoint-list" role="table" aria-label="Source endpoint access">
        <div className="source-endpoint-row source-endpoint-header" role="row">
          <span role="columnheader">Source endpoint</span><span role="columnheader">Recorder</span><span role="columnheader">Warehouse</span><span role="columnheader">Both</span>
        </div>
        {sources.map(s => {
          const r = recOn(s), w = s.warehouse;
          return (
            <div key={s.connection} className="source-endpoint-row" role="row">
              <span className="source-endpoint-name" role="cell"><strong>{s.connection}</strong><small>{s.type} · {s.keys.map(k => k.key).join(', ')}</small></span>
              <span role="cell"><button className="source-access-switch" type="button" role="switch" aria-checked={r} disabled={busy} aria-label={`${s.connection} recorder access`} onClick={() => access('recorder', [s.connection], !r)}>{r ? 'On' : 'Off'}</button></span>
              <span role="cell"><button className="source-access-switch" type="button" role="switch" aria-checked={w} disabled={busy} aria-label={`${s.connection} warehouse access`} onClick={() => access('warehouse', [s.connection], !w)}>{w ? 'On' : 'Off'}</button></span>
              <span className="source-row-actions" role="cell"><button type="button" className="secondary-action source-both-button" disabled={busy}
                onClick={async () => { const on = !(r && w); await access('recorder', [s.connection], on); await access('warehouse', [s.connection], on); }}>{r && w ? 'Turn both off' : 'Turn both on'}</button></span>
            </div>
          );
        })}
      </div>
      {msg && <p className="controller-status" role="status">{msg}</p>}
      <SourceMaps provider={provider} setProvider={setProvider} rainbow={rainbow} />
    </section>
  );
}

export default function Sources({ panel, setPanel, sources, reload, rainbow }: {
  panel: 'summary' | 'controller'; setPanel: (p: 'summary' | 'controller') => void; sources: DhSource[]; reload: () => void; rainbow: boolean;
}) {
  const [provider, setProvider] = useState(sources[0]?.connection ?? '');
  if (panel === 'summary') return <SourcesSummary sources={sources} onConfigure={c => { setProvider(c); setPanel('controller'); }} />;
  return <SourcesController sources={sources} reload={reload} provider={provider || sources[0]?.connection} setProvider={setProvider} rainbow={rainbow} />;
}
