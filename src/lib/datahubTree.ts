import 'server-only';
// The Data Hub's drill tables, built from the hub's tables through each source's map (datahubMap.ts):
//   Recorder: what the hub is set to record (its hooks), item by item, with each item's rates and state.
//   Warehouse: what is stored (its series), source by source, with each series' rows and date interval.
// Instrument items drill type -> form -> instrument; Reference items drill structure -> group -> item.
// Instrument means a tradable asset (or a spread of tradable assets): its prices, bars and option chains. Everything
// else a source records about it (statements, filings, order and position books, positioning) is Reference.

import { getDb } from '@/lib/db';
import { classify } from '@/lib/instruments';
import { allowedRates, changeableRates, mapsFor, optionHookRate, ratesOrder, warehouseAccess, type SourceMap } from '@/lib/datahubMap';
import { isOptionChain, type DhCategory, type DhHome, type DhHook, type DhNode, type DhSource, type DhStored } from '@/lib/datahubTypes';

interface HookRow {
  hook_id: string; connection: string; key: string; params: Record<string, unknown>; enabled: boolean;
  every: number; status: string | null; error: string | null; ran: string | null; disabled_by: string | null;
}
interface SeriesRow { series_id: number; hook_id: string; store: string; part: string; field: string; rows: number; first: string | null; last: string | null }

const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

// The hooks and series tables are read by every view; keep each read for CACHE_MS so moving between views is quick.
// Any change sent from the page clears it (clearTreeCache), so an edit shows on the next load.
const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(name, { at: Date.now(), value });
  value.catch(() => cache.delete(name));
  return value;
}
export function clearTreeCache(): void { cache.clear(); }

function loadHooks(): Promise<HookRow[]> { return cached('hooks', loadHooksNow); }
function loadSeries(): Promise<SeriesRow[]> { return cached('series', loadSeriesNow); }

async function loadHooksNow(): Promise<HookRow[]> {
  const rows = await getDb().prepare(`
    SELECT hook_id, connection_name AS connection, key, params, enabled, interval_seconds AS every, last_status AS status,
           last_error AS error, last_run_at AS ran, disabled_by
    FROM wh_hooks`).all() as HookRow[];
  return rows.map(r => ({ ...r, params: asJson(r.params) ?? {} }));
}

async function loadSeriesNow(): Promise<SeriesRow[]> {
  const rows = await getDb().prepare(`
    SELECT series_id, hook_id, store, part, field, n_rows AS rows, first_ts AS first, last_ts AS last FROM wh_series`).all() as SeriesRow[];
  return rows.map(r => ({ ...r, rows: Number(r.rows ?? 0) }));
}

const CLASS_LABEL: Record<string, string> = {
  stock: 'Stock', commodity: 'Commodity', currency: 'Currency', crypto: 'Crypto', bond: 'Bond', realestate: 'Real estate' };

/** The instrument type of an item (the design's types: Stock, ETF, ETN, Commodity, Currency, Crypto, Bond, Real estate,
 *  Spread): the map's group, or by the instrument when the map says auto. An option chain is typed by its underlying. */
function instrumentType(map: SourceMap, symbol: string): string {
  if (map.group !== 'auto') return map.group;
  if (map.connection.startsWith('oanda')) {
    if (/^(XAU|XAG|XPT|XPD|BCO|WTICO|NATGAS|CORN|WHEAT|SOYBN|SUGAR|XCU)/.test(symbol)) return 'Commodity';
    if (/^(USB|DE10|UK10|JP10)/.test(symbol)) return 'Bond';
    if (/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) return 'Currency';
    return 'Other';
  }
  const area = map.form === 'Option' ? `${map.connection}.stocks`
    : map.key.includes('.') ? `${map.connection}.${map.key.split('.')[0]}` : map.connection;
  const c = classify(area, symbol);
  if (c.tags.includes('etn')) return 'ETN';
  if (c.tags.includes('etf')) return 'ETF';
  return CLASS_LABEL[c.asset_class] ?? 'Other';
}

