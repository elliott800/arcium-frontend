// Macro factors per country, read from the Data Hub warehouse (the wh_* tables in this database).
// Every country uses the same indicator list, so searching one country reads like searching any
// other; where a country has no series recorded for an indicator, it gets a recommended data plug
// (the source API and the series to add in the Data Hub). Values are FRED first releases, indexed
// by the period they describe (the warehouse also keeps when each was published).

import { getDb } from '@/lib/db';

export type Transform = 'level' | 'yoy' | 'change' | 'qoq_ann';
export interface Plug { connection: string; key: string; params: Record<string, string>; note?: string }
export interface Indicator {
  id: string; name: string; group: string; units: string; transform: Transform; decimals: number;
  /** what rising means, for the arrow colour: 'up' good, 'down' good, or neutral */
  better?: 'up' | 'down';
  source: Plug | null;   // null: no known source for this country yet
}

const GROUPS = ['Policy and rates', 'Inflation', 'Jobs', 'Growth', 'Money and credit', 'Markets'] as const;

const fred = (series_id: string): Plug => ({ connection: 'fred', key: 'series', params: { series_id } });

// [indicator id, name, group, units, transform, decimals, better]
const INDICATORS: [string, string, string, string, Transform, number, ('up' | 'down')?][] = [
  ['policy_rate', 'Policy rate', 'Policy and rates', '%', 'level', 2],
  ['overnight_rate', 'Overnight rate', 'Policy and rates', '%', 'level', 2],
  ['yield_2y', '2-year yield', 'Policy and rates', '%', 'level', 2],
  ['yield_10y', '10-year yield', 'Policy and rates', '%', 'level', 2],
  ['yield_30y', '30-year yield', 'Policy and rates', '%', 'level', 2],
  ['curve_10y_2y', 'Curve 10y − 2y', 'Policy and rates', 'pp', 'level', 2, 'up'],
  ['mortgage_30y', '30-year mortgage', 'Policy and rates', '%', 'level', 2, 'down'],
  ['breakeven_10y', '10-year breakeven inflation', 'Inflation', '%', 'level', 2],
  ['cpi', 'Consumer prices', 'Inflation', '% y/y', 'yoy', 1, 'down'],
  ['core_cpi', 'Core consumer prices', 'Inflation', '% y/y', 'yoy', 1, 'down'],
  ['core_pce', 'Core PCE prices', 'Inflation', '% y/y', 'yoy', 1, 'down'],
  ['ppi', 'Producer prices', 'Inflation', '% y/y', 'yoy', 1, 'down'],
  ['unemployment', 'Unemployment rate', 'Jobs', '%', 'level', 1, 'down'],
  ['payrolls', 'Payrolls, monthly change', 'Jobs', 'thousand', 'change', 0, 'up'],
  ['jobless_claims', 'Initial jobless claims', 'Jobs', 'claims', 'level', 0, 'down'],
  ['participation', 'Labour force participation', 'Jobs', '%', 'level', 1, 'up'],
  ['gdp', 'Real GDP', 'Growth', '% q/q ann.', 'qoq_ann', 1, 'up'],
  ['industrial_production', 'Industrial production', 'Growth', '% y/y', 'yoy', 1, 'up'],
  ['retail_sales', 'Retail sales', 'Growth', '% y/y', 'yoy', 1, 'up'],
  ['housing_starts', 'Housing starts', 'Growth', 'thousand, ann.', 'level', 0, 'up'],
  ['consumer_sentiment', 'Consumer sentiment', 'Growth', 'index', 'level', 1, 'up'],
  ['money_supply', 'Money supply (M2)', 'Money and credit', '% y/y', 'yoy', 1],
  ['central_bank_assets', 'Central bank balance sheet', 'Money and credit', '$ million', 'level', 0],
  ['high_yield_spread', 'High-yield credit spread', 'Money and credit', 'pp', 'level', 2, 'down'],
  ['baa_spread', 'BAA corporate spread', 'Money and credit', 'pp', 'level', 2, 'down'],
  ['financial_stress', 'Financial stress index', 'Money and credit', 'index', 'level', 2, 'down'],
  ['financial_conditions', 'Financial conditions (NFCI)', 'Money and credit', 'index', 'level', 2, 'down'],
  ['volatility', 'Equity volatility (VIX)', 'Markets', 'index', 'level', 1, 'down'],
  ['oil', 'Oil (WTI)', 'Markets', '$/bbl', 'level', 2],
  ['currency_index', 'Trade-weighted currency', 'Markets', 'index', 'level', 1],
];

