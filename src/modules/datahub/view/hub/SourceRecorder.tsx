'use client';

// Record from a source map: the Recorder's view of a source's drill tree (its keys, their parameters, and the values
// each parameter can take). Tick values (several per parameter), add values the tree does not list yet, and Record
// selected sends one submit_hook command per key to the Data Hub with the ticked values as a grid: every combination
// becomes one recording. The hub checks each against the connector and answers what it recorded, kept or refused.

import { useEffect, useMemo, useState } from 'react';
import DrillTable from './DrillTable';
import { api, hub, post, waitFor } from './api';
import type { DhNode } from '@/lib/datahubTypes';
import type { SourceApi } from '@/lib/datahubSources';

const VALUE = /^src\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;   // a value leaf: src/<connection>/<key>/<param>/<value>
interface Pick { key: string; param: string; value: string }
const parse = (id: string): Pick | null => {
  const m = id.match(VALUE);
  return m ? { key: m[2], param: m[3], value: decodeURIComponent(m[4]) } : null;
};
const leafId = (c: string, p: Pick) => `src/${c}/${p.key}/${p.param}/${encodeURIComponent(p.value)}`;

export default function SourceRecorder({ rainbow }: { rainbow: boolean }) {
  const [apis, setApis] = useState<SourceApi[] | null>(null);
  const [provider, setProvider] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<Pick[]>([]);
  const [add, setAdd] = useState({ key: '', param: '', value: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<{ sources: SourceApi[] }>(hub({ view: 'source_apis' })).then(r => setApis(r.sources)).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);
  const src = apis?.find(a => a.connection === provider) ?? apis?.find(a => a.mapped) ?? apis?.[0];

  // the stored tree plus the values added here
  const tree: DhNode[] = useMemo(() => {
    if (!src) return [];
    const t = JSON.parse(JSON.stringify(src.tree)) as DhNode[];
    for (const p of extra) {
      const key = t.find(n => n.label === p.key);
      const param = key?.children?.find(n => n.label === p.param);
      if (!param) continue;
      const id = leafId(src.connection, p);
      if (!param.children?.some(n => n.id === id)) {
        param.children = [{ id, label: p.value, source: src.connection, tags: [], count: 1, contents: 'added here' }, ...(param.children ?? [])];
        param.count = param.children.length;
      }
    }
    return t;
  }, [src, extra]);

  // ticked values per key and parameter, and what each key still needs
  const plan = useMemo(() => {
    const picks: Record<string, Record<string, string[]>> = {};
    for (const id of sel) {
      const p = parse(id);
      if (!p) continue;
      ((picks[p.key] ??= {})[p.param] ??= []).push(p.value);
    }
    return Object.entries(picks).map(([key, params]) => {
      const spec = src?.keys.find(k => k.key === key);
      const need = Object.keys(spec?.params ?? {});
      const missing = need.filter(p => !params[p]?.length);
      const combos = missing.length ? 0 : need.reduce((n, p) => n * params[p].length, 1);
      return { key, params, missing, combos };
    });
  }, [sel, src]);

  function select(ids: string[], checked: boolean) {
    setSel(s => {
      const n = new Set(s);
      for (const id of ids) if (parse(id)) { if (checked) n.add(id); else n.delete(id); }
      return n;
    });
  }

  function addValue() {
    if (!src || !add.key || !add.param || !add.value.trim()) return;
    const p = { key: add.key, param: add.param, value: add.value.trim() };
    setExtra(e => [...e, p]);
    setSel(s => new Set(s).add(leafId(src.connection, p)));
    setAdd(a => ({ ...a, value: '' }));
  }

  async function record() {
    if (!src) return;
    const ready = plan.filter(k => !k.missing.length);
    setBusy(true); setMsg(`Sending ${ready.reduce((n, k) => n + k.combos, 0).toLocaleString()} recordings to the Data Hub…`);
    try {
      const picks = Object.fromEntries(ready.map(k => [k.key, k.params]));
      const { control_ids } = await post<{ control_ids: Record<string, number> }>({ action: 'source_record', connection: src.connection, picks });
      const lines: string[] = [];
      for (const [key, id] of Object.entries(control_ids)) {
        const c = await waitFor(id);
        const r = (c.result ?? {}) as { submitted?: string[]; unchanged?: string[]; failed?: { hook_id: string; reason: string }[]; error?: string };
        if (c.status !== 'done') { lines.push(`${key}: ${r.error ?? 'the hub has not answered yet'}`); continue; }
        lines.push(`${key}: ${r.submitted?.length ?? 0} recording${r.submitted?.length === 1 ? '' : 's'} added, ${r.unchanged?.length ?? 0} already recorded`
          + (r.failed?.length ? `, ${r.failed.length} refused (${r.failed.slice(0, 3).map(f => `${f.hook_id}: ${f.reason}`).join('; ')}${r.failed.length > 3 ? '…' : ''})` : ''));
      }
      setMsg(lines.join('\n'));
      await post({ action: 'source_map', connection: src.connection }).catch(() => undefined);   // the map lists the new values
      setSel(new Set()); setExtra([]); await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  if (!apis) return <p className="empty-state">{msg || 'Loading source maps…'}</p>;
  if (!src) return <p className="empty-state">No sources yet: add one under Sources &gt; Configure source.</p>;
  const keySpec = src.keys.find(k => k.key === add.key);
  const total = plan.reduce((n, k) => n + k.combos, 0);
  return (
    <section className="mapping-section" aria-label="Record from a source map">
      <div className="panel-heading"><div><h4>Record from a source map</h4><p>Open a key, tick the values to record (several per parameter: every combination is one recording), add values the map does not list, then Record selected. The Data Hub checks each recording against the source&apos;s connector.</p></div></div>
      <div className="builder-selection-bar">
        <label>SOURCE<select value={src.connection} onChange={e => { setProvider(e.target.value); setSel(new Set()); setExtra([]); setMsg(''); }}>
          {apis.map(a => <option key={a.connection} value={a.connection}>{a.connection}{a.mapped ? '' : ' · not mapped'}</option>)}</select></label>
        <label>ADD A VALUE<select value={add.key} onChange={e => setAdd({ key: e.target.value, param: '', value: '' })}>
          <option value="">key…</option>{src.keys.map(k => <option key={k.key}>{k.key}</option>)}</select></label>
        <select aria-label="Parameter" value={add.param} onChange={e => setAdd(a => ({ ...a, param: e.target.value }))}>
          <option value="">parameter…</option>{Object.keys(keySpec?.params ?? {}).map(p => <option key={p}>{p}</option>)}</select>
        <input aria-label="Value" value={add.value} onChange={e => setAdd(a => ({ ...a, value: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addValue(); }} placeholder="EUR_USD, AAPL, UNRATE…" />
        <button type="button" className="secondary-action" disabled={!add.key || !add.param || !add.value.trim()} onClick={addValue}>Add</button>
      </div>
      {src.mapped
        ? <DrillTable nodes={tree} rainbow={rainbow} selectable selected={sel} onSelect={select} columns={{ first: `${src.connection}: key · parameter · value` }} />
        : <p className="empty-state">{src.connection} has no map yet: map it under Sources &gt; Configure source.</p>}
      <div className="builder-selection-bar">
        <button type="button" className="builder-action" disabled={busy || !total} onClick={record}>Record selected</button>
        <span>{plan.length ? plan.map(k => (k.missing.length ? `${k.key}: choose ${k.missing.join(' and ')}` : `${k.key}: ${k.combos.toLocaleString()} recording${k.combos === 1 ? '' : 's'}`)).join(' · ') : 'Nothing ticked yet.'}</span>
      </div>
      {msg && <p className="controller-status" role="status" style={{ whiteSpace: 'pre-line' }}>{msg}</p>}
    </section>
  );
}