/** The item a hook records, by the map's item parameter (or the usual ones). */
function itemOf(h: HookRow, map: SourceMap): { param: string; value: string } {
  const p = h.params;
  for (const name of [map.item, 'instrument', 'ticker', 'series_id', 'fund', 'index', 'ratio', 'market_code', 'symbol']) {
    if (name && p[name] != null && !Array.isArray(p[name])) return { param: name, value: String(p[name]) };
  }
  if (Array.isArray(p.forms)) return { param: 'forms', value: (p.forms as string[]).join(', ') };
  return { param: '', value: map.key };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

interface Placed { cat: DhCategory; l1: string; l2: string; label: string; source: string; map: SourceMap; param: string; value: string }

function place(h: HookRow, map: SourceMap): Placed {
  const { param, value } = itemOf(h, map);
  const label = map.category === 'instrument' ? value.toUpperCase() : value;
  return map.category === 'instrument'
    ? { cat: 'instrument', l1: instrumentType(map, value.toUpperCase()), l2: map.form ?? 'Spot', label, source: h.connection, map, param, value }
    : { cat: 'reference', l1: map.structure ?? 'Structured', l2: map.group, label, source: h.connection, map, param, value };
}

function itemTags(p: Placed, rates: string[]): string[] {
  return [...new Set([p.cat, p.l1.toLowerCase(), p.l2.toLowerCase(), p.source, p.map.key, p.map.format.toLowerCase(),
    ...p.map.tags, p.label.toLowerCase(), ...rates.map(r => r.toLowerCase())])];
}

/** One row per symbol whose children are its data streams, one per source (AAPL -> webull_stocks, yahoo): used where a
 *  table shows several sources at once, so a symbol is listed once and each source carries its own rate checklist. */
function bySymbol(prefix: string, items: DhNode[]): DhNode[] {
  const groups = new Map<string, DhNode[]>();
  for (const n of items) groups.set(n.label.toUpperCase(), [...(groups.get(n.label.toUpperCase()) ?? []), n]);
  return [...groups].map(([key, ns]) => {
    const twice = new Set(ns.map(n => n.source)).size < ns.length;      // one source records it under two keys
    const streams = ns.map(n => ({ ...n, label: twice && n.item ? `${n.source} · ${n.item.key}` : (n.source ?? n.label) }))
      .sort((x, y) => x.label.localeCompare(y.label));
    return { id: `${prefix}/sym/${slug(key)}`, label: ns[0].label, tags: [...new Set(ns.flatMap(n => n.tags))], count: ns.length,
      contents: `${ns.length} data stream${ns.length === 1 ? '' : 's'} · ${streams.map(n => n.source).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
      children: streams } as DhNode;
  }).sort((x, y) => x.label.localeCompare(y.label));
}

/** Groups leaves under two levels (type/form or structure/group), counts and sorts every level; with `symbols`, a
 *  symbol level sits between the group and its data streams (see bySymbol). */
function nest(prefix: string, leaves: { p: Placed; node: DhNode }[], symbols = false): DhNode[] {
  const l1 = new Map<string, Map<string, DhNode[]>>();
  for (const { p, node } of leaves) {
    const a = l1.get(p.l1) ?? new Map<string, DhNode[]>();
    a.set(p.l2, [...(a.get(p.l2) ?? []), node]);
    l1.set(p.l1, a);
  }
  const byCount = (x: DhNode, y: DhNode) => y.count - x.count || x.label.localeCompare(y.label);
  return [...l1].map(([a, groups]) => {
    const kids = [...groups].map(([b, items]) => ({
      id: `${prefix}/${slug(a)}/${slug(b)}`, label: b, tags: [b.toLowerCase()], count: items.length,
      children: symbols ? bySymbol(`${prefix}/${slug(a)}/${slug(b)}`, items)
        : items.sort((x, y) => x.label.localeCompare(y.label) || (x.source ?? '').localeCompare(y.source ?? '')),
    })).sort(byCount);
    return { id: `${prefix}/${slug(a)}`, label: a, tags: [a.toLowerCase()], count: kids.reduce((s, k) => s + k.count, 0), children: kids };
  }).sort(byCount);
}

const wanted = (cat: DhCategory | 'all', source: string) => (p: Placed) =>
  (cat === 'all' || p.cat === cat) && (!source || source === 'all' || p.source === source);

/** Every item the hub is set to record (its hooks grouped per item, one hook per rate), placed by its source's map. */
async function recorderLeaves(): Promise<{ p: Placed; node: DhNode }[]> {
  const hooks = await loadHooks();
  const maps = await mapsFor(hooks.map(h => ({ connection: h.connection, key: h.key })));
  const items = new Map<string, { p: Placed; hooks: HookRow[] }>();
  for (const h of hooks) {
    const p = place(h, maps.get(`${h.connection}.${h.key}`)!);
    const id = `${p.source}|${p.map.key}|${p.param}|${p.value}`;
    const it = items.get(id) ?? { p, hooks: [] };
    it.hooks.push(h);
    items.set(id, it);
  }
  return [...items].map(([id, { p, hooks: hs }]) => {
    const hk: DhHook[] = hs.map(h => ({ hook_id: h.hook_id, rate: (h.params.data_rate as string) ?? (isOptionChain(h.key) ? optionHookRate(h.params) : h.connection === 'datahub' ? ({ stats: 'D', filings: 'Tick' } as Record<string, string>)[h.key] ?? null : null),
      enabled: h.enabled, status: h.status,
      error: h.error, every: h.every, ran: h.ran, disabled_by: h.disabled_by })).sort((a, b) => ratesOrder(a.rate ?? '', b.rate ?? ''));
    const on = hk.filter(h => h.enabled);
    const failing = on.filter(h => h.status && h.status !== 'ok').length;
    const node: DhNode = {
      id: `rec/${id}`, label: p.label, source: p.source, format: p.map.format, count: 1,
      contents: `${p.map.key}${on.length ? '' : ' · not recording'}${failing ? ` · ${failing} failing` : ''}`,
      tags: itemTags(p, hk.map(h => h.rate ?? '').filter(Boolean)),
      item: { connection: p.source, key: p.map.key, param: p.param, value: p.value, allowed: allowedRates(p.source, p.map.key),
        changeable: changeableRates(p.source, p.map.key).length > 0, hooks: hk },
    };
    return { p, node };
  });
}

/** Recorder: every item the hub is set to record, with its hooks (one per rate). */
export async function recorderTree(cat: DhCategory | 'all', source: string): Promise<DhNode[]> {
  return byCategory('rec', cat, (await recorderLeaves()).filter(l => wanted(cat, source)(l.p)), true);
}

/** A recording list of the hub, as the Registry shows it. A list's source is the data source that records it (a bundle's
 *  source:<connection> tag), never a consumer: the Discord hub's list is the symbols it reads from the warehouse. */
export interface RegistryList { name: string; kind: string; category: string | null; tags: string[]; record: boolean; members: string[]; sublists: string[] }

export async function registryLists(): Promise<RegistryList[]> {
  return await getDb().prepare(`
    SELECT l.name, l.kind, l.category, l.tags, l.record,
           COALESCE(array_agg(upper(m.member) ORDER BY m.added_at, m.member) FILTER (WHERE m.member_type = 'symbol'), '{}') AS members,
           COALESCE(array_agg(m.member ORDER BY m.member) FILTER (WHERE m.member_type = 'list'), '{}') AS sublists
    FROM wh_lists l LEFT JOIN wh_list_members m ON m.list_name = l.name
    GROUP BY l.name, l.kind, l.category, l.tags, l.record ORDER BY l.kind, l.name`).all() as RegistryList[];
}

/** The source bundles the hub records today, by source (owner, Nov 16 2026): what each source records, in named groups.
 *  Computed from the hub's hooks every time, so a bundle always shows what is recording. A bundle only groups; the
 *  hooks do the recording. `list` limits a bundle to a hub list's members (DIA = the Dow 30, QQQ = the Nasdaq-100). */
interface BundleDef { name: string; source: string; keys: (key: string) => boolean; list?: string; values?: string[] }
const keyIs = (...ks: string[]) => (k: string) => ks.includes(k);
export const SYSTEM_BUNDLES: BundleDef[] = [
  { name: 'Webull Dow 30', source: 'webull_stocks', keys: keyIs('stocks.candles'), list: 'DIA' },
  { name: 'Webull Nasdaq 100', source: 'webull_stocks', keys: keyIs('stocks.candles'), list: 'QQQ' },
  { name: 'Webull Tracked ETFs', source: 'webull_stocks', keys: keyIs('etfs.candles') },
  { name: 'Yahoo Dow 30', source: 'yahoo', keys: keyIs('stocks.candles'), list: 'DIA' },
  { name: 'Yahoo Nasdaq 100', source: 'yahoo', keys: keyIs('stocks.candles'), list: 'QQQ' },
  { name: 'Yahoo Tracked ETFs', source: 'yahoo', keys: keyIs('etfs.candles') },
  { name: 'Yahoo Dollar index', source: 'yahoo', keys: keyIs('stocks.candles'), values: ['DX-Y.NYB'] },
  { name: 'Yahoo Fundamentals and valuation', source: 'yahoo', keys: keyIs('stocks.fundamentals', 'stocks.valuation') },
  { name: 'Yahoo Options', source: 'yahoo', keys: keyIs('options.chain') },
  { name: 'Yahoo Market breadth', source: 'yahoo', keys: keyIs('breadth.above_ma') },
  { name: 'EDGAR Dow 30', source: 'sec_edgar', keys: keyIs('facts', 'filings', 'reports'), list: 'DIA' },
  { name: 'EDGAR Nasdaq 100', source: 'sec_edgar', keys: keyIs('facts', 'filings', 'reports'), list: 'QQQ' },
  { name: 'FRED Macro factors', source: 'fred', keys: keyIs('series') },
  { name: 'OANDA Currencies', source: 'oanda_practice', keys: keyIs('candles') },
  { name: 'OANDA Order and position books', source: 'oanda_practice', keys: keyIs('orderbook', 'positionbook') },
  { name: 'CFTC Positioning', source: 'cftc_cot', keys: keyIs('positions') },
  { name: 'CBOE Put/call', source: 'cboe', keys: keyIs('putcall') },
  { name: 'Fund holdings', source: 'holdings', keys: k => k.endsWith('holdings') },
  { name: 'Datahub Stock stats', source: 'datahub', keys: keyIs('stats') },
  { name: 'Datahub Filing ticks (8-K, Form 4, 13D)', source: 'datahub', keys: keyIs('filings') },
];

type Leaf = { p: Placed; node: DhNode };
const SOURCE_LABEL: Record<string, string> = { webull_stocks: 'Webull', yahoo: 'Yahoo', sec_edgar: 'EDGAR', fred: 'FRED',
  oanda_practice: 'OANDA', cftc_cot: 'CFTC', cboe: 'CBOE', holdings: 'Holdings', datahub: 'Datahub' };

/** A leaf under another branch: the same item (so its Rates cell and checklist work), its own id. */
const reLeaf = (prefix: string, x: Leaf): Leaf => ({ p: x.p, node: { ...x.node, id: `${prefix}/${x.node.id}` } });

function streamsOf(leaves: Leaf[]) {
  const hooks = leaves.flatMap(l => l.node.item?.hooks ?? []);
  return { hooks: hooks.map(h => h.hook_id), on: hooks.filter(h => h.enabled).length, total: hooks.length };
}

/** Recorder Registry. Sources first: source -> Instrument/Reference -> type or structure -> form or group -> the data
 *  stream, with its rate checklist (no lists or bundles here). Bundle view: each source bundle (the built-in ones above,
 *  each source's other recordings, then the bundles saved in the Source Bundle Maker) -> Instrument/Reference -> ... ->
 *  data stream; then the hub's recording lists (fund holdings, collections; trackers are for models), whose switch puts their symbols on
 *  the recording watchlist. Bundle nodes carry data.bundle and data.hooks (their switch turns those recordings on or
 *  off); list nodes carry data.list. */
export async function registryTree(view: 'sources' | 'bundles', cat: DhCategory | 'all' = 'all'): Promise<DhNode[]> {
  const [all, leavesAll] = await Promise.all([registryLists(), recorderLeaves()]);
  const leaves = leavesAll.filter(l => cat === 'all' || l.p.cat === cat);
  if (view === 'sources') {
    return [...new Set(leaves.map(l => l.p.source))].map(src => {
      const prefix = `reg/${src}`;
      const mine = leaves.filter(l => l.p.source === src);
      const kids = byCategory(prefix, cat, mine.map(x => reLeaf(prefix, x)));
      const st = streamsOf(mine);
      return { id: prefix, label: src, source: src, tags: [src, 'source'], count: kids.reduce((n, k) => n + k.count, 0), children: kids,
        contents: `${st.on.toLocaleString()} of ${st.total.toLocaleString()} streams recording` } as DhNode;
    }).sort((a, b) => b.count - a.count);
  }
  const members = new Map(all.map(l => [l.name, new Set(l.members.map(m => m.toUpperCase()))]));
  const bundleNode = (name: string, source: string, mine: Leaf[], tags: string[], what: string): DhNode | null => {
    if (!mine.length) return null;
    const prefix = `bun/${slug(name)}`;
    const kids = byCategory(prefix, cat, mine.map(x => reLeaf(prefix, x)));
    const st = streamsOf(mine);
    const items = new Set(mine.map(l => l.p.value.toUpperCase())).size;
    return { id: prefix, label: name, source, tags: ['bundle', source, ...tags], count: kids.reduce((n, k) => n + k.count, 0), children: kids,
      format: what, data: { bundle: name, hooks: st.hooks, on: st.on, total: st.total },
      contents: `${items.toLocaleString()} item${items === 1 ? '' : 's'} · ${st.on.toLocaleString()} of ${st.total.toLocaleString()} streams recording` };
  };
  const out: DhNode[] = [];
  const used = new Set<Leaf>();
  for (const b of SYSTEM_BUNDLES) {
    const set = b.list ? members.get(b.list) : null;
    const mine = leaves.filter(l => l.p.source === b.source && b.keys(l.p.map.key)
      && (!b.list || !!set?.has(l.p.value.toUpperCase())) && (!b.values || b.values.includes(l.p.value.toUpperCase())));
    mine.forEach(l => used.add(l));
    const n = bundleNode(b.name, b.source, mine, ['system'], 'Built-in bundle');
    if (n) out.push(n);
  }
  for (const src of [...new Set(leaves.map(l => l.p.source))].sort()) {      // anything a source records outside its bundles
    const n = bundleNode(`${SOURCE_LABEL[src] ?? src} other recordings`, src, leaves.filter(l => l.p.source === src && !used.has(l)),
      ['system', 'other'], 'Built-in bundle');
    if (n) out.push(n);
  }
  for (const l of all.filter(x => x.tags.includes('bundle'))) {               // bundles saved in the Source Bundle Maker
    const src = l.tags.find(t => t.startsWith('source:'))?.slice(7) ?? '';
    const set = new Set(l.members.map(m => m.toUpperCase()));
    const n = bundleNode(l.name, src, leaves.filter(x => x.p.source === src && set.has(x.p.value.toUpperCase())), ['saved'], 'Saved bundle');
    if (n) out.push(n);
  }
  const lists = all.filter(x => !x.tags.includes('bundle') && x.kind !== 'tracker');   // trackers are for models, not the Recorder
  if (lists.length) {
    const symbolLeaves = new Map<string, Leaf[]>();
    for (const l of leaves) {
      if (!['instrument', 'ticker', 'fund', 'symbol'].includes(l.p.param)) continue;
      const k = l.p.value.toUpperCase();
      symbolLeaves.set(k, [...(symbolLeaves.get(k) ?? []), l]);
    }
    const kids: DhNode[] = lists.map(l => {
      const id = `lists/${slug(l.name)}`;
      const syms = [...new Set([...l.members, ...l.sublists.map(s => s.toUpperCase())])];
      const children = byCategory(id, cat, syms.flatMap(s => symbolLeaves.get(s) ?? []).map(x => reLeaf(id, x)), true);
      return { id, label: l.name, tags: [l.kind, ...l.tags], count: children.reduce((n, c) => n + c.count, 0), children, data: { list: l.name },
        format: l.category ?? undefined,
        contents: `${l.kind} list · ${syms.length.toLocaleString()} symbols${l.sublists.length ? ` · includes ${l.sublists.join(', ')}` : ''}`
          + ` · ${l.record ? 'on the watchlist' : 'off the watchlist'}` };
    });
    out.push({ id: 'lists', label: 'Recording lists', tags: ['lists'], count: kids.reduce((n, k) => n + k.count, 0), children: kids,
      contents: 'Fund holdings and collections: a list switched on puts its symbols on the recording watchlist' });
  }
  return out;
}

function byCategory(prefix: string, cat: DhCategory | 'all', leaves: { p: Placed; node: DhNode }[], symbols = false): DhNode[] {
  if (cat !== 'all') return nest(`${prefix}/${cat}`, leaves.filter(l => l.p.cat === cat), symbols);
  return (['instrument', 'reference'] as const).map(c => {
    const kids = nest(`${prefix}/${c}`, leaves.filter(l => l.p.cat === c), symbols);
    return { id: `${prefix}/${c}`, label: c === 'instrument' ? 'Instrument' : 'Reference', tags: [c], count: kids.reduce((s, k) => s + k.count, 0), children: kids };
  }).filter(n => n.count);
}

/** Warehouse: every stored item, by source (sources with Warehouse access off are left out). */
export async function warehouseTree(cat: DhCategory | 'all', source: string): Promise<DhNode[]> {
  const [hooks, series, access] = await Promise.all([loadHooks(), loadSeries(), warehouseAccess()]);
  const byHook = new Map(hooks.map(h => [h.hook_id, h]));
  const maps = await mapsFor(hooks.map(h => ({ connection: h.connection, key: h.key })));
  const items = new Map<string, { p: Placed; stored: DhStored[] }>();
  for (const s of series) {
    const h = byHook.get(s.hook_id);
    if (!h || access.get(h.connection) === false) continue;
    const p = place(h, maps.get(`${h.connection}.${h.key}`)!);
    if (!wanted(cat, source)(p)) continue;
    const id = `${p.source}|${p.map.key}|${p.param}|${p.value}`;
    const it = items.get(id) ?? { p, stored: [] };
    it.stored.push({ series_id: s.series_id, store: s.store, rate: (h.params.data_rate as string) ?? null, part: s.part, field: s.field,
      rows: s.rows, first: s.first, last: s.last });
    items.set(id, it);
  }
  // source -> (category) -> type/structure -> form/group -> item
  const bySource = new Map<string, { p: Placed; node: DhNode }[]>();
  for (const [id, { p, stored }] of items) {
    stored.sort((a, b) => ratesOrder(a.rate ?? '', b.rate ?? '') || a.part.localeCompare(b.part) || a.field.localeCompare(b.field));
    const rows = stored.reduce((s, x) => s + x.rows, 0);
    const node: DhNode = {
      id: `wh/${id}`, label: p.label, source: p.source, format: p.map.format, count: 1, stored,
      contents: `${stored.length} stored series · ${rows.toLocaleString()} rows`,
      tags: itemTags(p, stored.map(x => x.rate ?? '').filter(Boolean)),
      lazy: stored.some(x => x.store === 'options') ? 'options' : undefined,
    };
    bySource.set(p.source, [...(bySource.get(p.source) ?? []), { p, node }]);
  }
  // one category: source -> groups; All data: category -> source -> groups (as the design shows it)
  const sourceNodes = (c: DhCategory): DhNode[] => [...bySource].map(([src, leaves]) => {
    const kids = nest(`wh/${c}/${src}`, leaves.filter(l => l.p.cat === c));
    return { id: `wh/${c}/${src}`, label: src, source: src, tags: [src, 'source'], count: kids.reduce((s, k) => s + k.count, 0), children: kids };
  }).filter(n => n.count).sort((a, b) => b.count - a.count);
  if (cat !== 'all') return sourceNodes(cat);
  return (['instrument', 'reference'] as const).map(c => {
    const kids = sourceNodes(c);
    return { id: `wh/${c}`, label: c === 'instrument' ? 'Instrument' : 'Reference', tags: [c], count: kids.reduce((s, k) => s + k.count, 0), children: kids };
  }).filter(n => n.count);
}

/** Option chains stored for one series: contract month -> strike, each strike with its stored date interval. */
export async function optionLevels(seriesId: number): Promise<DhNode[]> {
  const rows = await getDb().prepare(`
    SELECT to_char(expiry, 'YYYY-MM') AS month, strike, count(*)::int AS n, min(ts) AS first, max(ts) AS last,
           array_agg(DISTINCT side) AS sides
    FROM wh_options WHERE series_id = ? GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 5000`).all(seriesId) as
    { month: string; strike: number; n: number; first: string; last: string; sides: string[] }[];
  const months = new Map<string, DhNode[]>();
  for (const r of rows) {
    months.set(r.month, [...(months.get(r.month) ?? []), {
      id: `opt/${seriesId}/${r.month}/${r.strike}`, label: `Strike ${Number(r.strike)}`, count: 1, format: 'Option chains',
      tags: ['strike', String(r.strike)],
      contents: `${(r.sides ?? []).join('/')} · ${new Date(r.first).toISOString().slice(0, 10)}:${new Date(r.last).toISOString().slice(0, 10)} · ${r.n.toLocaleString()} quotes`,
      stored: [{ series_id: seriesId, store: 'options', rate: null, part: '', field: '', rows: r.n, first: r.first, last: r.last }],
    }]);
  }
  return [...months].map(([m, strikes]) => ({
    id: `opt/${seriesId}/${m}`, label: new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    tags: ['contract month', m], count: strikes.length, children: strikes,
  }));
}

/** Every source connection: its keys, their maps, what they record and store. */
export async function sourcesSummary(): Promise<DhSource[]> {
  const db = getDb();
  const [conns, keys, stored, access] = await Promise.all([
    db.prepare(`SELECT connection_name, connector_type, enabled, last_error FROM wh_connections ORDER BY connection_name`).all() as
      Promise<{ connection_name: string; connector_type: string; enabled: boolean; last_error: string | null }[]>,
    db.prepare(`SELECT connection_name AS connection, key, count(*)::int AS hooks, count(*) FILTER (WHERE enabled)::int AS on,
                  count(*) FILTER (WHERE enabled AND last_status IS NOT NULL AND last_status <> 'ok')::int AS failing,
                  max(last_run_at) AS last_run
                FROM wh_hooks GROUP BY 1, 2 ORDER BY 1, 2`).all() as
      Promise<{ connection: string; key: string; hooks: number; on: number; failing: number; last_run: string | null }[]>,
    db.prepare(`SELECT h.connection_name AS connection, h.key, count(*)::int AS n, coalesce(sum(s.n_rows), 0)::bigint AS rows
                FROM wh_series s JOIN wh_hooks h USING (hook_id) GROUP BY 1, 2`).all() as
      Promise<{ connection: string; key: string; n: number; rows: number | string }[]>,
    warehouseAccess(),
  ]);
  const maps = await mapsFor(keys);
  const st = new Map(stored.map(s => [`${s.connection}.${s.key}`, s]));
  return conns.map(c => {
    const ks = keys.filter(k => k.connection === c.connection_name).map(k => {
      const m = maps.get(`${k.connection}.${k.key}`)!;
      const s = st.get(`${k.connection}.${k.key}`);
      return { key: k.key, hooks: k.hooks, on: k.on, failing: k.failing, last_run: k.last_run,
        stored_series: s?.n ?? 0, stored_rows: Number(s?.rows ?? 0),
        map: { category: m.category, structure: m.structure, group: m.group, form: m.form, format: m.format, store: m.store,
          item: m.item, request: m.request, tags: m.tags, saved: m.saved, updated_by: m.updated_by ?? null, updated_at: m.updated_at ?? null } };
    });
    return { connection: c.connection_name, type: c.connector_type, enabled: c.enabled, error: c.last_error,
      categories: [...new Set(ks.map(k => k.map.category))], warehouse: access.get(c.connection_name) !== false, keys: ks };
  });
}

export async function homeSummary(): Promise<DhHome> {
  const db = getDb();
  const safe = <T,>(p: Promise<T>, d: T) => p.catch(() => d);
  const [h, s, l, proc, size] = await Promise.all([
    safe(db.prepare(`SELECT count(*)::int AS hooks, count(*) FILTER (WHERE enabled)::int AS on,
                       count(*) FILTER (WHERE enabled AND last_status IS NOT NULL AND last_status <> 'ok')::int AS failing,
                       count(DISTINCT connection_name)::int AS sources FROM wh_hooks`).get() as Promise<{ hooks: number; on: number; failing: number; sources: number }>,
      { hooks: 0, on: 0, failing: 0, sources: 0 }),
    safe(db.prepare(`SELECT count(*)::int AS streams, coalesce(sum(n_rows), 0)::bigint AS rows FROM wh_series`).get() as Promise<{ streams: number; rows: string }>,
      { streams: 0, rows: '0' }),
    safe(db.prepare(`SELECT count(*)::int AS lists, count(*) FILTER (WHERE record)::int AS rec FROM wh_lists`).get() as Promise<{ lists: number; rec: number }>,
      { lists: 0, rec: 0 }),
    safe(db.prepare(`SELECT last_tick_at FROM wh_process_state WHERE process_name = 'source_manager'
                     ORDER BY last_tick_at DESC NULLS LAST LIMIT 1`).get() as Promise<{ last_tick_at: string } | undefined>, undefined),
    safe(db.prepare(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`).get() as Promise<{ size: string }>, { size: '' }),
  ]);
  const tick = proc?.last_tick_at ?? null;
  return { sources: h.sources, hooks: h.hooks, on: h.on, failing: h.failing, streams: s.streams, rows: Number(s.rows),
    lists: l.lists, recording_lists: l.rec, recorder_running: !!tick && Date.now() - new Date(tick).getTime() < 5 * 60_000,
    recorder_tick: tick, database_size: size.size || null };
}

/** Hooks by id, for checking a command before it is queued. */
export async function hooksById(ids: string[]): Promise<Map<string, { hook_id: string; connection: string; key: string; params: Record<string, unknown>; enabled: boolean; disabled_by: string | null }>> {
  if (!ids.length) return new Map();
  const rows = await getDb().prepare(`SELECT hook_id, connection_name AS connection, key, params, enabled, disabled_by FROM wh_hooks
    WHERE hook_id = ANY(?::text[])`).all(ids) as { hook_id: string; connection: string; key: string; params: unknown; enabled: boolean; disabled_by: string | null }[];
  return new Map(rows.map(r => [r.hook_id, { ...r, params: asJson(r.params) ?? {} }]));
}

/** Every hook of the given sources (for the source access switches). */
export async function hooksOfSources(connections: string[]) {
  return await getDb().prepare(`SELECT hook_id, enabled, disabled_by FROM wh_hooks WHERE connection_name = ANY(?::text[])`).all(connections) as
    { hook_id: string; enabled: boolean; disabled_by: string | null }[];
}