// Which series each country uses. A missing indicator shows its recommended plug instead.
const COUNTRIES: Record<string, { name: string; series: Record<string, Plug> }> = {
  US: {
    name: 'United States',
    series: {
      policy_rate: fred('FEDFUNDS'), overnight_rate: fred('SOFR'), yield_2y: fred('DGS2'), yield_10y: fred('DGS10'),
      yield_30y: fred('DGS30'), curve_10y_2y: fred('T10Y2Y'), mortgage_30y: fred('MORTGAGE30US'), breakeven_10y: fred('T10YIE'),
      cpi: fred('CPIAUCSL'), core_cpi: fred('CPILFESL'), core_pce: fred('PCEPILFE'), ppi: fred('PPIACO'),
      unemployment: fred('UNRATE'), payrolls: fred('PAYEMS'), jobless_claims: fred('ICSA'), participation: fred('CIVPART'),
      gdp: fred('GDPC1'), industrial_production: fred('INDPRO'), retail_sales: fred('RSAFS'), housing_starts: fred('HOUST'),
      consumer_sentiment: fred('UMCSENT'), money_supply: fred('M2SL'), central_bank_assets: fred('WALCL'),
      high_yield_spread: fred('BAMLH0A0HYM2'), baa_spread: fred('BAA10Y'), financial_stress: fred('STLFSI4'),
      financial_conditions: fred('NFCI'), volatility: fred('VIXCLS'), oil: fred('DCOILWTICO'), currency_index: fred('DTWEXBGS'),
    },
  },
};

export const countries = () => Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name }));

export function indicatorsFor(country: string): Indicator[] | null {
  const c = COUNTRIES[country];
  if (!c) return null;
  return INDICATORS.map(([id, name, group, units, transform, decimals, better]) =>
    ({ id, name, group, units, transform, decimals, better, source: c.series[id] ?? null }));
}

export const groups = () => [...GROUPS];

export interface Point { t: number; v: number }   // t: the period described, ms since epoch

/** Any Data Hub value series stored as `value` + `period` fields (Cboe put/call, breadth ...): one point per period.
 *  `params` are matched exactly against the recording job's params. */
export async function hubValues(connection: string, key: string, params: Record<string, string | number>): Promise<Point[]> {
  const where = Object.keys(params).map(k => `h.params->>'${k.replace(/[^a-z_]/gi, '')}' = ?`).join(' AND ');
  const rows = await getDb().prepare(`
    SELECT p.value AS period, v.value AS value
    FROM wh_hooks h
    JOIN wh_series sv ON sv.hook_id = h.hook_id AND sv.field = 'value'
    JOIN wh_series sp ON sp.hook_id = h.hook_id AND sp.field = 'period'
    JOIN wh_values v ON v.series_id = sv.series_id
    JOIN wh_values p ON p.series_id = sp.series_id AND p.ts = v.ts
    WHERE h.connection_name = ? AND h.key = ? AND ${where} AND v.value IS NOT NULL
    ORDER BY p.value`).all(connection, key, ...Object.values(params).map(String)) as { period: number | string; value: number | string }[];
  const out: Point[] = [];
  for (const r of rows) {
    const t = Number(r.period) * 1000, v = Number(r.value);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (out.length && out[out.length - 1].t === t) out[out.length - 1].v = v; else out.push({ t, v });
  }
  return out;
}

/** A FRED series from the warehouse, one point per period, as FRED publishes it now (the Data Hub's 'latest'
 *  recording: revised values, the Discord hub's method, so year-on-year matches FRED's own charts). Falls back to the
 *  first-release values ('series') for a series the hub doesn't record that way yet. */
