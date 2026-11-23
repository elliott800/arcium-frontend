'use client';

// Sources: the providers the hub records from. Summary = each source's Recorder and Warehouse access, its request
// keys (endpoints) and whether each key's map has been reviewed and saved. Controller = the access switches and the
// Source Map Builder, which saves where each request's data belongs (category, group, form, format, destination, tags).

import { useEffect, useMemo, useState } from 'react';
import DrillTable from './DrillTable';
import { post } from './api';
import type { DhNode, DhSource, DhSourceKey } from '@/lib/datahubTypes';

const INSTRUMENT_TYPES = ['auto', 'Stock', 'ETF', 'ETN', 'Commodity', 'Currency', 'Crypto', 'Bond', 'Real estate', 'Spread', 'Other'];
const REFERENCE_GROUPS = ['Financial statements', 'Valuation', 'Economic benchmarks', 'Market breadth', 'Sentiment', 'Positioning',
  'Fund holdings', 'Order flow', 'Scanner cards', 'Text feed', 'Other'];
const FORMATS = ['OHLCV bars', 'Option chains', 'Values', 'Records', 'Text'];
const STORES = ['wh_ohlcv', 'wh_values', 'wh_records', 'wh_options'];

const place = (k: DhSourceKey) => (k.map.category === 'instrument'
  ? `Instrument / ${k.map.group === 'auto' ? 'by instrument' : k.map.group} / ${k.map.form ?? 'Spot'}`
  : `Reference / ${k.map.structure ?? 'Structured'} / ${k.map.group}`);

