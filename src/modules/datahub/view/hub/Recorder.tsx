'use client';

// Recorder: what the hub records. Summary = the drill table of everything it is set to record, with recording
// controls (select items, record or pause them, add or remove data rates). Controller = the Recorder Registry
// (saved recording lists) and the Source Bundle Maker (build a named, source-specific list from the catalog).

import { useCallback, useEffect, useMemo, useState } from 'react';
import SourceRecorder from './SourceRecorder';
import DrillTable, { leafIds } from './DrillTable';
import { api, hub, listCommand, lists, post, type HubList } from './api';
import { rateName, sourceName } from '@/lib/datahubNames';
import { ALL_RATES, DEFAULT_RATES, countItems, filterTree, fmtInterval, parseTagQuery, type DhCategory, type DhNode, type DhSource } from '@/lib/datahubTypes';

type Cat = DhCategory | 'all';

function walk(nodes: DhNode[], f: (n: DhNode) => void) { for (const n of nodes) { f(n); if (n.children) walk(n.children, f); } }
function leavesOf(nodes: DhNode[]): DhNode[] { const out: DhNode[] = []; walk(nodes, n => { if (n.item) out.push(n); }); return out; }

export function Filters({ cat, setCat, source, setSource, sources, allLabel, search, setSearch, searchLabel }: {
  cat: Cat; setCat: (c: Cat) => void; source: string; setSource: (s: string) => void; sources: DhSource[];
  allLabel: string; search?: string; setSearch?: (s: string) => void; searchLabel?: string;
}) {
  const list = sources.filter(s => cat === 'all' || s.categories.includes(cat));
  return (
    <div className="filter-row">
      <label className="filter-control">CATEGORY
        <select value={cat} onChange={e => setCat(e.target.value as Cat)} aria-label="Data category">
          <option value="all">{allLabel}</option><option value="instrument">Instrument</option><option value="reference">Reference</option>
        </select>
      </label>
      <label className="filter-control">SOURCE
        <select value={list.some(s => s.connection === source) ? source : 'all'} onChange={e => setSource(e.target.value)} aria-label="Data source">
          <option value="all">All sources</option>
          {list.map(s => <option key={s.connection} value={s.connection}>{sourceName(s.connection)}</option>)}
        </select>
      </label>
      {setSearch && (
        <label className="filter-control warehouse-search-control">{searchLabel ?? 'TAG SEARCH'}
          <input className="builder-input" type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder='# stock option !# future # technology "Apple Inc."' aria-describedby="dhx-tag-help" />
        </label>
      )}
    </div>
  );
}

export function TagHelp() {
  return (
    <p id="dhx-tag-help" className="tag-query-example">Use <code>#</code> for included tags and <code>!#</code> for excluded tags, switching as often as you like;
      separate tags with spaces or commas and quote text phrases. Example: <code># stock option !# future # technology</code></p>
  );
}

function stateOf(n: DhNode): { label: string; cls: string } {
  const hooks = n.item?.hooks ?? [];
  const on = hooks.filter(h => h.enabled);
  if (!on.length) return { label: 'Paused', cls: 'is-off' };
  if (on.some(h => h.status && h.status !== 'ok')) return { label: 'Failing', cls: 'is-bad' };
  return { label: 'Recording', cls: 'is-on' };
}

/** The Rates cell: the rates being recorded (or the item's state when it has no rate); opens the checklist. */
function RateCell({ n, onOpen }: { n: DhNode; onOpen: (n: DhNode) => void }) {
  if (!n.item) return null;
  const st = stateOf(n);
  const on = n.item.hooks.filter(h => h.enabled && h.rate).map(h => h.rate!);
  const label = n.item.allowed.length ? (on.length ? on.join(', ') : 'Off') : st.label;
  return (
    <button type="button" className={`rate-picker-button ${st.cls}`} onClick={() => onOpen(n)} aria-label={`Recording rates for ${n.label}`}
      title={n.item.hooks.find(h => h.error)?.error ?? ''}>
      <span>{label}</span><small>Choose</small>
    </button>
  );
}

