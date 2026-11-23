'use client';

// Warehouse: what is stored. Summary = the Data Viewer (search by tags, drill source -> group -> item; an item opens
// to its stored rates with their date intervals; option chains open to contract months and strikes; preview or
// download any stored series). Controller = storage, datasets for training, and recent source errors.

import { useCallback, useEffect, useMemo, useState } from 'react';
import DrillTable from './DrillTable';
import { Filters, TagHelp } from './Recorder';
import { api, hub } from './api';
import { countItems, filterTree, parseTagQuery, ymd, type DhCategory, type DhNode, type DhSource, type DhStored } from '@/lib/datahubTypes';

type Cat = DhCategory | 'all';

const rateLabel = (s: DhStored) => s.rate ?? ([s.part, s.field].filter(Boolean).join(' · ') || s.store.replace('wh_', ''));

function intervalRows(n: DhNode): DhNode[] | null {
  // only an item opens to its rates: a rate row (id item#series) is the end of the tree, not another item
  if (!n.stored?.length || n.id.startsWith('opt/') || n.id.includes('#')) return null;
  return n.stored.map(s => ({
    id: `${n.id}#${s.series_id}`, label: `${rateLabel(s)} · ${ymd(s.first)}:${ymd(s.last)}`, tags: [], count: 1,
    format: s.store === 'options' ? 'Option chains' : n.format, contents: `${s.rows.toLocaleString()} rows stored`, stored: [s],
  }));
}

