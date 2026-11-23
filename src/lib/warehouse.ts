// Bars from the Data Hub warehouse (the wh_* tables in this database), for the Markets dashboard.

import { getDb } from '@/lib/db';

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export const SYMBOL_RE = /^[A-Z0-9._^=-]{1,15}$/;
export const RATE_RE = /^[A-Z]{1,2}\d{0,2}$/;

/** A symbol's bar series at a rate, from any source (stocks, ETFs, FX, crypto): the one still recording and most current, then the longest. */
export async function barsFor(symbol: string, rate = 'D', limit = 0): Promise<{ source: string | null; bars: Bar[] }> {
  const s = await getDb().prepare(`
    SELECT s.series_id, h.connection_name AS source FROM wh_series s JOIN wh_hooks h ON h.hook_id = s.hook_id
    WHERE s.store = 'ohlcv' AND h.key LIKE '%candles' AND h.params->>'data_rate' = ?
      AND (upper(h.params->>'instrument') = ? OR upper(h.params->>'ticker') = ?)
    ORDER BY h.enabled DESC, date_trunc('day', s.last_ts) DESC NULLS LAST, s.n_rows DESC NULLS LAST LIMIT 1`).get(rate, symbol, symbol) as { series_id: number; source: string } | undefined;
  if (!s) return { source: null, bars: [] };
  const rows = await getDb().prepare(limit
    ? `SELECT * FROM (SELECT ts, open, high, low, close, volume FROM wh_ohlcv WHERE series_id = ? ORDER BY ts DESC LIMIT ${Math.floor(limit)}) x ORDER BY ts`
    : `SELECT ts, open, high, low, close, volume FROM wh_ohlcv WHERE series_id = ? ORDER BY ts`).all(s.series_id) as
    { ts: Date | string; open: number; high: number; low: number; close: number; volume: number | null }[];
  return {
    source: s.source,
    bars: rows.map(r => ({ t: new Date(r.ts).getTime(), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume ?? 0) })),
  };
}

const DAY = 86400000;

// Chart intervals, finest first. A rate that isn't recorded for a symbol is built from a finer one.
const RATE_MS: Record<string, number> = {
  S10: 1e4, S15: 15e3, S30: 3e4, M1: 6e4, M2: 12e4, M4: 24e4, M5: 3e5, M10: 6e5, M15: 9e5, M30: 18e5,
  H1: 36e5, H2: 72e5, H3: 108e5, H4: 144e5, H6: 216e5, H8: 288e5, H12: 432e5, D: DAY, W: 7 * DAY, M: 30 * DAY,
};

function bucketOf(t: number, rate: string) {
  const d = new Date(t);
  if (rate === 'W') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);   // Monday
  if (rate === 'M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Math.floor(t / RATE_MS[rate]) * RATE_MS[rate];
}

/** Bars grouped into a coarser rate: first open, high/low over the group, last close, volume summed. */
export function resampleBars(bars: Bar[], rate: string): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const t = bucketOf(b.t, rate);
    if (!cur || cur.t !== t) { cur = { ...b, t }; out.push(cur); continue; }
    cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
  }
  return out;
}

/** The last `limit` bars of a symbol at a chart rate: recorded at that rate when there is a series,
 *  else built from the coarsest recorded finer rate. */
export async function barsAt(symbol: string, rate: string, limit: number): Promise<{ source: string | null; rate: string; bars: Bar[] }> {
  const exact = await barsFor(symbol, rate, limit);
  if (exact.bars.length || !RATE_MS[rate]) return { ...exact, rate };
  const finer = Object.keys(RATE_MS).filter(r => RATE_MS[r] < RATE_MS[rate]).reverse();
  for (const base of finer) {
    const per = Math.ceil(RATE_MS[rate] / RATE_MS[base]);
    const got = await barsFor(symbol, base, Math.min(200000, limit * per));
    if (got.bars.length) return { source: got.source, rate: `${rate} from ${base}`, bars: resampleBars(got.bars, rate).slice(-limit) };
  }
  return { source: null, rate, bars: [] };
}

/** Return over a look-back (calendar days, or 'ytd'), from the close at or before the start. */
function periodReturn(bars: Bar[], back: number | 'ytd'): number | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const from = back === 'ytd' ? Date.UTC(new Date(last.t).getUTCFullYear(), 0, 1) - 1 : last.t - back * DAY;
  let i = bars.length - 1;
  while (i > 0 && bars[i].t > from) i--;
  if (bars[i].t > from && i === 0) return null;   // history doesn't reach back that far
  return bars[i].c ? (last.c / bars[i].c - 1) * 100 : null;
}

/** Daily log returns keyed by day, for beta and correlation across symbols with different calendars. */
function dailyReturns(bars: Bar[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0 && bars[i].c > 0) out.set(Math.floor(bars[i].t / DAY), Math.log(bars[i].c / bars[i - 1].c));
  }
  return out;
}

function corrBeta(a: Map<number, number>, b: Map<number, number>): { corr: number | null; beta: number | null; n: number } {
  const xs: number[] = [], ys: number[] = [];
  for (const [d, x] of a) { const y = b.get(d); if (y !== undefined) { xs.push(x); ys.push(y); } }
  const n = xs.length;
  if (n < 20) return { corr: null, beta: null, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, beta: syy ? sxy / syy : null, n };
}

export interface CompareItem {
  symbol: string; source: string | null; last: number | null; asOf: number | null;
  returns: Record<'1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y', number | null>;
  vol: number | null; beta: number | null; maxDrawdown: number | null;
}

/** Side-by-side statistics for symbols (daily bars), with beta to a benchmark and a correlation matrix
 *  over the last year. Series are the last two years of closes, for charting. */
export async function compare(symbols: string[], bench = 'SPY') {
  const all = [...new Set([...symbols, bench])];
  const loaded = new Map(await Promise.all(all.map(async s => [s, await barsFor(s, 'D', 800)] as const)));
  const yearAgo = (bars: Bar[]) => bars.filter(b => b.t >= (bars.length ? bars[bars.length - 1].t : 0) - 365 * DAY);
  const rets = new Map(all.map(s => [s, dailyReturns(yearAgo(loaded.get(s)!.bars))]));
  const items: CompareItem[] = symbols.map(sym => {
    const { source, bars } = loaded.get(sym)!;
    const last = bars[bars.length - 1];
    const yr = yearAgo(bars);
    const r = [...rets.get(sym)!.values()].slice(-60);
    const mean = r.reduce((s, v) => s + v, 0) / (r.length || 1);
    const vol = r.length > 10 ? Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100 : null;
    let peak = -Infinity, dd = 0;
    for (const b of yr) { peak = Math.max(peak, b.c); dd = Math.min(dd, b.c / peak - 1); }
    return {
      symbol: sym, source, last: last?.c ?? null, asOf: last?.t ?? null,
      returns: { '1D': periodReturn(bars, 1.5), '1W': periodReturn(bars, 7), '1M': periodReturn(bars, 30), '3M': periodReturn(bars, 91),
                 'YTD': periodReturn(bars, 'ytd'), '1Y': periodReturn(bars, 365) },
      vol, beta: sym === bench ? 1 : corrBeta(rets.get(sym)!, rets.get(bench)!).beta,
      maxDrawdown: yr.length ? dd * 100 : null,
    };
  });
  const matrix = symbols.map(a => symbols.map(b => (a === b ? 1 : corrBeta(rets.get(a)!, rets.get(b)!).corr)));
  const series = Object.fromEntries(symbols.map(s => [s, loaded.get(s)!.bars.slice(-520).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))]));
  return { bench, items, corr: { symbols, matrix }, series };
}
