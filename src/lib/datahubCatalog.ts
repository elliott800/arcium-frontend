import 'server-only';
// The Data Hub's streams, classified for searching: each recorded series gets an asset class (the six main
// classes, or "economic" for macro and sentiment indicators), an instrument type (spot, futures, swaps, options)
// and tags (class, type, source, kind, rate, state, source:symbol). Cached for a minute; it's metadata only.

import { getDb } from '@/lib/db';
import { mainClassOf } from '@/lib/instruments';

export type StreamClass = 'stock' | 'commodity' | 'currency' | 'realestate' | 'bond' | 'crypto' | 'economic' | 'other';
export type Derivative = 'spot' | 'futures' | 'swaps' | 'options';
export interface CatalogStream {
  series_id: number; store: string; part: string; field: string; rows: number; first: string | null; last: string | null;
  hook_id: string; source: string; key: string; symbol: string; rate: string | null; enabled: boolean; every: number;
  status: string | null; error: string | null; fresh: boolean;
  asset_class: StreamClass; derivative: Derivative; kind: string; tags: string[];
}

// CFTC market codes (Commitments of Traders) -> the futures' asset class
const COT: Record<string, StreamClass> = {
  '099741': 'currency', '097741': 'currency', '096742': 'currency', '090741': 'currency', '092741': 'currency',
  '232741': 'currency', '112741': 'currency', '095741': 'currency', '098662': 'currency', '088691': 'commodity',
  '067651': 'commodity', '13874A': 'stock',
};
const ECONOMIC_SOURCES = new Set(['fred', 'cboe']);

function classifyStream(r: Omit<CatalogStream, 'asset_class' | 'derivative' | 'kind' | 'tags'> & { params: Record<string, unknown> }) {
  const kind = r.key.split('.').pop() ?? r.key;
  const area = r.key.includes('.') ? r.key.split('.')[0] : '';
  let derivative: Derivative = 'spot';
  let cls: StreamClass;
  if (r.store === 'options' || area === 'options' || kind === 'contracts') derivative = 'options';
  if (r.source.startsWith('cftc')) derivative = 'futures';
  if (ECONOMIC_SOURCES.has(r.source) || kind === 'above_ma') cls = 'economic';
  else if (r.source.startsWith('cftc')) cls = COT[String(r.params.market_code ?? '')] ?? 'other';
  else if (r.source === 'sec_edgar' || kind === 'fundamentals' || kind === 'valuation') cls = 'stock';
  else if (r.source === 'holdings') cls = mainClassOf(r.symbol, 'yahoo.etfs') as StreamClass;
  else cls = (mainClassOf(r.symbol, area ? `${r.source}.${area}` : r.source) as StreamClass) || 'other';
  if (r.source.startsWith('oanda') && cls === 'stock') cls = /^(XAU|XAG|XPT|XPD|BCO|WTICO|NATGAS|CORN|WHEAT|SOYBN|SUGAR|XCU)/.test(r.symbol) ? 'commodity' : /^[A-Z]{3}_[A-Z]{3}$/.test(r.symbol) ? 'currency' : 'other';
  const state = !r.enabled ? 'off' : r.status && r.status !== 'ok' ? 'error' : r.fresh ? 'fresh' : 'stale';
  const tags = [...new Set([cls, derivative, r.source, kind, ...(r.rate ? [r.rate.toLowerCase()] : []), state,
    ...(r.symbol ? [`${r.source}:${r.symbol}`.toLowerCase()] : [])])];
  return { asset_class: cls, derivative, kind, tags };
}

let cache: { at: number; rows: Promise<CatalogStream[]> } | null = null;

export function catalogStreams(): Promise<CatalogStream[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const rows = (async () => {
    const raw = await getDb().prepare(`
      SELECT s.series_id, s.store, s.part, s.field, s.n_rows AS rows, s.first_ts AS first, s.last_ts AS last,
             h.hook_id, h.connection_name AS source, h.key,
             upper(coalesce(h.params->>'instrument', h.params->>'ticker', h.params->>'series_id', h.params->>'symbol',
                            h.params->>'fund', h.params->>'index', h.params->>'ratio', h.params->>'market_code', '')) AS symbol,
             h.params->>'data_rate' AS rate, h.params, h.enabled, h.interval_seconds AS every, h.last_status AS status,
             h.last_error AS error,
             (h.enabled AND h.last_status = 'ok' AND h.last_run_at > now() - make_interval(secs => GREATEST(h.interval_seconds * 3, 3600))) AS fresh
      FROM wh_series s JOIN wh_hooks h USING (hook_id)`).all() as (Omit<CatalogStream, 'asset_class' | 'derivative' | 'kind' | 'tags'> & { params: Record<string, unknown> })[];
    return raw.map(r => {
      const params = typeof r.params === 'string' ? JSON.parse(r.params as unknown as string) : r.params;
      const { params: _p, ...rest } = { ...r, params };
      return { ...rest, rows: Number(r.rows ?? 0), ...classifyStream({ ...r, params }) };
    });
  })();
  cache = { at: Date.now(), rows };
  rows.catch(() => { cache = null; });
  return rows;
}

export interface SourceRow {
  connection: string; type: string; enabled: boolean; error: string | null;
  keys: { key: string; hooks: number; on: number; failing: number; rows: number; last_run: string | null; every: number | null }[];
}

/** Every registered source connection with the jobs (hooks) it handles, by key. */
export async function catalogSources(): Promise<SourceRow[]> {
  const conns = await getDb().prepare(`SELECT connection_name, connector_type, enabled, last_error FROM wh_connections ORDER BY connection_name`).all() as
    { connection_name: string; connector_type: string; enabled: boolean; last_error: string | null }[];
  const keys = await getDb().prepare(`
    SELECT h.connection_name, h.key, count(*)::int AS hooks, count(*) FILTER (WHERE h.enabled)::int AS on,
           count(*) FILTER (WHERE h.enabled AND h.last_status IS NOT NULL AND h.last_status <> 'ok')::int AS failing,
           coalesce(sum((SELECT sum(s.n_rows) FROM wh_series s WHERE s.hook_id = h.hook_id)), 0)::bigint AS rows,
           max(h.last_run_at) AS last_run, min(h.interval_seconds) AS every
    FROM wh_hooks h GROUP BY 1, 2 ORDER BY 1, 2`).all() as { connection_name: string; key: string; hooks: number; on: number; failing: number; rows: number | string; last_run: string | null; every: number | null }[];
  return conns.map(c => ({
    connection: c.connection_name, type: c.connector_type, enabled: c.enabled, error: c.last_error,
    keys: keys.filter(k => k.connection_name === c.connection_name).map(k => ({ key: k.key, hooks: k.hooks, on: k.on, failing: k.failing, rows: Number(k.rows), last_run: k.last_run, every: k.every })),
  }));
}