function SourcesSummary({ sources, onConfigure }: { sources: DhSource[]; onConfigure: (c: string) => void }) {
  return (
    <section className="panel source-summary-panel" aria-label="Source summary">
      <div className="panel-heading"><div><h3>Source Summary</h3><p>Each source&apos;s endpoint access, its configured Recorder and Warehouse endpoints, and the readiness of its source map.</p></div></div>
      <div className="source-summary-table-wrap"><table className="source-summary-table source-operations-table">
        <thead><tr><th>Source</th><th>Recorder status</th><th>Recorder endpoints</th><th>Warehouse status</th><th>Warehouse endpoints</th><th>Map endpoints</th><th>Map status</th></tr></thead>
        <tbody>{sources.map(s => {
          const on = s.keys.reduce((n, k) => n + k.on, 0), hooks = s.keys.reduce((n, k) => n + k.hooks, 0);
          const failing = s.keys.reduce((n, k) => n + k.failing, 0);
          const recKeys = s.keys.filter(k => k.on > 0).length, whKeys = s.keys.filter(k => k.stored_series > 0).length;
          const saved = s.keys.filter(k => k.map.saved).length;
          return (
            <tr key={s.connection}>
              <td>{s.connection}</td>
              <td><span className={`endpoint-status ${on ? 'is-on' : 'is-off'}`}>{on ? 'On' : 'Off'}</span>{' '}
                <small className="form-help">{on.toLocaleString()} of {hooks.toLocaleString()} recording{failing ? ` · ${failing} failing` : ''}</small></td>
              <td>{recKeys} of {s.keys.length} configured</td>
              <td><span className={`endpoint-status ${s.warehouse ? 'is-on' : 'is-off'}`}>{s.warehouse ? 'On' : 'Off'}</span></td>
              <td>{whKeys} of {s.keys.length} with stored data</td>
              <td>{saved} of {s.keys.length} saved</td>
              <td>{saved === s.keys.length ? 'Mapped' : saved ? 'Partly reviewed' : 'Default map (review)'}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <div className="source-summary-grid">
        {sources.map(s => (
          <article key={s.connection} className="source-summary-card">
            <header><div><h4>{s.connection}</h4><p>{s.type} connector · {s.categories.map(c => (c === 'instrument' ? 'Instrument' : 'Reference')).join(' and ')} · {s.keys.length} mapped request{s.keys.length === 1 ? '' : 's'}{s.error ? ` · last error: ${s.error.slice(0, 80)}` : ''}</p></div>
              <button type="button" className="secondary-action" onClick={() => onConfigure(s.connection)}>Configure source</button></header>
            <div className="source-summary-table-wrap"><table className="source-summary-table">
              <thead><tr><th>Request</th><th>Response key</th><th>Site category</th><th>Format</th><th>Destination</th><th>Tags</th><th>Map</th></tr></thead>
              <tbody>{s.keys.map(k => (
                <tr key={k.key}><td>{k.map.request || k.key}</td><td>{k.key}</td><td>{place(k)}</td><td>{k.map.format}</td><td>{k.map.store}</td>
                  <td>{k.map.tags.join(', ') || '—'}</td><td>{k.map.saved ? 'Saved' : 'Default'}</td></tr>
              ))}</tbody>
            </table></div>
          </article>
        ))}
      </div>
      <p className="source-summary-note">Endpoint counts are the request keys configured for each source, not live provider availability; Warehouse endpoints count keys that already have stored data.
        Source maps place each request&apos;s data in the Recorder and Warehouse trees.</p>
    </section>
  );
}

function MapBuilder({ sources, provider, setProvider, onSaved, rainbow }: {
  sources: DhSource[]; provider: string; setProvider: (c: string) => void; onSaved: () => void; rainbow: boolean;
}) {
  const src = sources.find(s => s.connection === provider) ?? sources[0];
  const [key, setKey] = useState(src?.keys[0]?.key ?? '');
  const k = src?.keys.find(x => x.key === key) ?? src?.keys[0];
  const [form, setForm] = useState(k ? { ...k.map, tags: k.map.tags.join(', ') } : null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setKey(src?.keys[0]?.key ?? ''); }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (k) setForm({ ...k.map, tags: k.map.tags.join(', ') }); setMsg(''); }, [k?.key, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!form || !k) return;
    setBusy(true); setMsg('');
    try {
      await post({ action: 'map_save', connection: src.connection, key: k.key, ...form, tags: form.tags.split(',') });
      setMsg(`Saved ${src.connection} ${k.key} to the ${src.connection} source map. The Recorder and Warehouse trees use it now.`);
      onSaved();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function reset(connection: string, keyName: string) {
    setBusy(true);
    try { await post({ action: 'map_reset', connection, key: keyName }); setMsg(`${connection} ${keyName} is back to its default map.`); onSaved(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  // the saved map as a drill table: category -> group -> request
  const mapTree: DhNode[] = useMemo(() => {
    if (!src) return [];
    const cats = new Map<string, Map<string, DhSourceKey[]>>();
    for (const x of src.keys) {
      const c = x.map.category === 'instrument' ? 'Instrument' : 'Reference';
      const g = x.map.category === 'instrument' ? `${x.map.group === 'auto' ? 'By instrument' : x.map.group} / ${x.map.form}` : `${x.map.structure} / ${x.map.group}`;
      const m = cats.get(c) ?? new Map<string, DhSourceKey[]>();
      m.set(g, [...(m.get(g) ?? []), x]);
      cats.set(c, m);
    }
    return [...cats].map(([c, groups]) => ({
      id: `map/${c}`, label: c, tags: [], count: [...groups.values()].reduce((n, l) => n + l.length, 0),
      children: [...groups].map(([g, keys]) => ({
        id: `map/${c}/${g}`, label: g, tags: [], count: keys.length,
        children: keys.map(x => ({ id: `map/${src.connection}/${x.key}`, label: `${x.key}`, source: src.connection, format: x.map.format, tags: [], count: 1,
          contents: `${x.map.request || x.key} → ${x.map.store}${x.map.item ? ` (item: ${x.map.item})` : ''} · tags: ${x.map.tags.join(', ') || '—'} · ${x.map.saved ? `saved${x.map.updated_by ? ` by ${x.map.updated_by}` : ''}` : 'default'}` })),
      })),
    }));
  }, [src]);

  if (!src || !form || !k) return <p className="empty-state">No sources are registered with the hub yet.</p>;
  const set = (patch: Partial<typeof form>) => setForm(f => f && { ...f, ...patch });
  return (
    <>
      <section className="agent-terminal" aria-label="Source map builder">
        <div className="panel-heading"><div><h4>Source Map Builder</h4><p>Map a source&apos;s request keys to the site&apos;s Instrument or Reference groups, choose the format and warehouse destination, and tag it.</p></div>
          <span className="terminal-badge">{k.map.saved ? 'Saved map' : 'Default suggestion'}</span></div>
        <div className="terminal-policy"><strong>Map-only configuration</strong><p>This builder describes requests, response keys, destinations, categories and tags. It does not call the provider.
          Provider API keys are kept encrypted in your account: <a className="text-action" href="/account/api-tools">Account › API Tools</a>.</p></div>
        <div className="mapping-form">
          <label>SOURCE MAP<select value={src.connection} onChange={e => setProvider(e.target.value)}>
            {sources.map(s => <option key={s.connection} value={s.connection}>{s.connection}</option>)}</select></label>
          <label>REQUEST KEY<select value={k.key} onChange={e => setKey(e.target.value)}>
            {src.keys.map(x => <option key={x.key} value={x.key}>{x.key} · {x.hooks.toLocaleString()} recordings{x.map.saved ? ' · saved' : ''}</option>)}</select></label>
          <label>CATEGORY<select value={form.category} onChange={e => set(e.target.value === 'instrument'
            ? { category: 'instrument', structure: null, group: 'auto', form: 'Spot' } : { category: 'reference', structure: 'Structured', group: 'Other', form: null })}>
            <option value="instrument">Instrument</option><option value="reference">Reference</option></select></label>
          {form.category === 'instrument' ? (<>
            <label>INSTRUMENT TYPE<select value={form.group} onChange={e => set({ group: e.target.value })}>
              {INSTRUMENT_TYPES.map(t => <option key={t} value={t}>{t === 'auto' ? 'By instrument (auto)' : t}</option>)}</select></label>
            <label>FORM<select value={form.form ?? 'Spot'} onChange={e => set({ form: e.target.value as 'Spot' | 'Future' | 'Option' })}>
              {['Spot', 'Future', 'Option'].map(f => <option key={f}>{f}</option>)}</select></label>
          </>) : (<>
            <label>STRUCTURE<select value={form.structure ?? 'Structured'} onChange={e => set({ structure: e.target.value as 'Structured' | 'Unstructured' | 'Stats' })}>
              <option>Structured</option><option>Unstructured</option><option>Stats</option></select></label>
            <label>GROUP<select value={form.group} onChange={e => set({ group: e.target.value })}>
              {[...new Set([...REFERENCE_GROUPS, form.group])].map(g => <option key={g}>{g}</option>)}</select></label>
          </>)}
          <label>FORMAT<select value={form.format} onChange={e => set({ format: e.target.value })}>{FORMATS.map(f => <option key={f}>{f}</option>)}</select></label>
          <label>DESTINATION COLUMN (WAREHOUSE STORE)<select value={form.store} onChange={e => set({ store: e.target.value as typeof form.store })}>{STORES.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>ITEM PARAMETER<input value={form.item} onChange={e => set({ item: e.target.value })} placeholder="instrument, ticker, series_id…" /></label>
          <label>REQUEST PATTERN<input value={form.request} onChange={e => set({ request: e.target.value })} placeholder="candles {instrument} {data_rate}" /></label>
          <label style={{ gridColumn: '1 / -1' }}>TAGS (COMMA-SEPARATED)<input value={form.tags} onChange={e => set({ tags: e.target.value })} placeholder="stock, technology" /></label>
        </div>
        <div className="builder-selection-bar">
          <button type="button" className="builder-action" disabled={busy} onClick={save}>Save to {src.connection} source map</button>
          {k.map.saved && <button type="button" className="secondary-action" disabled={busy} onClick={() => reset(src.connection, k.key)}>Reset to default</button>}
          <span>{k.hooks.toLocaleString()} recordings · {k.stored_series.toLocaleString()} stored series · {k.stored_rows.toLocaleString()} rows</span>
        </div>
        {msg && <p className="controller-status" role="status">{msg}</p>}
      </section>
      <div className="mapping-section">
        <div className="panel-heading"><div><h4>Saved {src.connection} source map</h4><p>Expand category and group rows to inspect each request&apos;s destination, format and tags.</p></div></div>
        <DrillTable nodes={mapTree} rainbow={rainbow} columns={{ first: 'Source map drill table',
          action: { title: 'Action', cell: n => {
            const x = src.keys.find(kk => `map/${src.connection}/${kk.key}` === n.id);
            return x?.map.saved ? <button type="button" className="secondary-action" onClick={() => reset(src.connection, x.key)}>Reset</button> : null;
          } } }} />
      </div>
    </>
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
      <MapBuilder sources={sources} provider={provider} setProvider={setProvider} onSaved={reload} rainbow={rainbow} />
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
