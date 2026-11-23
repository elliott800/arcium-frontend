'use client';

// Legacy panel (Portfolio Maker): pick a list, search and add, sort, filter, apply to an engine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAIN_CLASSES, NO_TAG_FILTER, cycleTag, tagState, type MainClass, type TagFilter } from '@/lib/instruments';
import { matchesFilter, normalizeSource, upsertFilter, type SavedFilter } from '@/lib/watchlist-logic';
import { popoverAt } from './ModelListStar';
const LIST_DRAG = 'application/x-arcium-list';     // { name, symbols } dragged from a list

// The portfolio (watchlist) manager, Webull style: pick a list, type in one box to search and add (or paste several
// symbols), a table you sort by a column and filter by asset class, ★ a symbol in or out of any list, tick several
// to remove, and Apply to the engine beside it. Paste and fund import live in the ⋯ menu. The same panel runs beside
// the portal's engines and as the Portfolios page (admins also see the Data Hub's lists, marked · Data Hub).
// A list also holds sources (fred:UNRATE, catalog:yahoo.etfs), shown apart from its assets, and other lists (then it
// is a collection, opened as one universe). Tag chips filter by must-have (+) and can't-have (-) tags; a filter is
// saved by name and loaded by name.

interface Hit { symbol: string; tags: string[]; sources: string[]; rates: string[]; bars: number; asset_class: MainClass }
interface List { name: string; symbols: string[]; kind?: string; category?: string | null; hub?: boolean; sublists?: string[]; sources?: string[] }
interface Opened { name: string; symbols: string[]; sources: string[]; lists: string[]; missing: string[]; cycles: string[] }
interface SourceList { id: string; name: string; kind: string; symbols: string[] }

const CLASS_LABEL: Record<string, string> = Object.fromEntries([...MAIN_CLASSES.map(c => [c.id, c.label]), ['other', 'Other']]);
const SHORT: Record<string, string> = { stock: 'Stock', commodity: 'Cmdty', currency: 'FX', realestate: 'RE', bond: 'Bond', crypto: 'Crypto', other: '–' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `${r.status}`);
  return d as T;
}
const splitSymbols = (t: string) => t.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

