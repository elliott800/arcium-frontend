// Instruments by asset class, with shared tags.
//
// Classes (each its own instrument type in the engine):
//   spot:        stock, bond, currency, crypto, commodity, realestate
//   derivatives: option, future, swap
//   spread:      a combination of signed, weighted legs
// Funds are special instruments: an ETF or ETN is tagged with its wrapper AND its
// underlying class (a stock ETF is tagged etf + stock); a mutual fund is tagged
// mutual_fund only, never with its underlying class.

export const ASSET_CLASSES = [
  { id: 'stock', label: 'Stocks' }, { id: 'bond', label: 'Bonds' }, { id: 'currency', label: 'Currencies' },
  { id: 'crypto', label: 'Crypto' }, { id: 'commodity', label: 'Commodities' }, { id: 'realestate', label: 'Real estate' },
  { id: 'option', label: 'Options' }, { id: 'future', label: 'Futures' }, { id: 'swap', label: 'Swaps' },
  { id: 'spread', label: 'Spreads' },
] as const;
export type AssetClass = typeof ASSET_CLASSES[number]['id'];

export const FUND_TAGS = [
  { id: 'etf', label: 'ETFs' }, { id: 'etn', label: 'ETNs' }, { id: 'mutual_fund', label: 'Mutual funds' },
] as const;

export interface InstrumentClass { asset_class: AssetClass | 'fund'; tags: string[] }

// Exchange-traded funds and notes by what they hold (anything not listed holds stocks).
const ETF_UNDERLYING: Record<string, AssetClass> = {
  TLT: 'bond', IEF: 'bond', SHY: 'bond', LQD: 'bond', HYG: 'bond', AGG: 'bond', BND: 'bond', TIP: 'bond', EMB: 'bond', JNK: 'bond',
  GLD: 'commodity', IAU: 'commodity', SLV: 'commodity', USO: 'commodity', UNG: 'commodity', DBC: 'commodity', DBA: 'commodity', PDBC: 'commodity',
  VNQ: 'realestate', XLRE: 'realestate', IYR: 'realestate', SCHH: 'realestate',
  UUP: 'currency', UDN: 'currency', FXE: 'currency', FXY: 'currency', FXB: 'currency', FXF: 'currency', FXA: 'currency', FXC: 'currency',
  IBIT: 'crypto', FBTC: 'crypto', GBTC: 'crypto', ETHA: 'crypto',
};
const ETNS = new Set(['VXX', 'VXZ', 'DJP', 'GSG', 'AMJ']);
const ETN_UNDERLYING: Record<string, AssetClass> = { VXX: 'future', VXZ: 'future', DJP: 'commodity', GSG: 'commodity', AMJ: 'stock' };
const METALS = /^(XAU|XAG|XPT|XPD)_/;
const CRYPTO = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BCH|DOT|AVAX|LINK|MATIC)([-_/]?(USD|USDT|USDC|EUR))?$/;

/** Asset class and tags for an instrument, from the data group it came from
 *  (a connection, or connection.area such as "yahoo.etfs") and its symbol. */
export function classify(group: string, symbol: string): InstrumentClass {
  const area = (group.split('.')[1] ?? '').toLowerCase();
  const sym = symbol.toUpperCase();
  const fund = (wrapper: 'etf' | 'etn', under: AssetClass): InstrumentClass => ({ asset_class: under, tags: [wrapper, under] });
  if (ETNS.has(sym)) return fund('etn', ETN_UNDERLYING[sym] ?? 'stock');
  if (area === 'etfs' || ETF_UNDERLYING[sym]) return fund('etf', ETF_UNDERLYING[sym] ?? 'stock');
  if (area === 'mutual_funds' || area === 'mutualfunds') return { asset_class: 'fund', tags: ['mutual_fund'] };
  if (area === 'crypto' || CRYPTO.test(sym)) return { asset_class: 'crypto', tags: ['crypto'] };
  if (area === 'options') return { asset_class: 'option', tags: ['option'] };
  if (area === 'futures') return { asset_class: 'future', tags: ['future'] };
  if (METALS.test(sym)) return { asset_class: 'commodity', tags: ['commodity'] };
  if (area === 'fx' || /^[A-Z]{3}_[A-Z]{3}$/.test(sym)) return { asset_class: 'currency', tags: ['currency'] };
  return { asset_class: 'stock', tags: ['stock'] };
}

/** Filter chips for a set of classified rows: "All", then each asset class and fund tag
 *  present, with counts. A row matches a chip when its tags include the chip's id. */
export function tagFilters(rows: { tags?: string[] }[]) {
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [
    { id: 'all', label: 'All', count: rows.length },
    ...[...ASSET_CLASSES, ...FUND_TAGS].filter(c => counts.has(c.id)).map(c => ({ id: c.id as string, label: c.label, count: counts.get(c.id)! })),
  ];
}
/** Must-have and can't-have tag lists: a row passes when it carries every `must` tag
 *  and none of the `not` tags, so a can't-have always wins over a must-have. */
export interface TagFilter { must: string[]; not: string[] }
export const NO_TAG_FILTER: TagFilter = { must: [], not: [] };

export function matchesTags(row: { tags?: string[] }, f: TagFilter) {
  const tags = row.tags ?? [];
  return f.must.every(t => tags.includes(t)) && !f.not.some(t => tags.includes(t));
}

/** A chip click cycles its tag: off -> must have -> can't have -> off. "All" clears both lists. */
export function cycleTag(f: TagFilter, tag: string): TagFilter {
  if (tag === 'all') return NO_TAG_FILTER;
  if (f.must.includes(tag)) return { must: f.must.filter(t => t !== tag), not: [...f.not, tag] };
  if (f.not.includes(tag)) return { must: f.must, not: f.not.filter(t => t !== tag) };
  return { must: [...f.must, tag], not: f.not };
}

/** How a chip shows: 'must' (+), 'not' (−) or 'off'. "All" is lit while no tag is chosen. */
export function tagState(f: TagFilter, tag: string): 'must' | 'not' | 'off' {
  if (tag === 'all') return f.must.length || f.not.length ? 'off' : 'must';
  return f.must.includes(tag) ? 'must' : f.not.includes(tag) ? 'not' : 'off';
}

/** The base connection of a data group ("yahoo.stocks" -> "yahoo"). */
export const baseConnection = (group: string) => group.split('.')[0];

/** The six main asset classes the portfolio maker filters by (the owner's categories). */
export const MAIN_CLASSES = [
  { id: 'stock', label: 'Stocks' }, { id: 'commodity', label: 'Commodities' }, { id: 'currency', label: 'Currencies' },
  { id: 'realestate', label: 'Real estate' }, { id: 'bond', label: 'Bonds' }, { id: 'crypto', label: 'Crypto' },
] as const;
export type MainClass = typeof MAIN_CLASSES[number]['id'] | 'other';

/** One of the six main classes for a symbol (a fund counts as what it holds; options, futures and spreads are
 *  'other'). The data group (a connection or connection.area) sharpens it when known. */
export function mainClassOf(symbol: string, group = ''): MainClass {
  if (symbol.startsWith('@')) return 'other';
  const c = classify(group, symbol);
  const id = c.asset_class === 'fund' ? 'other' : c.asset_class;
  return (MAIN_CLASSES as readonly { id: string }[]).some(m => m.id === id) ? id as MainClass : 'other';
}
