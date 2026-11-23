import 'server-only';
// Source maps for the Data Hub page: for every (source connection, request key) the hub records, where its data
// belongs in the site's catalog: Instrument or Reference, then the drill groups (instrument type and form, or
// reference structure and group), the data format, the warehouse store it lands in, and its tags.
// Instrument is only for a tradable asset or a spread of tradable assets (its prices, bars, option chains); anything
// else is Reference.
//
// Each source owns its own map. A key with no saved map uses the default below (a reviewed suggestion); saving one
// in the Source Controller replaces it for that source and key only. Maps are site configuration, kept in the site's
// own tables (dh_source_maps, dh_source_access); the hub's wh_* tables are written only by the hub.

import { getDb } from '@/lib/db';
import { isOptionChain, OPTION_RATES } from '@/lib/datahubTypes';

export type Category = 'instrument' | 'reference';
export interface SourceMap {
  connection: string;
  key: string;
  category: Category;
  structure: 'Structured' | 'Unstructured' | 'Stats' | null;   // reference data (Stats: the Data Hub's own calculations)
  group: string;          // instrument type ('auto' = by the instrument's class) or reference group
  form: 'Spot' | 'Future' | 'Option' | null;          // instrument data
  format: string;         // what one record is: OHLCV bars, option chains, values, records, text
  store: 'wh_ohlcv' | 'wh_values' | 'wh_records' | 'wh_options';
  item: string;           // the hook parameter naming the item (instrument, ticker, series_id, fund ...)
  request: string;        // the request pattern, for reading the map
  tags: string[];
  saved: boolean;         // false = the default suggestion, not yet reviewed and saved
  updated_by?: string | null;
  updated_at?: string | null;
}

export const INSTRUMENT_TYPES = ['Stock', 'ETF', 'ETN', 'Commodity', 'Currency', 'Crypto', 'Bond', 'Real estate', 'Spread', 'Other'] as const;
export const REFERENCE_GROUPS = ['Financial statements', 'Valuation', 'Economic benchmarks', 'Market breadth', 'Sentiment',
  'Positioning', 'Fund holdings', 'Order flow', 'Scanner cards', 'Text feed', 'Other'] as const;
export const FORMATS = ['OHLCV bars', 'Option chains', 'Values', 'Records', 'Text'] as const;
export const STORES = ['wh_ohlcv', 'wh_values', 'wh_records', 'wh_options'] as const;

type Default = Omit<SourceMap, 'connection' | 'key' | 'saved' | 'updated_by' | 'updated_at'>;
const bars = (group: string, item = 'instrument'): Default => ({
  category: 'instrument', structure: null, group, form: 'Spot', format: 'OHLCV bars', store: 'wh_ohlcv', item,
  request: `candles {${item}} {data_rate}`, tags: ['bars', 'time series'] });
const ref = (structure: 'Structured' | 'Unstructured' | 'Stats', group: string, format: string, store: SourceMap['store'], item: string, request: string, tags: string[]): Default =>
  ({ category: 'reference', structure, group, form: null, format, store, item, request, tags });

// The default map: what each request key the hub records is, by source.
const DEFAULTS: Record<string, Default> = {
  'yahoo.stocks.candles': bars('auto'),
  'yahoo.etfs.candles': bars('ETF'),
  'yahoo.fx.candles': bars('Currency'),
  'yahoo.crypto.candles': bars('Crypto'),
  'yahoo.options.chain': { category: 'instrument', structure: null, group: 'auto', form: 'Option', format: 'Option chains', store: 'wh_options',
    item: 'ticker', request: 'options.chain {ticker} (nearest expiries, near the money)', tags: ['option', 'chain'] },
  'yahoo.stocks.fundamentals': ref('Structured', 'Financial statements', 'Values', 'wh_values', 'ticker', 'stocks.fundamentals {ticker}', ['fundamentals', 'statements']),
  'yahoo.stocks.valuation': ref('Structured', 'Valuation', 'Values', 'wh_values', 'ticker', 'stocks.valuation {ticker}', ['valuation', 'ratios']),
  'yahoo.breadth.above_ma': ref('Structured', 'Market breadth', 'Values', 'wh_values', 'index', 'breadth.above_ma {index} {weeks}', ['breadth']),
  'oanda_practice.candles': bars('auto'),
  // order and position books are about an instrument but are not its prices: Reference
  'oanda_practice.orderbook': ref('Structured', 'Order flow', 'Records', 'wh_records', 'instrument', 'orderbook {instrument}', ['order book', 'order flow']),
  'oanda_practice.positionbook': ref('Structured', 'Order flow', 'Records', 'wh_records', 'instrument', 'positionbook {instrument}', ['position book', 'order flow']),
  'sec_edgar.facts': ref('Structured', 'Financial statements', 'Values', 'wh_values', 'ticker', 'facts {ticker} {concepts}', ['sec', 'xbrl', 'statements']),
  'sec_edgar.filings': ref('Unstructured', 'Text feed', 'Records', 'wh_records', 'ticker', 'filings {ticker}', ['sec', 'filings']),
  'sec_edgar.latest': ref('Unstructured', 'Text feed', 'Records', 'wh_records', 'forms', 'latest {forms}', ['sec', 'filings', 'events']),
  'fred.series': ref('Structured', 'Economic benchmarks', 'Values', 'wh_values', 'series_id', 'series {series_id}', ['economic', 'macro']),
  'cboe.putcall': ref('Structured', 'Sentiment', 'Values', 'wh_values', 'ratio', 'putcall {ratio}', ['sentiment', 'put/call']),
  'cftc_cot.positions': ref('Structured', 'Positioning', 'Values', 'wh_values', 'market_code', 'positions {market_code}', ['cot', 'positioning', 'futures']),
  // the Data Hub's own processing: stats calculated from the warehouse, drilled datahub > Stats > Stock > symbol > interval
  'datahub.stats': ref('Stats', 'Stock', 'Values', 'wh_values', 'ticker', 'stats {ticker}', ['stats', 'calculated', 'ratios', 'dcf', 'capm']),
  // tick series of each stock's 8-K, Form 4 and 13D filings, one row per filing at acceptance
  'datahub.filings': ref('Stats', 'Filing ticks', 'Values', 'wh_values', 'ticker', 'filings {ticker}', ['filings', '8-k', 'form 4', 'insider', '13d', 'tick']),
};
const HOLDINGS = ref('Structured', 'Fund holdings', 'Records', 'wh_records', 'fund', 'holdings {fund}', ['holdings', 'fund']);