export default function WatchlistPanel({ initialList, appliedName, onApply, allowHub = false, wide = false }: {
  initialList?: string | null;
  appliedName?: string | null;                 // the list the engine beside it trades now
  onApply?: (name: string, symbols: string[]) => void;   // shown when the panel sits beside an engine
  allowHub?: boolean;                          // admins: also edit the Data Hub's lists
  wide?: boolean;                              // the Portfolios page: more columns
}) {
  const [lists, setLists] = useState<List[] | null>(null);
  const [active, setActive] = useState<string>(initialList ?? '');
  const [info, setInfo] = useState<Map<string, Hit>>(new Map());
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [cls, setCls] = useState<string>('all');
  const [sort, setSort] = useState<{ col: 'symbol' | 'class'; desc: boolean }>({ col: 'symbol', desc: false });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<'' | 'menu' | 'new' | 'rename' | 'paste' | 'fund' | 'source' | 'addlist' | 'savefilter'>('');
  const [tagF, setTagF] = useState<TagFilter>(NO_TAG_FILTER);
  const [filters, setFilters] = useState<SavedFilter[] | null>(null);
  const [filterName, setFilterName] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [text, setText] = useState('');
  const [sources, setSources] = useState<SourceList[] | null>(null);
  const [src, setSrc] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [starFor, setStarFor] = useState<string | null>(null);
  const [starBtn, setStarBtn] = useState<HTMLElement | null>(null);
  // one dropdown for both stores when an admin is signed in: each list says whether it's the Data Hub's
  const listIsHub = (name: string) => (lists ?? []).find(l => l.name === name)?.hub ?? false;
  const boxRef = useRef<HTMLDivElement>(null);
  const edits = useRef(0);                               // counts local changes
  const touched = useRef<Map<string, number>>(new Map());  // list name -> the change that last edited it here
  const touch = (name: string) => { edits.current++; touched.current.set(name, edits.current); };

  const load = useCallback(async () => {
    const at = edits.current;
    try {
      // one portfolio shape for both stores (/api/portfolios); the panel's scope picks which store's lists it shows
      const d = await api<{ portfolios: { name: string; scope: string; kind: string; category: string | null; symbols: string[]; sublists?: string[]; sources?: string[] }[] }>(
        `/api/portfolios?scope=${allowHub ? 'all' : 'mine'}`);
      const next: List[] = d.portfolios.map(p => ({ name: p.name, symbols: p.symbols, kind: p.kind, category: p.category, hub: p.scope === 'hub',
        sublists: p.sublists ?? [], sources: p.sources ?? [] }));
      // lists edited here since this load started keep their local state (present or deleted); the rest are the server's
      setLists(prev => {
        const newer = (n: string) => (touched.current.get(n) ?? 0) > at;
        return [...next.filter(l => !newer(l.name)), ...(prev ?? []).filter(l => newer(l.name))].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) { setLists(ls => ls ?? []); setMsg({ ok: false, text: (e as Error).message }); }
  }, [allowHub]);
  useEffect(() => { setLists(null); load(); }, [load]);

  const current = useMemo(() => (lists ?? []).find(l => l.name === active) ?? (lists ?? [])[0] ?? null, [lists, active]);
  const hub = !!current?.hub;                            // the open list is the Data Hub's (the hub manages its name)
  useEffect(() => { if (current && current.name !== active) setActive(current.name); }, [current, active]);
  useEffect(() => { setPicked(new Set()); setOpened(null); }, [current?.name]);

  // saved tag filters (per person)
  useEffect(() => {
    api<{ filters: SavedFilter[] }>('/api/watchlists/filters').then(d => setFilters(d.filters)).catch(() => setFilters([]));
  }, []);

  // classes and tags for the symbols in the list
  const memberKey = [...(current?.symbols ?? []), ...(opened?.symbols ?? [])].join(',');
  useEffect(() => {
    const missing = [...new Set([...(current?.symbols ?? []), ...(opened?.symbols ?? [])])].filter(s => !info.has(s));
    if (!missing.length) return;
    api<{ found: Hit[] }>('/api/instruments/resolve', { method: 'POST', body: JSON.stringify({ text: missing.slice(0, 2000).join(',') }) })
      .then(d => setInfo(m => { const n = new Map(m); for (const h of d.found ?? []) n.set(h.symbol, h); for (const s of missing) if (!n.has(s)) n.set(s, { symbol: s, tags: [], sources: [], rates: [], bars: 0, asset_class: 'other' }); return n; }))
      .catch(() => {});
  }, [memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // search as you type (one symbol); several symbols typed or pasted become a batch add
  const many = splitSymbols(q).length > 1;
  useEffect(() => {
    const term = q.trim();
    if (!term || many) { setHits([]); return; }
    let stale = false;                               // the box changed: ignore this answer
    const t = setTimeout(() => {
      api<{ instruments: Hit[] }>(`/api/instruments/search?q=${encodeURIComponent(term)}&limit=12`)
        .then(d => { if (!stale) { setHits(d.instruments); setHitIdx(0); } }).catch(() => { if (!stale) setHits([]); });
    }, 180);
    return () => { stale = true; clearTimeout(t); };
  }, [q, many]);

  async function change(name: string, add: string[], remove: string[] = [], create = false, addMembers: string[] = [], removeMembers: string[] = []) {
    touch(name);
    setBusy(true); setMsg(null);
    try {
      if (listIsHub(name)) {
        if (addMembers.length || removeMembers.length) throw new Error('Lists and sources in a Data Hub list are set by the hub itself.');
        if (create) await api('/api/admin/datahub/lists', { method: 'POST', body: JSON.stringify({ command: 'list_create', name, category: cls === 'all' ? null : CLASS_LABEL[cls] }) });
        if (add.length) await api('/api/admin/datahub/lists', { method: 'POST', body: JSON.stringify({ command: 'list_add', name, symbols: add }) });
        if (remove.length) await api('/api/admin/datahub/lists', { method: 'POST', body: JSON.stringify({ command: 'list_remove', name, symbols: remove }) });
        setMsg({ ok: true, text: 'Sent to the Data Hub: it applies within a tick or two.' });
        setTimeout(load, 4000);
      } else {
        // show the change at once; the server's answer replaces it (and a refusal puts the list back)
        setLists(ls => {
          const cur = (ls ?? []).find(l => l.name === name);
          const sym = new Set([...(cur?.symbols ?? []), ...add]);
          for (const r of remove) sym.delete(r);
          return [...(ls ?? []).filter(l => l.name !== name), { ...cur, name, symbols: [...sym] }].sort((a, b) => a.name.localeCompare(b.name));
        });
        const d = await api<{ watchlist: { watchlist_name: string; instruments: string[]; sublists?: string[]; sources?: string[] } }>('/api/watchlists/items', {
          method: 'POST', body: JSON.stringify({ watchlist_name: name, add, remove, create, add_members: addMembers, remove_members: removeMembers }),
        });
        setLists(ls => {
          const cur = (ls ?? []).find(l => l.name === name);
          if (!cur) return ls;                                       // deleted while this answer was on its way
          const next = (ls ?? []).filter(l => l.name !== name);
          return [...next, { ...cur, symbols: d.watchlist.instruments, sublists: d.watchlist.sublists ?? [], sources: d.watchlist.sources ?? [] }]
            .sort((a, b) => a.name.localeCompare(b.name));
        });
      }
      return true;
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); if (!hub) load(); return false; }
    finally { setBusy(false); }
  }

  async function addTyped(symbols: string[]) {
    if (!current || !symbols.length) return;
    setQ(''); setHits([]);                         // clear now, so typing the next one isn't wiped by this answer
    if (await change(current.name, symbols)) setMsg({ ok: true, text: symbols.length === 1 ? `Added ${symbols[0]}.` : `Added ${symbols.length} symbols.` });
  }
  async function batchFromText(t: string) {
    if (!current) return;
    setQ(''); setText(''); setMenu('');
    const d = await api<{ found: Hit[]; unknown: string[]; rejected: string[] }>('/api/instruments/resolve', { method: 'POST', body: JSON.stringify({ text: t }) });
    const add = [...(d.found ?? []).map(h => h.symbol), ...(d.unknown ?? [])];
    if (await change(current.name, add)) {
      setInfo(m => { const n = new Map(m); for (const h of d.found ?? []) n.set(h.symbol, h); return n; });
      setMsg({ ok: true, text: `Added ${add.length}${d.unknown.length ? ` (${d.unknown.length} not recorded yet: ${d.unknown.slice(0, 6).join(', ')})` : ''}${d.rejected.length ? `; skipped ${d.rejected.length} that aren't symbols` : ''}.` });
    }
  }

  // a collection opened as one universe shows the union
  const shown = useMemo(() => opened ? opened.symbols : (current?.symbols ?? []), [opened, current]);
  const allRows = useMemo(() => shown.map(s => info.get(s) ?? { symbol: s, tags: [], sources: [], rates: [], bars: 0, asset_class: 'other' as MainClass }),
    [shown, info]);
  const tagChips = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of allRows) for (const t of h.tags) if (!t.includes(':')) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of [...tagF.must, ...tagF.not]) if (!m.has(t)) m.set(t, 0);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allRows, tagF]);
  const rows = useMemo(() => {
    const r = allRows.filter(h => matchesFilter(h, tagF));
    const f = cls === 'all' ? r : r.filter(h => h.asset_class === cls);
    return [...f].sort((a, b) => {
      const d = sort.col === 'class' ? a.asset_class.localeCompare(b.asset_class) || a.symbol.localeCompare(b.symbol) : a.symbol.localeCompare(b.symbol);
      return sort.desc ? -d : d;
    });
  }, [allRows, tagF, cls, sort]);
  const classCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shown) { const c = info.get(s)?.asset_class ?? 'other'; m.set(c, (m.get(c) ?? 0) + 1); }
    return m;
  }, [shown, info]);
  const inList = useMemo(() => new Set(current?.symbols ?? []), [current]);
  const listsHolding = (s: string) => (lists ?? []).filter(l => l.symbols.includes(s)).map(l => l.name);

  // saved filters: save the chips' must-have / can't-have tags under a name, load one by name
  async function saveTagFilter(name: string) {
    name = name.trim();
    if (!name) return;
    try {
      const d = await api<{ filter: SavedFilter }>('/api/watchlists/filters', { method: 'POST', body: JSON.stringify({ name, must: tagF.must, not: tagF.not }) });
      setFilters(fs => upsertFilter(fs ?? [], d.filter)); setFilterName(d.filter.name); setMenu(''); setText('');
      setMsg({ ok: true, text: `Saved the filter "${d.filter.name}".` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function loadTagFilter(name: string) {
    setFilterName(name);
    if (!name) { setTagF(NO_TAG_FILTER); return; }
    try {
      const d = await api<{ filter: SavedFilter }>(`/api/watchlists/filters?name=${encodeURIComponent(name)}`);
      setTagF({ must: d.filter.must, not: d.filter.not });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function deleteTagFilter() {
    if (!filterName || !window.confirm(`Delete the saved filter "${filterName}"?`)) return;
    try {
      await api(`/api/watchlists/filters?name=${encodeURIComponent(filterName)}`, { method: 'DELETE' });
      setFilters(fs => (fs ?? []).filter(f => f.name !== filterName)); setFilterName('');
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  // a collection opened as one universe: the union of its symbols and sources and every list under it
  async function openUniverse() {
    if (!current) return;
    if (opened) { setOpened(null); return; }
    try {
      const d = await api<{ portfolio: { symbols: string[]; sources: string[] }; lists: string[]; missing: string[]; cycles: string[] }>(
        `/api/portfolios?open=${encodeURIComponent(`${current.hub ? 'hub' : 'mine'}:${current.name}`)}`);
      setOpened({ name: current.name, symbols: d.portfolio.symbols, sources: d.portfolio.sources, lists: d.lists, missing: d.missing, cycles: d.cycles });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function addSource(raw: string) {
    if (!current) return;
    const src = normalizeSource(raw);
    if (!src) { setMsg({ ok: false, text: 'A source is kind:id, for example fred:UNRATE or catalog:yahoo.etfs.' }); return; }
    if (await change(current.name, [], [], false, [`source:${src}`])) { setMenu(''); setText(''); setMsg({ ok: true, text: `Added the source ${src}.` }); }
  }
  async function addSublist(ref: string) {
    if (!current || !ref) return;
    if (await change(current.name, [], [], false, [`list:${ref}`])) { setMenu(''); setText(''); setOpened(null); setMsg({ ok: true, text: `"${current.name}" now holds ${ref}.` }); }
  }
  const sublistChoices = useMemo(() => {
    if (!current || current.hub) return [];
    const have = new Set(current.sublists ?? []);
    return (lists ?? []).map(l => (l.hub ? `hub:${l.name}` : l.name)).filter(r => r !== current.name && !have.has(r));
  }, [lists, current]);

  async function createList(name: string) {
    name = name.trim();
    if (!name) return;
    if (await change(name, [], [], true)) { setActive(name); setMenu(''); setText(''); if (!hub) setMsg({ ok: true, text: `Made "${name}".` }); }
  }
  async function renameList(to: string) {
    if (!current || !to.trim() || to.trim() === current.name) { setMenu(''); return; }
    try {
      await api('/api/watchlists/items', { method: 'PUT', body: JSON.stringify({ from: current.name, to: to.trim() }) });
      setActive(to.trim()); setMenu(''); setText(''); await load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function deleteList() {
    if (!current || !window.confirm(`Delete the portfolio "${current.name}"? Engines that trade it keep their current instruments.`)) return;
    try {
      const gone = current.name;
      touch(gone);
      setLists(ls => (ls ?? []).filter(l => l.name !== gone)); setActive(''); setMenu('');
      await api(`/api/watchlists/items?name=${encodeURIComponent(gone)}`, { method: 'DELETE' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); load(); }
  }
  function openFunds() {
    setMenu('fund');
    if (!sources) api<{ lists: SourceList[] }>('/api/markets/lists').then(d => setSources(d.lists)).catch(() => setSources([]));
  }
  const source = (sources ?? []).find(s => s.id === src) ?? null;
  const fundSymbol = source && source.kind === 'Fund' && /^[A-Z0-9.^-]{1,10}$/.test(source.name.toUpperCase()) ? source.name.toUpperCase() : null;

  // close the menu and star popover on Escape or an outside click
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setStarFor(null); setMenu(m => (m === 'menu' ? '' : m)); } };
    const click = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setStarFor(null); setMenu(m => (m === 'menu' ? '' : m)); } };
    const scrolled = () => setStarFor(null);              // the popover is fixed to the window; don't leave it adrift
    document.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, []);

  const head = (col: 'symbol' | 'class', label: string) => (
    <th scope="col" aria-sort={sort.col === col ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => setSort(s => ({ col, desc: s.col === col ? !s.desc : false }))}>{label}{sort.col === col ? (sort.desc ? '▾' : '▴') : ''}</button>
    </th>
  );

  return (
    <section className={`wp${wide ? ' wp--wide' : ''}`} aria-label="Portfolios" ref={boxRef}>
      <div className="wp-head">
        {menu === 'rename' ? (
          <input autoFocus className="wp-input" defaultValue={current?.name} aria-label="New name" maxLength={60}
            onKeyDown={e => { if (e.key === 'Enter') renameList(e.currentTarget.value); if (e.key === 'Escape') setMenu(''); }} onBlur={e => renameList(e.target.value)} />
        ) : menu === 'new' ? (
          <form className="wp-new" onSubmit={e => { e.preventDefault(); createList(text); }}>
            <input autoFocus className="wp-input" value={text} onChange={e => setText(e.target.value)} placeholder="New portfolio name" aria-label="New portfolio name" maxLength={hub ? 80 : 60} />
            <button type="submit" className="fx-mini" disabled={!text.trim() || busy}>Create</button>
            <button type="button" className="fx-mini" onClick={() => { setMenu(''); setText(''); }}>Cancel</button>
          </form>
        ) : (
          <select className="wp-select" value={current?.name ?? ''} onChange={e => setActive(e.target.value)} aria-label="Portfolio">
            {(lists ?? []).length === 0 && <option value="">{lists ? 'No portfolios yet' : 'Loading…'}</option>}
            {(lists ?? []).map(l => <option key={`${l.hub ? 'hub' : 'mine'}:${l.name}`} value={l.name}>{l.name} ({l.symbols.length}){l.hub ? ' · Data Hub' : ''}{l.name === appliedName ? ' · engine' : ''}</option>)}
          </select>
        )}
        {onApply && current && current.symbols.length > 0 && (
          <span className="wp-grip" draggable title={`Drag "${current.name}" onto the engine portfolio`} aria-label={`Drag ${current.name} onto the engine`}
            onDragStart={e => { e.dataTransfer.setData(LIST_DRAG, JSON.stringify({ name: current.name, symbols: current.symbols })); e.dataTransfer.setData('text/plain', current.symbols.join(',')); e.dataTransfer.effectAllowed = 'copy'; }}>⠿</span>
        )}
        <button type="button" className="fx-mini" title="New portfolio" aria-label="New portfolio" onClick={() => { setMenu('new'); setText(''); }}>+</button>
        <div className="wp-menu-wrap">
          <button type="button" className="fx-mini" aria-haspopup="menu" aria-expanded={menu === 'menu'} aria-label="More" onClick={() => setMenu(m => (m === 'menu' ? '' : 'menu'))}>⋯</button>
          {menu === 'menu' && (
            <div className="wp-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu('paste'); setText(''); }} disabled={!current}>Paste a list…</button>
              <button type="button" role="menuitem" onClick={openFunds} disabled={!current}>Add from a fund or list…</button>
              {!listIsHub(current?.name ?? '') && <button type="button" role="menuitem" onClick={() => { setMenu('source'); setText(''); }} disabled={!current}>Add a source (FRED series, catalogue)…</button>}
              {!listIsHub(current?.name ?? '') && <button type="button" role="menuitem" onClick={() => { setMenu('addlist'); setText(''); }} disabled={!current}>Add a list (make a collection)…</button>}
              <button type="button" role="menuitem" onClick={() => { setMenu('savefilter'); setText(filterName); }} disabled={!tagF.must.length && !tagF.not.length}>Save tag filter…</button>
              {!hub && <button type="button" role="menuitem" onClick={() => setMenu('rename')} disabled={!current}>Rename</button>}
              {!hub && <button type="button" role="menuitem" className="danger" onClick={deleteList} disabled={!current}>Delete</button>}
            </div>
          )}
        </div>
      </div>

      <div className="wp-search">
        <input className="wp-input" value={q} onChange={e => setQ(e.target.value)} disabled={!current}
          placeholder={current ? 'Search or paste symbols to add' : 'Make a portfolio first (+)'} aria-label="Search or paste symbols"
          onBlur={() => setTimeout(() => setHits([]), 120)}
          role="combobox" aria-expanded={hits.length > 0} aria-controls="wp-hits" aria-autocomplete="list"
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHitIdx(i => Math.min(i + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHitIdx(i => Math.max(i - 1, 0)); }
            if (e.key === 'Escape') { setQ(''); setHits([]); }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (many) batchFromText(q);
              else if (hits[hitIdx] && !inList.has(hits[hitIdx].symbol)) addTyped([hits[hitIdx].symbol]);
            }
          }} />
        {many && <button type="button" className="fx-mini" onClick={() => batchFromText(q)}>Add {splitSymbols(q).length}</button>}
        {hits.length > 0 && (
          <ul className="wp-hits" id="wp-hits" role="listbox" aria-label="Matches">
            {hits.map((h, i) => {
              const has = inList.has(h.symbol);
              return (
                <li key={h.symbol} role="option" aria-selected={i === hitIdx} className={i === hitIdx ? 'on' : ''}
                  onMouseEnter={() => setHitIdx(i)} onMouseDown={e => { e.preventDefault(); if (!has) addTyped([h.symbol]); }}>
                  <span className="wp-sym">{h.symbol}</span>
                  <span className="wp-cls">{CLASS_LABEL[h.asset_class] ?? h.asset_class}</span>
                  <span className="wp-src">{h.rates.length ? h.rates.slice(0, 4).join(' ') : h.sources.slice(0, 2).join(', ')}</span>
                  <span className={`wp-add${has ? ' in' : ''}`}>{has ? '✓' : '+'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {menu === 'paste' && (
        <div className="wp-sheet">
          <textarea className="wp-input" rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="EUR_USD, GBP_USD, AAPL …  (commas, spaces or lines)" aria-label="Symbols to add" />
          <div className="wp-row"><button type="button" className="fx-mini" disabled={!text.trim() || busy} onClick={() => batchFromText(text)}>Add them</button>
            <button type="button" className="fx-mini" onClick={() => setMenu('')}>Cancel</button></div>
        </div>
      )}
      {menu === 'fund' && (
        <div className="wp-sheet">
          <select className="wp-select" value={src} onChange={e => setSrc(e.target.value)} aria-label="Fund or list">
            <option value="">{sources ? 'Choose a fund or list…' : 'Loading…'}</option>
            {(sources ?? []).map(s => <option key={s.id} value={s.id}>{s.name} · {s.kind} ({s.symbols.length})</option>)}
          </select>
          {source && (
            <div className="wp-row">
              <button type="button" className="fx-mini" disabled={busy} onClick={async () => {
                const add = source.symbols.filter(s => !inList.has(s));
                if (await change(current!.name, add)) { setMsg({ ok: true, text: `Added ${add.length} from ${source.name}.` }); setMenu(''); }
              }}>{source.kind === 'Fund' ? 'Add its holdings' : 'Add all'} ({source.symbols.filter(s => !inList.has(s)).length} new)</button>
              {fundSymbol && <button type="button" className="fx-mini" disabled={busy || inList.has(fundSymbol)} onClick={async () => {
                if (await change(current!.name, [fundSymbol])) { setMsg({ ok: true, text: `Added ${fundSymbol}.` }); setMenu(''); }
              }}>{inList.has(fundSymbol) ? `${fundSymbol} is in it` : `Add the fund itself (${fundSymbol})`}</button>}
            </div>
          )}
          <div className="wp-row"><button type="button" className="fx-mini" onClick={() => setMenu('')}>Close</button></div>
        </div>
      )}

      {menu === 'source' && (
        <form className="wp-sheet" onSubmit={e => { e.preventDefault(); addSource(text); }}>
          <input autoFocus className="wp-input" value={text} onChange={e => setText(e.target.value)} placeholder="fred:UNRATE or catalog:yahoo.etfs" aria-label="Source to add" maxLength={100} />
          <div className="wp-row"><button type="submit" className="fx-mini" disabled={!text.trim() || busy}>Add source</button>
            <button type="button" className="fx-mini" onClick={() => setMenu('')}>Cancel</button></div>
        </form>
      )}
      {menu === 'addlist' && (
        <div className="wp-sheet">
          <select className="wp-select" value={text} onChange={e => setText(e.target.value)} aria-label="List to put in this one">
            <option value="">{sublistChoices.length ? 'Choose a list to put in this one…' : 'No other lists to add'}</option>
            {sublistChoices.map(r => <option key={r} value={r}>{r.startsWith('hub:') ? `${r.slice(4)} · Data Hub` : r}</option>)}
          </select>
          <div className="wp-row"><button type="button" className="fx-mini" disabled={!text || busy} onClick={() => addSublist(text)}>Add list</button>
            <button type="button" className="fx-mini" onClick={() => { setMenu(''); setText(''); }}>Cancel</button></div>
        </div>
      )}
      {menu === 'savefilter' && (
        <form className="wp-sheet" onSubmit={e => { e.preventDefault(); saveTagFilter(text); }}>
          <input autoFocus className="wp-input" value={text} onChange={e => setText(e.target.value)} placeholder="Filter name" aria-label="Filter name" maxLength={60} />
          <div className="wp-row"><button type="submit" className="fx-mini" disabled={!text.trim()}>Save filter</button>
            <button type="button" className="fx-mini" onClick={() => setMenu('')}>Cancel</button></div>
        </form>
      )}

      {current && ((current.sublists ?? []).length > 0 || (current.sources ?? []).length > 0) && (
        <div className="wp-members">
          {(current.sublists ?? []).length > 0 && (
            <div className="wp-member-row" role="group" aria-label="Lists in this collection">
              <span className="wp-member-label">Lists</span>
              {(current.sublists ?? []).map(l => (
                <span key={l} className="wp-member wp-member--list">{l.startsWith('hub:') ? `${l.slice(4)} · Data Hub` : l}
                  {!current.hub && <button type="button" className="fx-x" aria-label={`Take ${l} out`} onClick={() => { setOpened(null); change(current.name, [], [], false, [], [`list:${l}`]); }}>×</button>}
                </span>
              ))}
              <button type="button" className="fx-mini" aria-pressed={!!opened} onClick={openUniverse}>{opened ? 'Show this list only' : 'Open as one universe'}</button>
            </div>
          )}
          {(current.sources ?? []).length > 0 && (
            <div className="wp-member-row" role="group" aria-label="Sources">
              <span className="wp-member-label">Sources</span>
              {(current.sources ?? []).map(s => (
                <span key={s} className="wp-member wp-member--source" title="A source, not an asset">{s}
                  {!current.hub && <button type="button" className="fx-x" aria-label={`Remove source ${s}`} onClick={() => change(current.name, [], [], false, [], [`source:${s}`])}>×</button>}
                </span>
              ))}
            </div>
          )}
          {opened && (
            <p className="wp-dim wp-universe">One universe from {opened.lists.length} list{opened.lists.length === 1 ? '' : 's'}: {opened.symbols.length} assets
              {opened.sources.length ? `, ${opened.sources.length} sources (${opened.sources.slice(0, 4).join(', ')}${opened.sources.length > 4 ? '…' : ''})` : ''}
              {opened.missing.length ? `; missing: ${opened.missing.join(', ')}` : ''}{opened.cycles.length ? `; loops skipped: ${opened.cycles.join(', ')}` : ''}.</p>
          )}
        </div>
      )}

      {current && (shown.length > 0 || !!filters?.length) && (
        <div className="wp-chips wp-tags" role="group" aria-label="Tag filter: click once for must have, twice for can't have">
          <select className="wp-select wp-filter-select" value={filterName} onChange={e => loadTagFilter(e.target.value)} aria-label="Saved filter">
            <option value="">{filters?.length ? 'Saved filters…' : 'No saved filters'}</option>
            {(filters ?? []).map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
          {filterName && <button type="button" className="fx-x" aria-label={`Delete saved filter ${filterName}`} title="Delete this saved filter" onClick={deleteTagFilter}>×</button>}
          {tagChips.map(([t, n]) => {
            const st = tagState(tagF, t);
            return <button key={t} type="button" className={`wp-chip wp-tag--${st}${st !== 'off' ? ' on' : ''}`} aria-pressed={st !== 'off'}
              title={st === 'must' ? 'Must have (click: can\'t have)' : st === 'not' ? 'Can\'t have (click: off)' : 'Click: must have'}
              onClick={() => { setTagF(f => cycleTag(f, t)); setFilterName(''); }}>{st === 'must' ? '+' : st === 'not' ? '−' : ''}{t} {n}</button>;
          })}
          {(tagF.must.length > 0 || tagF.not.length > 0) && <button type="button" className="fx-mini" onClick={() => { setTagF(NO_TAG_FILTER); setFilterName(''); }}>Clear</button>}
        </div>
      )}

      {current && (shown.length > 0) && (
        <div className="wp-chips" role="group" aria-label="Asset class">
          {[['all', `All ${shown.length}`], ...[...MAIN_CLASSES.map(c => c.id), 'other'].filter(c => classCounts.get(c)).map(c => [c, `${CLASS_LABEL[c]} ${classCounts.get(c)}`])].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={cls === id} className={`wp-chip${cls === id ? ' on' : ''}`} onClick={() => setCls(id)}>{label}</button>
          ))}
        </div>
      )}

      <div className="wp-table">
        <table className="fx-ftable">
          <thead><tr>
            <th scope="col" aria-label="Select" />
            {head('symbol', 'Symbol')}{head('class', 'Class')}
            <th scope="col"><button type="button" tabIndex={-1}>Sources</button></th>
            {wide && <th scope="col"><button type="button" tabIndex={-1}>Rates</button></th>}
            <th scope="col" aria-label="Lists" />
          </tr></thead>
          <tbody>
            {rows.map(h => {
              const holding = listsHolding(h.symbol);
              const refs = h.tags.filter(t => t.includes(':'));
              return (
                <tr key={h.symbol} draggable onDragStart={e => { e.dataTransfer.setData('text/plain', h.symbol); e.dataTransfer.effectAllowed = 'copy'; }}>
                  <td><input type="checkbox" aria-label={`Select ${h.symbol}`} checked={picked.has(h.symbol)} disabled={!!opened}
                    onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(h.symbol); else n.delete(h.symbol); return n; })} /></td>
                  <td className="name">{h.symbol}</td>
                  <td>{SHORT[h.asset_class] ?? h.asset_class}</td>
                  <td title={refs.join('  ')}>{refs.length ? refs.map(t => t.split(':')[0]).join(' ') : <span className="wp-dim">not recorded</span>}</td>
                  {wide && <td>{h.rates.join(' ') || '–'}</td>}
                  <td className="acts">
                    <span className="fx-star">
                      <button type="button" className="fx-star-btn on" aria-haspopup="dialog" aria-expanded={starFor === h.symbol}
                        aria-label={`Portfolios holding ${h.symbol}: ${holding.join(', ')}`} title={`In ${holding.join(', ')}`}
                        onClick={e => { setStarBtn(e.currentTarget); setStarFor(s => (s === h.symbol ? null : h.symbol)); }}>★{holding.length > 1 ? <small>{holding.length}</small> : null}</button>
                      {starFor === h.symbol && (
                        <div className="fx-star-pop" role="dialog" aria-label={`Portfolios for ${h.symbol}`} style={popoverAt(starBtn, 220)}>
                          {(lists ?? []).map(l => (
                            <label key={l.name} className="fx-star-item">
                              <input type="checkbox" checked={l.symbols.includes(h.symbol)}
                                onChange={e => change(l.name, e.target.checked ? [h.symbol] : [], e.target.checked ? [] : [h.symbol])} />
                              <span>{l.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </span>
                    {!opened && <button type="button" className="fx-x" aria-label={`Remove ${h.symbol}`} onClick={() => change(current!.name, [], [h.symbol])}>×</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {current && rows.length === 0 && <p className="fx-favs-empty">{shown.length ? 'None match the class and tag filter.' : 'Empty: search above, paste a list, or add a fund from ⋯.'}</p>}
      </div>

      <div className="wp-foot">
        <button type="button" className="fx-mini" disabled={!picked.size || busy}
          onClick={async () => { if (await change(current!.name, [], [...picked])) setPicked(new Set()); }}>Remove {picked.size || ''}</button>
        {onApply && current && (
          current.name === appliedName
            ? <span className="wp-applied">Engine trades this portfolio</span>
            : <button type="button" className="p-dash-btn p-dash-btn--start p-dash-btn--sm" disabled={!shown.length}
                onClick={() => onApply(current.name, shown)}>{opened ? 'Load universe into engine' : 'Load into engine'}</button>
        )}
      </div>
      {msg && <p className={`wp-msg${msg.ok ? '' : ' err'}`} role="status">{msg.text}</p>}
    </section>
  );
}
