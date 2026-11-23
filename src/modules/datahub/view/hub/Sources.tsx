'use client';

// Sources: the providers the hub records from. Summary = each source's Recorder and Warehouse access and its request
// keys (endpoints). Controller = the access switches and Source maps: Add source registers a source API with the Data
// Hub as its connector (add_connection), and Map source stores its drill tree (keys, parameters, values) with a
// downloadable markdown dictionary of it (src/lib/datahubSources.ts). The Recorder records from that tree.

import { useEffect, useState } from 'react';
import DrillTable from './DrillTable';
import { api, hub, post, waitFor, type HubCommand } from './api';
import type { DhSource } from '@/lib/datahubTypes';
import type { SourceApi, SourceOptions } from '@/lib/datahubSources';

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

const failure = (c: HubCommand) => String((c.result as { error?: string } | null)?.error ?? (c.status === 'failed' ? 'the hub refused it' : 'the hub has not answered yet'));

function AddSource({ onAdded }: { onAdded: (connection: string) => void }) {
  const [opts, setOpts] = useState<SourceOptions | null>(null);
  const [form, setForm] = useState({ connection: '', type: '', credentials: '', seed_id: '', seed_class: '' });
  const [classes, setClasses] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<SourceOptions>(hub({ view: 'source_options' })).then(setOpts).catch(e => setMsg((e as Error).message)); }, []);
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));

  async function findClasses(seed_id: string) {
    set({ seed_id, seed_class: '' }); setClasses([]);
    if (!seed_id) return;
    setBusy(true); setMsg('Asking the Data Hub which source APIs this seed has…');
    try {
      const { control_id } = await post<{ control_id: number }>({ action: 'source_inspect', seed_id });
      const c = await waitFor(control_id);
      if (c.status !== 'done') { setMsg(`Could not read the seed: ${failure(c)}`); return; }
      const found = ((c.result as { classes?: { name?: string; class?: string }[] })?.classes ?? []).map(x => String(x.name ?? x.class ?? x)).filter(Boolean);
      setClasses(found); set({ seed_class: found[0] ?? '' });
      setMsg(found.length ? '' : 'This seed has no source API classes.');
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function register() {
    setBusy(true); setMsg('Registering the source API with the Data Hub…');
    try {
      const { control_id } = await post<{ control_id: number }>({ action: 'source_register', ...form });
      const c = await waitFor(control_id);
      if (c.status !== 'done') { setMsg(`The Data Hub did not register it: ${failure(c)}`); return; }
      await post({ action: 'source_map', connection: form.connection.trim().toLowerCase() });
      const keys = (c.result as { keys?: string[] })?.keys ?? [];
      setMsg(`Registered ${form.connection} (${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}) and stored its map.`);
      onAdded(form.connection.trim().toLowerCase());
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  if (!opts) return <p className="empty-state">{msg || 'Loading…'}</p>;
  return (
    <div className="mapping-form" aria-label="Add source">
      <label>SOURCE NAME<input value={form.connection} onChange={e => set({ connection: e.target.value })} placeholder="my_provider" /></label>
      <label>SOURCE API (CONNECTOR)<select value={form.type} onChange={e => set({ type: e.target.value, seed_id: '', seed_class: '' })}>
        <option value="">Choose…</option>
        {opts.types.map(t => <option key={t} value={t}>{t === 'seed' ? 'seed: a source API from a seed' : t}</option>)}</select></label>
      {form.type === 'seed' && (<>
        <label>SEED<select value={form.seed_id} disabled={busy} onChange={e => findClasses(e.target.value)}>
          <option value="">Choose…</option>
          {opts.seeds.map(s => <option key={s.id} value={s.id}>{s.name} v{s.version} ({s.owner})</option>)}</select></label>
        <label>SOURCE API CLASS<select value={form.seed_class} onChange={e => set({ seed_class: e.target.value })}>
          {classes.length ? classes.map(c => <option key={c}>{c}</option>) : <option value="">{form.seed_id ? '…' : 'choose a seed first'}</option>}</select></label>
      </>)}
      <label>API KEY (FROM THE API KEYS PAGE)<select value={form.credentials} onChange={e => set({ credentials: e.target.value })}>
        <option value="">Choose…</option>
        {opts.credentials.map(c => <option key={c.ref} value={c.ref}>{c.label}</option>)}</select></label>
      <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
        <button type="button" className="builder-action" disabled={busy || !form.connection || !form.type || !form.credentials || (form.type === 'seed' && !form.seed_class)} onClick={register}>Register source API</button>
        <span>The Data Hub builds the connector, checks the keys it declares, and lists it as a source; then its map is stored. Keys are added and changed on the Data Hub&apos;s API keys page; their values never come back to the browser.</span>
      </div>
      {msg && <p className="controller-status" role="status" style={{ gridColumn: '1 / -1' }}>{msg}</p>}
    </div>
  );
}

function SourceMaps({ provider, setProvider, rainbow }: { provider: string; setProvider: (c: string) => void; rainbow: boolean }) {
  const [apis, setApis] = useState<SourceApi[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = () => api<{ sources: SourceApi[] }>(hub({ view: 'source_apis' })).then(r => setApis(r.sources)).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);
  const src = apis?.find(a => a.connection === provider) ?? apis?.[0];

  async function map(connection: string) {
    setBusy(true); setMsg('');
    try {
      const r = await post<{ source: SourceApi }>({ action: 'source_map', connection });
      setMsg(`Mapped ${r.source.connection}: ${r.source.keys.length} keys stored with the map's markdown.`); await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  if (!apis) return <p className="empty-state">{msg || 'Loading source maps…'}</p>;
  return (
    <section className="agent-terminal" aria-label="Source maps">
      <div className="panel-heading"><div><h4>Source maps</h4><p>Each source is a source API registered with the Data Hub. Its map is its drill tree: the keys it offers, the parameters each key takes, and the values they take (what its recordings use, and the rates a candles key allows). The map and its markdown are stored in the database; the Recorder records from it.</p></div>
        <button type="button" className="secondary-action" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : 'Add source'}</button></div>
      {adding && <AddSource onAdded={async c => { await load(); setProvider(c); setAdding(false); }} />}
      {src ? (<>
        <div className="builder-selection-bar">
          <label>SOURCE<select value={src.connection} onChange={e => setProvider(e.target.value)}>
            {apis.map(a => <option key={a.connection} value={a.connection}>{a.connection}{a.mapped ? '' : ' · not mapped'}</option>)}</select></label>
          <button type="button" className="builder-action" disabled={busy} onClick={() => map(src.connection)}>{src.mapped ? 'Map source again' : 'Map source'}</button>
          {src.mapped && <a className="secondary-action" href={hub({ view: 'source_markdown', connection: src.connection })} download>Download markdown</a>}
          <a className="secondary-action" href={hub({ view: 'source_dictionary', connection: src.connection })} download>Download dictionary</a>
          <span>{src.connector} connector{src.seed_class ? ` (${src.seed_class})` : ''} · {src.keys.length} key{src.keys.length === 1 ? '' : 's'}{src.updated_at ? ` · mapped ${src.updated_at.slice(0, 16).replace('T', ' ')}${src.updated_by ? ` by ${src.updated_by}` : ''}` : ''}</span>
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