/** The default map for a key: by name, then by pattern, else an "Other" reference record. */
export function defaultMap(connection: string, key: string): SourceMap {
  const d = DEFAULTS[`${connection}.${key}`]
    ?? (key.endsWith('.holdings') ? HOLDINGS : key.endsWith('candles') ? bars('auto') : ref('Structured', 'Other', 'Records', 'wh_records', '', key, []));
  return { connection, key, ...d, tags: [...d.tags], saved: false };
}

// ---- rates: what the recorder may record per source key, and how often it checks ----------------------------------

const OANDA_RATES = ['M1', 'M2', 'M4', 'M5', 'M10', 'M15', 'M30', 'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D', 'W', 'M'];
const RATE_SECONDS: Record<string, number> = { S5: 5, S10: 10, S15: 15, S30: 30,
  M1: 60, M2: 120, M4: 240, M5: 300, M10: 600, M15: 900, M30: 1800, H1: 3600, H2: 7200, H3: 10800, H4: 14400,
  H6: 21600, H8: 28800, H12: 43200, D: 86400, W: 604800, M: 2592000 };

/** The rate an option-chain hook stands for: the daily full chain, or the 4-hour snapshot. */
export function optionHookRate(params: Record<string, unknown>): string {
  return String(params.expiries ?? '').toLowerCase() === 'all' ? 'D' : 'H4';
}

/** Rates the Data Hub page can add or remove for a key (candles only; option tiers are set in the hub's trackers). */
export function changeableRates(connection: string, key: string): string[] {
  return key.endsWith('candles') ? allowedRates(connection, key) : [];
}

/** Rates a source key records or can record (empty: the key has no data rate). */
export function allowedRates(connection: string, key: string): string[] {
  if (isOptionChain(key)) return OPTION_RATES;
  if (connection === 'datahub' && key === 'stats') return ['D'];   // daily stats rows (the stub financials come per filing)
  if (connection === 'datahub' && key === 'filings') return ['Tick'];   // one row per filing as it is accepted
  if (!key.endsWith('candles')) return [];
  if (connection.startsWith('oanda')) return OANDA_RATES;
  if (connection === 'yahoo') return ['D', 'W', 'M'];
  if (connection.startsWith('webull')) return ['H4', 'D', 'W', 'M'];   // the owner's finest rate for stocks/ETFs is 4-hour
  return [];
}

/** How often a new hook at this rate runs: the hub's own defaults (rate_plan / the Yahoo connector). */
export function intervalFor(connection: string, rate: string): number {
  if (connection === 'yahoo') return ({ D: 6, W: 12, M: 24 } as Record<string, number>)[rate] * 3600 || 86400;
  if (connection.startsWith('webull')) return ({ H4: 1, D: 6, W: 24, M: 24 } as Record<string, number>)[rate] * 3600 || 86400;
  return Math.round(Math.max(10, Math.min((RATE_SECONDS[rate] ?? 3600) / 2, 3600)));
}

export const ratesOrder = (a: string, b: string) => (RATE_SECONDS[a] ?? 9e9) - (RATE_SECONDS[b] ?? 9e9) || a.localeCompare(b);

