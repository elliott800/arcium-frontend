import 'server-only';
// Read-only access to everything the Data Hub records, for the other projects (Discord hub, controller
// silos, scripts): only the Data Hub talks to outside data, everyone else reads the warehouse.
//
//   catalog: which recordings exist (filter by source, request key, or any parameter value such as a
//            ticker or FRED id), each with its stored series (part, field, store, first/last, rows)
//   read:    one series' rows, from whichever table stores it
//            ohlcv   -> { t, o, h, l, c, v }          (price bars)
//            values  -> { t, v }                      (FRED, financials, valuation, COT, put/call, ...)
//            json    -> { t, idx, data }              (EDGAR reports and filings, holdings, order books)
//            options -> { t, expiry, side, strike, last, bid, ask, volume, oi, iv, spot }

import { getDb } from '@/lib/db';

export const MAX_ROWS = 50_000;
const NAME_RE = /^[A-Za-z0-9_.:+\-/ ]{1,200}$/;

export interface CatalogSeries { series_id: number; part: string; field: string; store: string; first: string | null; last: string | null; rows: number }
export interface CatalogHook { hook_id: string; connection: string; key: string; params: Record<string, unknown>; enabled: boolean; series: CatalogSeries[] }

export function validName(s: string): boolean { return NAME_RE.test(s); }

export async function catalog(opts: { connection?: string; key?: string; match?: string; limit?: number }): Promise<CatalogHook[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.connection) { where.push('h.connection_name = ?'); args.push(opts.connection); }
  if (opts.key) { where.push('h.key = ?'); args.push(opts.key); }
  if (opts.match) {     // any parameter value, e.g. AAPL, UNRATE, EUR_USD (case-insensitive, exact)
    where.push(`EXISTS (SELECT 1 FROM jsonb_each_text(h.params) p WHERE upper(p.value) = upper(?))`);
    args.push(opts.match);
  }
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 500)));
  const hooks = await getDb().prepare(`
    SELECT h.hook_id, h.connection_name AS connection, h.key, h.params, h.enabled
    FROM wh_hooks h ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY h.connection_name, h.key, h.hook_id LIMIT ${limit}`).all(...args) as Omit<CatalogHook, 'series'>[];
  if (!hooks.length) return [];
  const ids = hooks.map(h => h.hook_id);
  const series = await getDb().prepare(`
    SELECT series_id, hook_id, part, field, store, first_ts, last_ts, n_rows FROM wh_series
    WHERE hook_id = ANY(?) ORDER BY hook_id, part, field`).all(ids) as
    { series_id: number; hook_id: string; part: string; field: string; store: string; first_ts: Date | null; last_ts: Date | null; n_rows: number | string }[];
  const by = new Map<string, CatalogSeries[]>();
  for (const s of series) {
    const list = by.get(s.hook_id) ?? [];
    list.push({ series_id: Number(s.series_id), part: s.part, field: s.field, store: s.store,
      first: s.first_ts ? new Date(s.first_ts).toISOString() : null, last: s.last_ts ? new Date(s.last_ts).toISOString() : null,
      rows: Number(s.n_rows) });
    by.set(s.hook_id, list);
  }
  return hooks.map(h => ({ ...h, series: by.get(h.hook_id) ?? [] }));
}

export interface ReadResult { series_id: number; hook_id: string; part: string; field: string; store: string; rows: Record<string, unknown>[]; truncated: boolean }

/** One series' rows in time order: between `from` and `to` when given, else the latest `limit`.
 *  Option chains without a range return the latest snapshot only. */
export async function readSeries(seriesId: number, opts: { from?: Date; to?: Date; limit?: number }): Promise<ReadResult | null> {
  const s = await getDb().prepare('SELECT series_id, hook_id, part, field, store FROM wh_series WHERE series_id = ?')
    .get(seriesId) as { series_id: number; hook_id: string; part: string; field: string; store: string } | undefined;
  if (!s) return null;
  const limit = Math.max(1, Math.min(MAX_ROWS, Math.floor(opts.limit ?? 5000)));
  const range: string[] = [];
  const args: unknown[] = [];
  const tcol = s.store === 'json' ? 'idx_time' : 'ts';
  if (opts.from) { range.push(`${tcol} >= ?`); args.push(opts.from); }
  if (opts.to) { range.push(`${tcol} <= ?`); args.push(opts.to); }
  const and = range.length ? ' AND ' + range.join(' AND ') : '';
  const iso = (t: Date | string | null) => (t ? new Date(t).toISOString() : null);
  let rows: Record<string, unknown>[];
  if (s.store === 'ohlcv') {
    const r = await getDb().prepare(`SELECT * FROM (SELECT ts, open, high, low, close, volume FROM wh_ohlcv WHERE series_id = ?${and}
      ORDER BY ts DESC LIMIT ${limit + 1}) x ORDER BY ts`).all(s.series_id, ...args) as { ts: Date; open: number; high: number; low: number; close: number; volume: number | null }[];
    rows = r.map(b => ({ t: iso(b.ts), o: Number(b.open), h: Number(b.high), l: Number(b.low), c: Number(b.close), v: b.volume == null ? null : Number(b.volume) }));
  } else if (s.store === 'values') {
    const r = await getDb().prepare(`SELECT * FROM (SELECT ts, value FROM wh_values WHERE series_id = ?${and}
      ORDER BY ts DESC LIMIT ${limit + 1}) x ORDER BY ts`).all(s.series_id, ...args) as { ts: Date; value: number | null }[];
    rows = r.map(p => ({ t: iso(p.ts), v: p.value == null ? null : Number(p.value) }));
  } else if (s.store === 'json') {
    const r = await getDb().prepare(`SELECT * FROM (SELECT idx_time, idx, data, fetched_at FROM wh_records WHERE hook_id = ? AND part = ?${and}
      ORDER BY idx_time DESC NULLS LAST, idx DESC LIMIT ${limit + 1}) x ORDER BY idx_time NULLS FIRST, idx`).all(s.hook_id, s.part, ...args) as
      { idx_time: Date | null; idx: string; data: unknown; fetched_at: Date }[];
    rows = r.map(j => ({ t: iso(j.idx_time), idx: j.idx, data: j.data, fetched: iso(j.fetched_at) }));
  } else if (s.store === 'options') {
    const snap = range.length ? '' : ' AND ts = (SELECT max(ts) FROM wh_options WHERE series_id = ?)';
    const r = await getDb().prepare(`SELECT ts, expiry, side, strike, last, bid, ask, volume, open_interest, iv, spot FROM wh_options
      WHERE series_id = ?${and}${snap} ORDER BY ts, expiry, side, strike LIMIT ${limit + 1}`)
      .all(s.series_id, ...args, ...(snap ? [s.series_id] : [])) as Record<string, unknown>[];
    rows = r.map(o => ({ t: iso(o.ts as Date), expiry: o.expiry instanceof Date ? o.expiry.toISOString().slice(0, 10) : o.expiry,
      side: o.side, strike: o.strike, last: o.last, bid: o.bid, ask: o.ask, volume: o.volume, oi: o.open_interest, iv: o.iv, spot: o.spot }));
  } else {
    return null;
  }
  const truncated = rows.length > limit;
  if (truncated) rows = s.store === 'options' ? rows.slice(0, limit) : rows.slice(rows.length - limit);
  return { series_id: Number(s.series_id), hook_id: s.hook_id, part: s.part, field: s.field, store: s.store, rows, truncated };
}