const RECORD = 'Record';   // the one box of an item that has no data rate (a FRED series, a filing feed, a book)

/** The checklist of an item's data rates, every frequency listed. A ticked rate is a recording job that is on, an
 *  unticked one is off: unticking switches that job off (its data stays), ticking switches it back on, and ticking a
 *  rate the source can record but nothing records yet adds it (the hub test-fetches it first). Rates the item can't
 *  record are greyed out. An item without data rates has one box: Record. */
function RateDialog({ n, onClose, onSaved }: { n: DhNode; onClose: () => void; onSaved: (msg: string) => void }) {
  const item = n.item!;
  const rated = item.allowed.length > 0;
  const hookOf = (r: string) => item.hooks.filter(h => (rated ? h.rate === r : true));
  const isOn = (r: string) => hookOf(r).some(h => h.enabled);
  const choices = rated ? ALL_RATES : [RECORD];
  const current = new Set(choices.filter(isOn));
  const [pick, setPick] = useState(new Set(current));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const why = (r: string): string => {
    if (!rated) return item.hooks.every(h => h.disabled_by) ? `Off: ${item.hooks[0]?.disabled_by}` : '';
    const hs = hookOf(r);
    if (hs.length) return hs.every(h => !h.enabled && h.disabled_by) ? `Off: ${hs[0].disabled_by}` : '';
    if (!item.allowed.includes(r)) return `${item.connection} ${item.key} doesn't record ${r}`;
    return item.changeable ? '' : 'Set by the hub';
  };
  async function save() {
    const enable = choices.filter(r => pick.has(r) && !current.has(r)).flatMap(r => hookOf(r).filter(h => !h.enabled && !h.disabled_by).map(h => h.hook_id));
    const disable = choices.filter(r => !pick.has(r) && current.has(r)).flatMap(r => hookOf(r).filter(h => h.enabled).map(h => h.hook_id));
    const add = rated ? [...pick].filter(r => !current.has(r) && !hookOf(r).length) : [];
    if (!enable.length && !disable.length && !add.length) { onClose(); return; }
    setBusy(true); setErr('');
    try {
      let queued = 0;
      if (enable.length) queued += (await post<{ queued: number }>({ action: 'hooks', op: 'enable', hook_ids: enable })).queued;
      if (disable.length) queued += (await post<{ queued: number }>({ action: 'hooks', op: 'disable', hook_ids: disable })).queued;
      if (add.length) queued += (await post<{ queued: number }>({ action: 'rates', items: [{ connection: item.connection, key: item.key, param: item.param, value: item.value }], add, remove: [] })).queued;
      onSaved(`${n.label}: ${queued} change${queued === 1 ? '' : 's'} sent to the recorder${add.length ? ' (new rates are test-fetched before they record)' : ''}.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const every = item.hooks.find(h => h.enabled)?.every ?? item.hooks[0]?.every;
  return (
    <div className="dhx-modal" role="dialog" aria-modal="true" aria-labelledby="dhx-rate-title" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="rate-picker-dialog dhx-dialog">
        <div className="rate-picker-form">
          <div className="rate-picker-heading">
            <div><h4 id="dhx-rate-title">Recording rates</h4><p>{n.label} · {item.connection} {item.key}{rated
              ? ` records ${item.allowed.join(', ')}; the rest are greyed out`
              : ` has no data rate${every ? `; it checks every ${fmtInterval(every)}` : ''}`}</p></div>
            <button type="button" className="rate-picker-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="rate-picker-options rate-picker-options--cards">
            {choices.map(r => {
              const off = why(r);
              return (
                <label key={r} className={pick.has(r) ? 'is-selected' : ''} title={off}>
                  <input type="checkbox" checked={pick.has(r)} disabled={!!off}
                    onChange={e => setPick(p => { const t = new Set(p); if (e.target.checked) t.add(r); else t.delete(r); return t; })} />
                  {r}{rateName(r) && rateName(r) !== r ? <small className="rate-name"> {rateName(r)}</small> : null}{off.startsWith('Off:') ? ' (off)' : ''}
                </label>
              );
            })}
          </div>
          <p className="capture-rate-summary">Recording now: <strong>{[...current].join(', ') || 'nothing'}</strong>. A ticked box is a recording job that is on;
            untick it to switch that job off (its stored data stays).{!item.changeable && rated ? ' Option chains record at most every 4 hours: the 4-hour snapshot and the daily full chain.' : ''}</p>
          {err && <p className="dhx-err">{err}</p>}
          <button type="button" className="builder-action" disabled={busy} onClick={save}>{busy ? 'Sending…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function RecorderSummary({ sources, rainbow, setRainbow, running, initialSource }: { sources: DhSource[]; rainbow: boolean; setRainbow: (b: boolean) => void; running: boolean; initialSource?: string }) {
  // opened from Home on one source: show everything it records, in both categories
  const [cat, setCat] = useState<Cat>(initialSource ? 'all' : 'instrument');
  const [source, setSource] = useState(initialSource ?? 'all');
  const [search, setSearch] = useState('');
  const [tree, setTree] = useState<DhNode[] | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rates, setRates] = useState<Set<string>>(new Set(DEFAULT_RATES));   // owner, Nov 16: 4-hour and daily ticked
  const [rateNode, setRateNode] = useState<DhNode | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr('');
    api<{ tree: DhNode[] }>(hub({ view: 'recorder', category: cat, source })).then(d => setTree(d.tree)).catch(e => setErr(e.message));
  }, [cat, source]);
  useEffect(() => { setTree(null); load(); }, [load]);

  const q = useMemo(() => parseTagQuery(search), [search]);
  const shown = useMemo(() => filterTree(tree ?? [], q), [tree, q]);
  const allLeaves = useMemo(() => leavesOf(shown), [shown]);
  const chosen = useMemo(() => allLeaves.filter(n => sel.has(n.id)), [allLeaves, sel]);
  const viewRates = ALL_RATES;   // every frequency listed; items that can't record a rate skip it
  const recordingCount = allLeaves.filter(n => n.item?.hooks.some(h => h.enabled)).length;
  const recordingInView = allLeaves.length > 0 && recordingCount === allLeaves.length;
  const capturedRates = [...new Set(chosen.flatMap(n => n.item?.hooks.filter(h => h.enabled && h.rate).map(h => h.rate!) ?? []))];

  const select = (ids: string[], on: boolean) => setSel(s => { const t = new Set(s); for (const id of ids) { if (on) t.add(id); else t.delete(id); } return t; });

  async function hooksOp(op: 'enable' | 'disable' | 'run', nodes: DhNode[], label: string) {
    const ids = nodes.flatMap(n => n.item?.hooks.map(h => h.hook_id) ?? []);
    if (!ids.length) return;
    if (op === 'disable' && ids.length > 50 && !window.confirm(`Pause ${ids.length.toLocaleString()} recordings (${label})?`)) return;
    setBusy(true); setMsg('');
    try {
      const r = await post<{ queued: number; kept_off: number }>({ action: 'hooks', op, hook_ids: ids });
      setMsg(`${r.queued.toLocaleString()} recording${r.queued === 1 ? '' : 's'} ${op === 'run' ? 'queued to run now' : op === 'enable' ? 'set to record' : 'paused'}`
        + `${r.kept_off ? `; ${r.kept_off} stay off (the hub switched them off for a reason)` : ''}. The recorder applies it within a minute.`);
      setTimeout(load, 8000);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function ratesOp(add: boolean) {
    if (!chosen.length || !rates.size) return;
    setBusy(true); setMsg('');
    try {
      const items = chosen.filter(n => n.item?.changeable).map(n => ({ connection: n.item!.connection, key: n.item!.key, param: n.item!.param, value: n.item!.value }));
      const r = await post<{ queued: number; skipped: number; note?: string }>({ action: 'rates', items, add: add ? [...rates] : [], remove: add ? [] : [...rates] });
      setMsg(r.note ?? `${r.queued.toLocaleString()} rate change${r.queued === 1 ? '' : 's'} sent to the recorder${r.skipped ? `; ${r.skipped} item(s) have no data rate` : ''}.`);
      setTimeout(load, 8000);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-label="Recorder summary">
      <div className="panel-heading"><div><h3>Recorder Summary</h3><p>Everything the Data Hub is set to record. Choose a category and source, then expand a row to drill into its contents.</p></div></div>
      <div className="summary-overview-heading"><h4>Current view</h4>
        <span>{cat === 'all' ? 'Instrument + Reference' : cat === 'instrument' ? 'Instrument data' : 'Reference data'} · {source === 'all' ? 'All sources' : source}</span></div>
      <div className="summary-cards">
        <div className="summary-stat"><span>Top-level groups</span><strong>{shown.length}</strong></div>
        <div className="summary-stat"><span>Items in view</span><strong>{countItems(shown).toLocaleString()}</strong></div>
        <div className="summary-stat"><span>Available sources</span><strong>{sources.filter(s => cat === 'all' || s.categories.includes(cat)).length}</strong></div>
      </div>
      <section className="recorder-tools" aria-label="Recording controls">
        <div className="recorder-tools-heading">
          <div><h4>Recording controls</h4><p>Choose what to record and how often. These controls apply to this table.</p></div>
          <span className={`recording-status${running ? ' is-running' : ''}`}>{running ? 'Recorder running' : 'Recorder not running'}</span>
        </div>
        <div className="recorder-filter-row">
          <Filters cat={cat} setCat={setCat} source={source} setSource={setSource} sources={sources} allLabel="Both" search={search} setSearch={setSearch} searchLabel="FIND" />
        </div>
        <div className="recorder-control-row">
          <label className="select-all-control">
            <input type="checkbox" checked={allLeaves.length > 0 && chosen.length === allLeaves.length}
              onChange={e => select(allLeaves.map(n => n.id), e.target.checked)} /> Select all items in this view
          </label>
          <div className="recorder-master">
            <div><strong>Master recording</strong><small><b>{recordingCount.toLocaleString()} of {allLeaves.length.toLocaleString()}</b> items in this view recording. The switch records or pauses all of them.</small></div>
            <button className="switch" type="button" role="switch" aria-checked={recordingInView} disabled={busy || !allLeaves.length}
              aria-label={recordingInView ? 'Pause every item in this view' : 'Record every item in this view'}
              onClick={() => hooksOp(recordingInView ? 'disable' : 'enable', allLeaves, 'every item in this view')} />
          </div>
          <details className="frequency-dropdown">
            <summary>Data rates <span className="frequency-count">{rates.size} of {viewRates.length} selected</span></summary>
            <div className="frequency-options">
              <label className="frequency-master-option"><input type="checkbox" checked={viewRates.length > 0 && rates.size === viewRates.length}
                onChange={e => setRates(e.target.checked ? new Set(viewRates) : new Set())} /> All data rates</label>
              {viewRates.map(r => <label key={r}><input type="checkbox" checked={rates.has(r)}
                onChange={e => setRates(s => { const t = new Set(s); if (e.target.checked) t.add(r); else t.delete(r); return t; })} /> {r}</label>)}
              {!viewRates.length && <small className="form-help">No item in view has a data rate.</small>}
            </div>
          </details>
        </div>
        <div className="builder-selection-bar">
          <span>{chosen.length.toLocaleString()} selected</span>
          <button type="button" className="builder-action" disabled={busy || !chosen.length} onClick={() => hooksOp('enable', chosen, 'selected')}>Record selected</button>
          <button type="button" className="secondary-action" disabled={busy || !chosen.length} onClick={() => hooksOp('disable', chosen, 'selected')}>Pause selected</button>
          <button type="button" className="secondary-action" disabled={busy || !chosen.length} onClick={() => hooksOp('run', chosen, 'selected')}>Run now</button>
          <button type="button" className="secondary-action" disabled={busy || !chosen.length || !rates.size} onClick={() => ratesOp(true)}>Add checked rates</button>
          <button type="button" className="secondary-action" disabled={busy || !chosen.length || !rates.size} onClick={() => ratesOp(false)}>Remove checked rates</button>
        </div>
        <p className="capture-rate-summary" role="status" aria-live="polite">
          <strong>{chosen.length.toLocaleString()} item{chosen.length === 1 ? '' : 's'} selected</strong> · Rates: {capturedRates.length ? capturedRates.join(', ') : 'none'}
          {' · '}{running ? (chosen.length ? 'Recording these rates' : 'Choose items to change what is recorded') : 'Changes wait until the recorder runs'}
        </p>
        {msg && <p className="controller-status" role="status">{msg}</p>}
      </section>
      <div className="table-view-controls">
        <label className="rainbow-toggle"><input type="checkbox" checked={rainbow} onChange={e => setRainbow(e.target.checked)} /> Rainbow drill colors</label>
        <TagHelp />
      </div>
      {err && <p className="dhx-err">{err}</p>}
      {!tree && !err ? <p className="empty-state">Loading what the hub records…</p> : (
        <DrillTable nodes={shown} rainbow={rainbow} selectable selected={sel} onSelect={select}
          columns={{ first: 'Drill table', rate: { title: 'Rates', cell: n => <RateCell n={n} onOpen={setRateNode} /> } }} />
      )}
      {rateNode && <RateDialog n={rateNode} onClose={() => setRateNode(null)} onSaved={m => { setMsg(m); setTimeout(load, 8000); }} />}
    </section>
  );
}

// ---- Controller: Recorder Registry and Source Bundle Maker -----------------------------------------------------------

const bundleSource = (l: HubList) => l.tags.find(t => t.startsWith('source:'))?.slice(7) ?? null;

// The Registry's tree is built by the server (datahubTree.registryTree). Sources first: source -> Instrument/Reference ->
// type or structure -> form or group -> data stream (no lists or bundles). Bundle view: the source bundles (built-in and
// saved) and the hub's recording lists. A list's source is a data source, never a consumer such as the Discord hub.
function Registry({ rainbow }: { rainbow: boolean }) {
  const [data, setData] = useState<{ lists: HubList[]; running: boolean } | null>(null);
  const [view, setView] = useState<'sources' | 'bundles'>('sources');
  const [cat, setCat] = useState<Cat>('all');
  const [tree, setTree] = useState<DhNode[] | null>(null);
  const [rateNode, setRateNode] = useState<DhNode | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => lists().then(setData).catch(e => setMsg(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const loadTree = useCallback(() => api<{ tree: DhNode[] }>(hub({ view: 'registry', order: view, category: cat }))
    .then(r => setTree(r.tree)).catch(e => setMsg(e.message)), [view, cat]);
  useEffect(() => { setTree(null); loadTree(); }, [loadTree]);

  async function record(l: HubList) {
    try {
      await listCommand({ command: 'list_edit', name: l.name, record: !l.record });
      setMsg(`${l.record ? 'Taking' : 'Putting'} ${l.name}'s symbols ${l.record ? 'off' : 'on'} the recording watchlist: the hub applies it within a minute.`);
      setData(d => d && { ...d, lists: d.lists.map(x => (x.name === l.name ? { ...x, record: !l.record } : x)) });
      setTimeout(() => { load(); loadTree(); }, 6000);
    } catch (e) { setMsg((e as Error).message); }
  }
  async function bundle(n: DhNode, b: { bundle: string; hooks: string[]; on: number; total: number }) {
    const op = b.on ? 'disable' : 'enable';
    if (op === 'disable' && b.on > 50 && !window.confirm(`Pause all ${b.on.toLocaleString()} recordings in ${b.bundle}?`)) return;
    try {
      const r = await post<{ queued: number; kept_off: number }>({ action: 'hooks', op, hook_ids: b.hooks });
      setMsg(`${b.bundle}: ${r.queued.toLocaleString()} recording${r.queued === 1 ? '' : 's'} ${op === 'enable' ? 'switched on' : 'paused'}`
        + `${r.kept_off ? `; ${r.kept_off} stay off (the hub switched them off for a reason)` : ''}. The recorder applies it within a minute.`);
      setTimeout(loadTree, 8000);
    } catch (e) { setMsg((e as Error).message); }
  }

  const byName = new Map((data?.lists ?? []).map(l => [l.name, l]));
  const switchOf = (n: DhNode) => {
    const d = n.data as { list?: string; bundle?: string; hooks?: string[]; on?: number; total?: number } | undefined;
    if (d?.bundle && d.hooks) {
      const b = { bundle: d.bundle, hooks: d.hooks, on: d.on ?? 0, total: d.total ?? 0 };
      return <button className="switch" type="button" role="switch" aria-checked={b.on > 0} aria-label={`Record ${b.bundle}`}
        title={`${b.on} of ${b.total} streams recording`} onClick={() => bundle(n, b)} />;
    }
    const l = byName.get(d?.list ?? '');
    return l ? <button className="switch" type="button" role="switch" aria-checked={l.record} aria-label={`Put ${l.name} on the watchlist`} onClick={() => record(l)} /> : null;
  };

  return (
    <section className="recorder-registry-view" aria-label="Recorder Registry">
      <div className="list-builder-heading"><div><h4>Recorder Registry</h4><p>Sources first lists every data stream by source, category and group; tick a
        stream&apos;s rates to switch its recordings on or off. Bundle view shows the source bundles and the hub&apos;s recording lists.</p></div></div>
      {data && !data.running && <p className="dhx-err">The Data Hub recorder isn&apos;t running, so changes wait until it is.</p>}
      {msg && <p className="controller-status" role="status">{msg}</p>}
      <div className="section-tabs recorder-registry-tabs" role="tablist" aria-label="Recorder Registry views">
        <button className={`section-tab${view === 'sources' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={view === 'sources'} onClick={() => setView('sources')}>Sources first</button>
        <button className={`section-tab${view === 'bundles' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={view === 'bundles'} onClick={() => setView('bundles')}>Bundle view</button>
      </div>
      <div className="filter-row">
        <label className="filter-control">CATEGORY
          <select value={cat} onChange={e => setCat(e.target.value as Cat)} aria-label="Data category">
            <option value="all">Both</option><option value="instrument">Instrument</option><option value="reference">Reference</option>
          </select>
        </label>
      </div>
      {!data || !tree ? <p className="empty-state">Loading…</p> : (
        <DrillTable nodes={tree} rainbow={rainbow} empty="Nothing recorded in this category yet."
          columns={{ first: view === 'bundles' ? 'Bundle · Category · Group · Data stream' : 'Source · Category · Group · Data stream',
            rate: { title: 'Rates', cell: n => <RateCell n={n} onOpen={setRateNode} /> },
            action: { title: 'Record', cell: n => switchOf(n) } }} />
      )}
      {rateNode && <RateDialog n={rateNode} onClose={() => setRateNode(null)} onSaved={m => { setMsg(m); setTimeout(loadTree, 8000); }} />}
    </section>
  );
}

function BundleMaker({ sources, rainbow }: { sources: DhSource[]; rainbow: boolean }) {
  const instrumentSources = sources.filter(s => s.categories.includes('instrument'));
  const [all, setAll] = useState<HubList[]>([]);
  const [bundle, setBundle] = useState('');
  const [category, setCategory] = useState<DhCategory>('instrument');
  const [source, setSource] = useState(instrumentSources[0]?.connection ?? 'yahoo');
  const [search, setSearch] = useState('');
  const [tree, setTree] = useState<DhNode[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<DhNode[]>([]);
  const [stagedSel, setStagedSel] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadLists = useCallback(() => lists().then(d => setAll(d.lists)).catch(() => {}), []);
  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => {
    if (category !== 'instrument') { setTree([]); return; }
    setTree(null);
    api<{ tree: DhNode[] }>(hub({ view: 'recorder', category: 'instrument', source })).then(d => setTree(d.tree)).catch(e => setMsg(e.message));
  }, [source, category]);

  const shown = useMemo(() => filterTree(tree ?? [], parseTagQuery(search)), [tree, search]);
  const leaves = useMemo(() => leavesOf(tree ?? []), [tree]);
  const visibleLeaves = useMemo(() => leavesOf(shown), [shown]);
  const select = (ids: string[], on: boolean) => setSel(s => { const t = new Set(s); for (const id of ids) { if (on) t.add(id); else t.delete(id); } return t; });

  // loading a bundle selects its members in the catalog and leaves the creation table empty until you add them
  function load(n: string) {
    setBundle(n); setName(n); setStaged([]); setStagedSel(new Set()); setSearch('');
    const l = all.find(x => x.name === n);
    if (!l) { setSel(new Set()); return; }
    const src = bundleSource(l);
    if (src && instrumentSources.some(s => s.connection === src)) setSource(src);
    const members = new Set(l.members.map(m => m.toUpperCase()));
    setSel(new Set(leaves.filter(x => members.has(x.label.toUpperCase())).map(x => x.id)));
  }
  useEffect(() => { if (bundle) load(bundle); }, [tree]); // eslint-disable-line react-hooks/exhaustive-deps

  function stage() {
    const add = leaves.filter(n => sel.has(n.id) && !staged.some(s => s.label === n.label));
    setStaged(s => [...s, ...add.map(n => ({ ...n, id: `stage/${n.label}`, children: undefined }))]);
  }
  const stagedTree: DhNode[] = staged.length ? [{ id: 'stage', label: `${source} · Instrument`, tags: [], count: staged.length, children: staged }] : [];

  async function save() {
    const target = name.trim();
    if (!target) { setMsg('Name the bundle, for example “Yahoo Nasdaq 100”.'); return; }
    const symbols = [...new Set(staged.map(n => n.label.toUpperCase()))];
    if (!symbols.length) { setMsg('Add items to the creation table first.'); return; }
    setBusy(true); setMsg('');
    try {
      const existing = all.find(l => l.name === target);
      if (!existing) {
        await listCommand({ command: 'list_create', name: target, symbols, tags: ['bundle', `source:${source}`], record: false });
      } else {
        const have = new Set(existing.members.map(m => m.toUpperCase()));
        const add = symbols.filter(s => !have.has(s));
        const remove = [...have].filter(s => !symbols.includes(s));
        if (add.length) await listCommand({ command: 'list_add', name: target, symbols: add });
        if (remove.length) await listCommand({ command: 'list_remove', name: target, symbols: remove });
        if (!existing.tags.includes(`source:${source}`)) await listCommand({ command: 'list_edit', name: target, tags: [...existing.tags.filter(t => !t.startsWith('source:')), 'bundle', `source:${source}`] });
      }
      setMsg(`${existing ? 'Updated' : 'Saved'} “${target}” with ${symbols.length} symbols. It appears in the Recorder Registry once the hub applies it (within a minute).`);
      setTimeout(loadLists, 6000);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="recording-list-builder" aria-label="Source Bundle Maker" onSubmit={e => { e.preventDefault(); save(); }}>
      <div className="list-builder-heading"><div><h4>Source Bundle Maker</h4><p>Create a source bundle from this catalog for Recorder use and model training. A bundle is a hub recording list tagged with its source.</p></div></div>
      <div className="source-bundle-tool-row">
        <label className="builder-field registry-list-picker">SOURCE BUNDLE
          <select className="builder-input" value={bundle} onChange={e => load(e.target.value)}>
            <option value="">New source bundle</option>
            {all.map(l => <option key={l.name} value={l.name}>{l.name} · {bundleSource(l) ?? l.kind} · {l.members.length} items</option>)}
          </select>
        </label>
        <label className="builder-field">CATEGORY
          <select className="builder-input" value={category} onChange={e => setCategory(e.target.value as DhCategory)}>
            <option value="instrument">Instrument</option><option value="reference">Reference</option>
          </select>
        </label>
        <label className="builder-field">SOURCE
          <select className="builder-input" value={source} onChange={e => setSource(e.target.value)}>
            {instrumentSources.map(s => <option key={s.connection} value={s.connection}>{s.connection}</option>)}
          </select>
        </label>
        <label className="builder-search">LIST SEARCH
          <input className="builder-input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder='Names, tickers and tags: AAPL, # stock !# etf' />
        </label>
      </div>
      {category === 'reference' ? (
        <p className="empty-state">Hub recording lists hold instrument symbols, so Reference bundles (FRED series, filings) aren&apos;t supported by the hub yet. Reference data is recorded per source in the Recorder Summary.</p>
      ) : (<>
        <div className="builder-selection-bar">
          <label className="select-all-control"><input type="checkbox" checked={visibleLeaves.length > 0 && visibleLeaves.every(n => sel.has(n.id))}
            onChange={e => select(visibleLeaves.map(n => n.id), e.target.checked)} /> Select all visible</label>
          <span>{sel.size.toLocaleString()} selected</span>
          <button type="button" className="builder-action" disabled={!sel.size} onClick={stage}>＋ Add selected to creation table</button>
        </div>
        {!tree ? <p className="empty-state">Loading the {source} catalog…</p>
          : <DrillTable nodes={shown} rainbow={rainbow} selectable selected={sel} onSelect={select} columns={{ first: 'Catalog' }} />}
        <div className="builder-draft">
          <div className="panel-heading"><div><h4>Recording Creation Table</h4><p>Review the staged members. Remove members by checking them and choosing Remove checked.</p></div></div>
          <DrillTable nodes={stagedTree} rainbow={rainbow} selectable selected={stagedSel} empty="Nothing staged yet."
            onSelect={(ids, on) => setStagedSel(s => { const t = new Set(s); for (const id of ids) { if (on) t.add(id); else t.delete(id); } return t; })}
            columns={{ first: 'Creation table' }} />
          <div className="builder-draft-selection-bar">
            <button type="button" className="secondary-action" disabled={!stagedSel.size}
              onClick={() => { setStaged(s => s.filter(n => !stagedSel.has(n.id))); setStagedSel(new Set()); }}>− Remove checked</button>
            <div className="builder-draft-save-group">
              <div className="source-bundle-save-row">
                <label className="builder-field">BUNDLE NAME<input className="builder-input" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder={`${source} Nasdaq 100`} /></label>
                <button type="submit" className="builder-action" disabled={busy || !staged.length}>{busy ? 'Saving…' : 'Save source bundle'}</button>
              </div>
            </div>
          </div>
        </div>
      </>)}
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </form>
  );
}

export default function Recorder({ panel, sources, rainbow, setRainbow, running, initialSource }: {
  panel: 'summary' | 'controller'; sources: DhSource[]; rainbow: boolean; setRainbow: (b: boolean) => void; running: boolean; initialSource?: string;
}) {
  const [view, setView] = useState<'registry' | 'builder' | 'map'>('registry');
  if (panel === 'summary') return <RecorderSummary key={initialSource ?? 'all'} sources={sources} rainbow={rainbow} setRainbow={setRainbow} running={running} initialSource={initialSource} />;
  return (
    <section className="panel" aria-label="Recorder controller">
      <div className="panel-heading"><div><h3>Recorder Controller</h3><p>Inspect the saved recording lists, build a source bundle from a source&apos;s catalog, or record from a source&apos;s map.</p></div></div>
      <div className="section-tabs recorder-controller-tabs" role="tablist" aria-label="Recorder controller views">
        <button className={`section-tab${view === 'registry' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={view === 'registry'} onClick={() => setView('registry')}>Recorder Registry</button>
        <button className={`section-tab${view === 'builder' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={view === 'builder'} onClick={() => setView('builder')}>Source Bundle Maker</button>
        <button className={`section-tab${view === 'map' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={view === 'map'} onClick={() => setView('map')}>Record from a source map</button>
      </div>
      {view === 'registry' ? <Registry rainbow={rainbow} /> : view === 'builder' ? <BundleMaker sources={sources} rainbow={rainbow} /> : <SourceRecorder rainbow={rainbow} />}
      <p className="controller-status">Recorder is {running ? 'running' : 'not running'}. Recording intervals are set per source (for example daily bars check every {fmtInterval(21600)}).</p>
    </section>
  );
}

export { leafIds };