// ---- storage ----------------------------------------------------------------------------------------------------------

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready) {
    const db = getDb();
    ready = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_source_maps (
        connection text NOT NULL, key text NOT NULL, map jsonb NOT NULL,
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (connection, key))`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_source_access (
        connection text PRIMARY KEY, warehouse boolean NOT NULL DEFAULT true,
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`).run();
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Every saved map, by "connection.key". */
export async function savedMaps(): Promise<Map<string, SourceMap>> {
  await ensure();
  const rows = await getDb().prepare(`SELECT connection, key, map, updated_by, updated_at FROM dh_source_maps`).all() as
    { connection: string; key: string; map: unknown; updated_by: string | null; updated_at: string }[];
  return new Map(rows.map(r => [`${r.connection}.${r.key}`,
    { ...defaultMap(r.connection, r.key), ...(asJson(r.map) as Partial<SourceMap>), connection: r.connection, key: r.key,
      saved: true, updated_by: r.updated_by, updated_at: r.updated_at }]));
}

/** The map in force for each key: saved, else default. */
export async function mapsFor(keys: { connection: string; key: string }[]): Promise<Map<string, SourceMap>> {
  const saved = await savedMaps();
  return new Map(keys.map(k => [`${k.connection}.${k.key}`, saved.get(`${k.connection}.${k.key}`) ?? defaultMap(k.connection, k.key)]));
}

const TEXT = /^[\w .:&()/+#'-]{1,60}$/;

/** Validates a posted map; returns the cleaned map or an error message. */
export function cleanMap(body: Record<string, unknown>): Omit<SourceMap, 'saved'> | string {
  const connection = String(body.connection ?? '').trim();
  const key = String(body.key ?? '').trim();
  if (!/^[\w.-]{1,80}$/.test(connection) || !/^[\w.-]{1,80}$/.test(key)) return 'connection and key required';
  const category = body.category === 'reference' ? 'reference' : body.category === 'instrument' ? 'instrument' : null;
  if (!category) return 'category must be Instrument or Reference';
  const group = String(body.group ?? '').trim();
  if (!TEXT.test(group)) return 'a group name is needed';
  if (category === 'instrument' && group !== 'auto' && !(INSTRUMENT_TYPES as readonly string[]).includes(group))
    return `instrument type must be auto or one of ${INSTRUMENT_TYPES.join(', ')}`;
  const form = category === 'instrument' ? (['Spot', 'Future', 'Option'].includes(String(body.form)) ? body.form as SourceMap['form'] : null) : null;
  if (category === 'instrument' && !form) return 'instrument form must be Spot, Future or Option';
  const structure = category === 'reference' ? (body.structure === 'Unstructured' || body.structure === 'Stats' ? body.structure : 'Structured') : null;
  const format = String(body.format ?? '');
  if (!(FORMATS as readonly string[]).includes(format)) return `format must be one of ${FORMATS.join(', ')}`;
  const store = String(body.store ?? '');
  if (!(STORES as readonly string[]).includes(store)) return `destination must be one of ${STORES.join(', ')}`;
  const item = String(body.item ?? '').trim();
  if (item && !/^[\w]{1,40}$/.test(item)) return 'item parameter must be a parameter name';
  const request = String(body.request ?? '').trim().slice(0, 200);
  const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(','))
    .map(t => String(t).trim().toLowerCase()).filter(t => t && TEXT.test(t)).slice(0, 20);
  return { connection, key, category, structure, group, form, format, store: store as SourceMap['store'], item, request, tags: [...new Set(tags)] };
}

export async function saveMap(m: Omit<SourceMap, 'saved'>, by: string): Promise<void> {
  await ensure();
  const { connection, key, updated_by: _b, updated_at: _a, ...map } = m;
  await getDb().prepare(`INSERT INTO dh_source_maps (connection, key, map, updated_by) VALUES (?, ?, ?::jsonb, ?)
    ON CONFLICT (connection, key) DO UPDATE SET map = EXCLUDED.map, updated_by = EXCLUDED.updated_by, updated_at = now()`)
    .run(connection, key, JSON.stringify(map), by);
}

export async function resetMap(connection: string, key: string): Promise<boolean> {
  await ensure();
  const r = await getDb().prepare(`DELETE FROM dh_source_maps WHERE connection = ? AND key = ?`).run(connection, key) as { changes?: number; rowCount?: number };
  return (r.changes ?? r.rowCount ?? 0) > 0;
}

/** Warehouse access per source: whether its stored data is listed in the Warehouse views (default on). */
export async function warehouseAccess(): Promise<Map<string, boolean>> {
  await ensure();
  const rows = await getDb().prepare(`SELECT connection, warehouse FROM dh_source_access`).all() as { connection: string; warehouse: boolean }[];
  return new Map(rows.map(r => [r.connection, r.warehouse]));
}

export async function setWarehouseAccess(connections: string[], on: boolean, by: string): Promise<void> {
  await ensure();
  for (const c of connections) {
    await getDb().prepare(`INSERT INTO dh_source_access (connection, warehouse, updated_by) VALUES (?, ?, ?)
      ON CONFLICT (connection) DO UPDATE SET warehouse = EXCLUDED.warehouse, updated_by = EXCLUDED.updated_by, updated_at = now()`)
      .run(c, on, by);
  }
}