export async function fredSeries(seriesId: string): Promise<Point[]> {
  const latest = await getDb().prepare(`
    SELECT v.ts, v.value FROM wh_hooks h
    JOIN wh_series s ON s.hook_id = h.hook_id AND s.field = 'value'
    JOIN wh_values v ON v.series_id = s.series_id
    WHERE h.connection_name = 'fred' AND h.key = 'latest' AND h.params->>'series_id' = ? AND v.value IS NOT NULL
    ORDER BY v.ts`).all(seriesId) as { ts: Date | string; value: number | string }[];
  if (latest.length) return latest.map(r => ({ t: new Date(r.ts).getTime(), v: Number(r.value) })).filter(p => Number.isFinite(p.v));
  return fredFirstReleases(seriesId);
}

/** A FRED series' first releases: one point per period, the value as first published (point-in-time work). */
export async function fredFirstReleases(seriesId: string): Promise<Point[]> {
  const rows = await getDb().prepare(`
    SELECT p.value AS period, v.value AS value
    FROM wh_hooks h
    JOIN wh_series sv ON sv.hook_id = h.hook_id AND sv.field = 'value'
    JOIN wh_series sp ON sp.hook_id = h.hook_id AND sp.field = 'period'
    JOIN wh_values v ON v.series_id = sv.series_id
    JOIN wh_values p ON p.series_id = sp.series_id AND p.ts = v.ts
    WHERE h.connection_name = 'fred' AND h.key = 'series' AND h.params->>'series_id' = ? AND v.value IS NOT NULL
    ORDER BY p.value`).all(seriesId) as { period: number | string; value: number | string }[];
  const out: Point[] = [];
  for (const r of rows) {
    const t = Number(r.period) * 1000, v = Number(r.value);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (out.length && out[out.length - 1].t === t) out[out.length - 1].v = v; else out.push({ t, v });
  }
  return out;
}

const YEAR = 365.25 * 86400000;

/** The series as the indicator is read: year-on-year %, change, annualised quarterly %, or level. */
export function transform(points: Point[], how: Transform): Point[] {
  if (how === 'level') return points;
  if (how === 'change') return points.slice(1).map((p, i) => ({ t: p.t, v: p.v - points[i].v }));
  if (how === 'qoq_ann') return points.slice(1).map((p, i) => ({ t: p.t, v: (Math.pow(p.v / points[i].v, 4) - 1) * 100 }));
  const out: Point[] = [];   // yoy: against the latest point at least ~a year earlier
  let j = 0;
  for (const p of points) {
    while (j + 1 < points.length && points[j + 1].t <= p.t - YEAR + 20 * 86400000) j++;
    if (points[j].t <= p.t - YEAR + 20 * 86400000 && points[j].v) out.push({ t: p.t, v: (p.v / points[j].v - 1) * 100 });
  }
  return out;
}

export interface Reading {
  id: string; name: string; group: string; units: string; transform: Transform; decimals: number; better?: 'up' | 'down';
  status: 'ok' | 'missing' | 'no_source';
  plug: Plug | null;
  latest?: { t: number; v: number }; previous?: { t: number; v: number };
  spark?: number[];   // the last ~24 readings, for a small line on the card
}

/** Every indicator for a country with its latest reading, or what to plug in where it's missing. */
export async function readings(country: string): Promise<Reading[] | null> {
  const list = indicatorsFor(country);
  if (!list) return null;
  return Promise.all(list.map(async ind => {
    const base = { id: ind.id, name: ind.name, group: ind.group, units: ind.units, transform: ind.transform,
                   decimals: ind.decimals, better: ind.better, plug: ind.source };
    if (!ind.source) return { ...base, status: 'no_source' as const };
    const pts = ind.source.connection === 'fred' ? transform(await fredSeries(ind.source.params.series_id), ind.transform) : [];
    if (!pts.length) return { ...base, status: 'missing' as const };
    return { ...base, status: 'ok' as const, latest: pts[pts.length - 1], previous: pts[pts.length - 2],
             spark: pts.slice(-24).map(p => p.v) };
  }));
}