export function Preview({ s, onClose }: { s: DhStored; onClose: () => void }) {
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ columns: string[]; rows: Record<string, unknown>[] }>(`/api/admin/datahub/streams/rows?series_id=${s.series_id}&limit=50`).then(setData).catch(e => setErr(e.message));
  }, [s.series_id]);
  return (
    <div className="dhx-preview" aria-label="Newest stored rows">
      <div className="panel-heading"><div><h4>Newest 50 rows · series {s.series_id} ({rateLabel(s)})</h4><p>Times are UTC.</p></div>
        <button type="button" className="secondary-action" onClick={onClose}>Close</button></div>
      {err ? <p className="dhx-err">{err}</p> : !data ? <p className="empty-state">Loading…</p> : (
        <div className="dhx-scroll"><table className="source-summary-table dhx-mono">
          <thead><tr>{data.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{data.rows.map((r, i) => <tr key={i}>{data.columns.map(c => <td key={c}>{typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]).slice(0, 160) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

function RatesDialog({ n, onClose }: { n: DhNode; onClose: () => void }) {
  return (
    <div className="dhx-modal" role="dialog" aria-modal="true" aria-labelledby="dhx-stored-title" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="rate-picker-dialog dhx-dialog"><div className="rate-picker-form">
        <div className="rate-picker-heading">
          <div><h4 id="dhx-stored-title">Stored recording rates</h4><p>{n.label} · Warehouse rates are view-only. Change what is recorded in the Recorder.</p></div>
          <button type="button" className="rate-picker-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="rate-picker-options rate-picker-options--stored">
          {(n.stored ?? []).map(s => <label key={s.series_id}><input type="checkbox" checked disabled /> {rateLabel(s)} · {ymd(s.first)}:{ymd(s.last)} · {s.rows.toLocaleString()} rows</label>)}
        </div>
        <button type="button" className="builder-action" onClick={onClose}>Done</button>
      </div></div>
    </div>
  );
}

function DataViewer({ sources, rainbow, setRainbow }: { sources: DhSource[]; rainbow: boolean; setRainbow: (b: boolean) => void }) {
  const [cat, setCat] = useState<Cat>('all');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [tree, setTree] = useState<DhNode[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DhStored | null>(null);
  const [ratesOf, setRatesOf] = useState<DhNode | null>(null);

  useEffect(() => {
    setTree(null); setErr('');
    api<{ tree: DhNode[] }>(hub({ view: 'warehouse', category: cat, source })).then(d => setTree(d.tree)).catch(e => setErr(e.message));
  }, [cat, source]);
  const shown = useMemo(() => filterTree(tree ?? [], parseTagQuery(search)), [tree, search]);
  const loadOptions = useCallback(async (n: DhNode) => {
    const s = n.stored?.find(x => x.store === 'options');
    if (!s) return [];
    return (await api<{ tree: DhNode[] }>(hub({ view: 'options', series_id: String(s.series_id) }))).tree;
  }, []);

  // every stored series under the selection, for download
  const chosenSeries = useMemo(() => {
    const out: DhStored[] = [];
    const visit = (ns: DhNode[]) => ns.forEach(n => { if (n.children?.length) visit(n.children); else if (sel.has(n.id) && n.stored) out.push(...n.stored); });
    visit(shown);
    return out;
  }, [shown, sel]);
  const allIds = useMemo(() => { const ids: string[] = []; const v = (ns: DhNode[]) => ns.forEach(n => (n.children?.length ? v(n.children) : ids.push(n.id))); v(shown); return ids; }, [shown]);
  const select = (ids: string[], on: boolean) => setSel(s => { const t = new Set(s); for (const id of ids) { if (on) t.add(id); else t.delete(id); } return t; });

  function download() {
    chosenSeries.slice(0, 20).forEach((s, i) => setTimeout(() => {
      const a = document.createElement('a');
      a.href = `/api/admin/datahub/streams/rows?series_id=${s.series_id}&format=csv`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    }, i * 400));
  }

  return (
    <section className="panel" aria-label="Warehouse summary">
      <div className="panel-heading"><div><h3>Warehouse Data Viewer</h3><p>Search recorded data by tags, then expand sources and items to inspect their stored rates and date intervals.</p></div></div>
      <div className="summary-overview-heading"><h4>Current view</h4>
        <span>{cat === 'all' ? 'All data' : cat === 'instrument' ? 'Instrument data' : 'Reference data'} · {source === 'all' ? 'All sources' : source}</span></div>
      <div className="summary-cards">
        <div className="summary-stat"><span>Top-level groups</span><strong>{shown.length}</strong></div>
        <div className="summary-stat"><span>Matching items</span><strong>{countItems(shown).toLocaleString()}</strong></div>
        <div className="summary-stat"><span>Available sources</span><strong>{sources.filter(s => s.warehouse && (cat === 'all' || s.categories.includes(cat))).length}</strong></div>
      </div>
      <div className="table-view-controls">
        <label className="select-all-control"><input type="checkbox" checked={allIds.length > 0 && allIds.every(id => sel.has(id))}
          onChange={e => select(allIds, e.target.checked)} /> Select all data in this view</label>
        <label className="rainbow-toggle"><input type="checkbox" checked={rainbow} onChange={e => setRainbow(e.target.checked)} /> Rainbow drill colors</label>
        <button type="button" className="secondary-action" disabled={!chosenSeries.length} onClick={download}
          title="Downloads up to 20 series as CSV files">Download selected ({Math.min(20, chosenSeries.length)} CSV)</button>
      </div>
      <div className="warehouse-table-filters">
        <Filters cat={cat} setCat={setCat} source={source} setSource={setSource} sources={sources.filter(s => s.warehouse)} allLabel="All data" search={search} setSearch={setSearch} />
        <TagHelp />
      </div>
      {err && <p className="dhx-err">{err}</p>}
      {!tree && !err ? <p className="empty-state">Loading the warehouse inventory…</p> : (
        <DrillTable nodes={shown} rainbow={rainbow} selectable selected={sel} onSelect={select} loadChildren={loadOptions} expandLeaves={intervalRows}
          columns={{ first: 'Warehouse drill table',
            rate: { title: 'Recording frequency', cell: n => (n.stored?.length && n.count === 1 && !n.id.includes('#') && !n.id.startsWith('opt/')
              ? <button type="button" className="rate-picker-button" onClick={() => setRatesOf(n)} aria-label={`View stored rates for ${n.label}`}>
                <span>{[...new Set(n.stored.map(rateLabel))].join(', ')}</span><small>View</small></button>
              : n.children?.length || n.lazy ? null : <span className="rate-cell-empty">—</span>) },
            action: { title: 'Data', cell: n => (n.stored?.length === 1 && (n.id.includes('#') || n.id.startsWith('opt/') || n.stored[0].store !== 'options')
              ? <span className="dhx-acts">
                  <button type="button" className="secondary-action" onClick={() => setPreview(n.stored![0])}>Preview</button>
                  <a className="secondary-action" href={`/api/admin/datahub/streams/rows?series_id=${n.stored[0].series_id}&format=csv`} download>CSV</a>
                </span> : null) } }} />
      )}
      {preview && <Preview s={preview} onClose={() => setPreview(null)} />}
      {ratesOf && <RatesDialog n={ratesOf} onClose={() => setRatesOf(null)} />}
    </section>
  );
}

interface DatasetRow { id: string; title: string; status: 'available' | 'partial' | 'not recorded'; rows: number; first: string | null; last: string | null; note: string }
interface Glance { errors: { at: string; connection: string; hook_id: string; stage: string; problem: string }[]; database_size: string | null }

function WarehouseController() {
  const [sym, setSym] = useState('');
  const [rows, setRows] = useState<DatasetRow[] | null>(null);
  const [glance, setGlance] = useState<Glance | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Glance>('/api/admin/datahub').then(setGlance).catch(() => {}); }, []);
  useEffect(() => {
    const s = sym.trim().toUpperCase();
    if (!s) { setRows(null); return; }
    let stale = false;
    const t = setTimeout(() => api<{ datasets: DatasetRow[] }>(`/api/admin/datahub/datasets?symbol=${encodeURIComponent(s)}`)
      .then(d => { if (!stale) { setRows(d.datasets); setErr(''); } }).catch(e => { if (!stale) setErr(e.message); }), 250);
    return () => { stale = true; clearTimeout(t); };
  }, [sym]);
  const STATUS: Record<DatasetRow['status'], string> = { available: 'is-on', partial: 'is-warn', 'not recorded': 'is-off' };
  return (
    <section className="panel" aria-label="Warehouse controller">
      <div className="panel-heading"><div><h3>Warehouse Controller</h3><p>Check what the warehouse holds for training, and what failed to arrive.</p></div></div>
      <div className="terminal-policy"><strong>Ingester agent</strong><p>Not connected yet. Data reaches the warehouse only through the Recorder&apos;s sources;
        nothing here changes stored data.{glance?.database_size ? ` Database size: ${glance.database_size}.` : ''}</p></div>
      <div className="mapping-section">
        <div className="panel-heading"><div><h4>Datasets for training</h4><p>The tables built from stored series: fundamentals with rolling ratios, earnings estimates with SUE, and filing text.</p></div></div>
        <label className="builder-search">SYMBOL<input className="builder-input" value={sym} onChange={e => setSym(e.target.value)} placeholder="MSFT, AAPL…" /></label>
        {err && <p className="dhx-err">{err}</p>}
        {rows && (
          <div className="source-summary-table-wrap"><table className="source-summary-table">
            <thead><tr><th>Dataset</th><th>Status</th><th>Rows</th><th>First</th><th>Last</th><th>Notes</th></tr></thead>
            <tbody>{rows.map(d => (
              <tr key={d.id}><td>{d.title}</td><td><span className={`endpoint-status ${STATUS[d.status]}`}>{d.status}</span></td>
                <td>{d.rows.toLocaleString()}</td><td>{d.first ?? '–'}</td><td>{d.last ?? '–'}</td>
                <td>{d.note}{d.id === 'fundamentals' && d.status === 'available' && <> · <a className="text-action" href={`/api/admin/datahub/datasets/csv?symbol=${encodeURIComponent(sym.trim().toUpperCase())}&dataset=fundamentals`} download>CSV</a></>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="mapping-section">
        <div className="panel-heading"><div><h4>Recent source errors</h4><p>Data that failed the warehouse&apos;s checks on its way in.</p></div></div>
        {!glance ? <p className="empty-state">Loading…</p> : !glance.errors.length ? <p className="empty-state">No recent source errors.</p> : (
          <div className="source-summary-table-wrap"><table className="source-summary-table">
            <thead><tr><th>When</th><th>Source</th><th>Recording</th><th>Stage</th><th>Problem</th></tr></thead>
            <tbody>{glance.errors.map((e, i) => <tr key={i}><td>{new Date(e.at).toLocaleString()}</td><td>{e.connection}</td><td>{e.hook_id}</td><td>{e.stage}</td><td>{e.problem}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}

export default function Warehouse({ panel, sources, rainbow, setRainbow }: { panel: 'summary' | 'controller'; sources: DhSource[]; rainbow: boolean; setRainbow: (b: boolean) => void }) {
  return panel === 'summary' ? <DataViewer sources={sources} rainbow={rainbow} setRainbow={setRainbow} /> : <WarehouseController />;
}
