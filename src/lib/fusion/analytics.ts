import 'server-only';
// The two derived views the workbook defines, computed from recorded prices only.
//
// Sector phase index (macro/sector-rotation): each phase is a volatility-weighted index of its ETFs: daily
// returns weighted by inverse volatility (the trailing 252 trading days, weights reset at each month start),
// chained from 1; then divided by the chosen denominator's price (also from 1), so the line is the phase's
// strength against UUP, GLD or SPY. A phase with an ETF not recorded is not drawn, and says which.
//
// Cycle position (playbook/cycles): the six stages read from whether bonds, stocks and commodities are each in
// an uptrend (month-end close above its 10-month average): 1 bonds up only; 2 bonds and stocks; 3 all three;
// 4 stocks and commodities; 5 commodities only; 6 none. The other two mixes are outside the six-stage path.

import type { Point } from '@/lib/macro';
import { closes, weekly, type Pt } from './series';

type Cache = Map<string, Promise<Point[]>>;
const round = (v: number) => Number(v.toPrecision(6));

export interface PhaseLine { phase: string; etfs: string[]; missing: string[]; start: number | null }
export interface PhaseRatio { name: string; num: string; den: string; missing: string[] }
export interface PhaseIndexData {
  phases: PhaseLine[];
  ratios: PhaseRatio[];                             // fixed ratios drawn whatever the denominator (VUG/VTV, IWO/DIA)
  ratioLines: Record<string, Pt[]>;                 // ratio name -> weekly ratio
  denominators: { symbol: string; missing: boolean }[];
  lines: Record<string, Record<string, Pt[]>>;     // denominator -> phase -> weekly ratio
  indexLines: Record<string, Pt[]>;                 // phase -> weekly straight index (no denominator)
  last: number | null;                              // the last date all drawn lines share
}

function dayKey(t: number) { return Math.floor(t / 86400000); }

function phaseIndex(series: Point[][]): Point[] {
  // dates every member has, in order
  const maps = series.map(s => new Map(s.map(p => [dayKey(p.t), p])));
  const days = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort((a, b) => a - b);
  if (days.length < 260) return [];
  const rets = series.map((_, i) => days.map((d, k) => (k ? Math.log(maps[i].get(d)!.v / maps[i].get(days[k - 1])!.v) : 0)));
  const out: Point[] = [];
  let level = 1, w: number[] = [], month = -1;
  for (let k = 252; k < days.length; k++) {
    const m = new Date(days[k] * 86400000).getUTCMonth();
    if (m !== month || !w.length) {
      month = m;
      const inv = rets.map(r => {
        const win = r.slice(k - 252, k), mean = win.reduce((a, b) => a + b, 0) / win.length;
        const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / (win.length - 1));
        return sd > 0 ? 1 / sd : 0;
      });
      const sum = inv.reduce((a, b) => a + b, 0);
      w = inv.map(x => (sum ? x / sum : 1 / inv.length));
    }
    if (k > 252) level *= 1 + rets.reduce((a, r, i) => a + w[i] * (Math.exp(r[k]) - 1), 0);
    out.push({ t: days[k] * 86400000, v: level });
  }
  return out;
}

function ratio(index: Point[], den: Point[]): Point[] {
  const dm = new Map(den.map(p => [dayKey(p.t), p.v]));
  const out: Point[] = [];
  let base: number | null = null, i0 = 0;
  for (const p of index) {
    const d = dm.get(dayKey(p.t));
    if (d === undefined) continue;
    if (base === null) { base = d; i0 = p.v; }
    out.push({ t: p.t, v: (p.v / i0) / (d / base) });
  }
  return out;
}

export async function phaseIndexData(phases: { phase: string; etfs: string[] }[], denominators: string[], cache: Cache,
                                     fixed: { name: string; num: string; den: string }[] = []): Promise<PhaseIndexData> {
  const lines: PhaseIndexData['lines'] = {};
  const meta: PhaseLine[] = [];
  const indexes: Record<string, Point[]> = {};
  for (const ph of phases) {
    const got = await Promise.all(ph.etfs.map(e => closes(e, cache)));
    const missing = ph.etfs.filter((_, i) => !got[i].length);
    const idx = missing.length ? [] : phaseIndex(got);
    indexes[ph.phase] = idx;
    meta.push({ phase: ph.phase, etfs: ph.etfs, missing, start: idx[0]?.t ?? null });
  }
  const indexLines: Record<string, Pt[]> = {};
  for (const ph of meta) indexLines[ph.phase] = indexes[ph.phase].length ? weekly(indexes[ph.phase]).map(p => [p.t, round(p.v)]) : [];
  const dens = await Promise.all(denominators.map(async d => ({ symbol: d, pts: await closes(d, cache) })));
  let last: number | null = null;
  for (const d of dens) {
    lines[d.symbol] = {};
    if (!d.pts.length) continue;
    for (const ph of meta) {
      const pts = indexes[ph.phase].length ? weekly(ratio(indexes[ph.phase], d.pts)) : [];
      lines[d.symbol][ph.phase] = pts.map(p => [p.t, round(p.v)]);
      if (pts.length) last = last === null ? pts[pts.length - 1].t : Math.min(last, pts[pts.length - 1].t);
    }
  }
  const ratios: PhaseRatio[] = [];
  const ratioLines: Record<string, Pt[]> = {};
  for (const r of fixed) {
    const [a, b] = await Promise.all([closes(r.num, cache), closes(r.den, cache)]);
    const missing = [...(a.length ? [] : [r.num]), ...(b.length ? [] : [r.den])];
    ratios.push({ ...r, missing });
    if (!missing.length) {
      const pts = weekly(ratio(a, b));
      ratioLines[r.name] = pts.map(p => [p.t, round(p.v)]);
      if (pts.length) last = last === null ? pts[pts.length - 1].t : Math.min(last, pts[pts.length - 1].t);
    }
  }
  return { phases: meta, ratios, ratioLines, indexLines, denominators: dens.map(d => ({ symbol: d.symbol, missing: !d.pts.length })), lines, last };
}

export interface CycleLeg { role: 'bonds' | 'stocks' | 'commodities'; symbol: string; proxyFor: string | null; missing: boolean; last: number | null }
export interface CycleMonth { t: number; stage: number | null; up: [boolean, boolean, boolean] }
export interface CyclePositionData { legs: CycleLeg[]; months: CycleMonth[] }

const STAGE: Record<string, number> = { UDD: 1, UUD: 2, UUU: 3, DUU: 4, DDU: 5, DDD: 6 };

function monthEnds(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const d = new Date(p.t), m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (out.length && out[out.length - 1].t === m) out[out.length - 1].v = p.v; else out.push({ t: m, v: p.v });
  }
  return out;
}

/** Above the 10-month average, by month. */
function trend(pts: Point[]): Map<number, boolean> {
  const me = monthEnds(pts), out = new Map<number, boolean>();
  for (let i = 9; i < me.length; i++) {
    const avg = me.slice(i - 9, i + 1).reduce((a, p) => a + p.v, 0) / 10;
    out.set(me[i].t, me[i].v > avg);
  }
  return out;
}

export async function cyclePositionData(spec: { bonds: string; stocks: string; commodities: string; commodities_proxy?: string }, cache: Cache): Promise<CyclePositionData> {
  const roles = ['bonds', 'stocks', 'commodities'] as const;
  const legs: CycleLeg[] = [];
  const trends: Map<number, boolean>[] = [];
  for (const role of roles) {
    let symbol = spec[role], proxyFor: string | null = null;
    let pts = await closes(symbol, cache);
    if (!pts.length && role === 'commodities' && spec.commodities_proxy) {
      proxyFor = symbol; symbol = spec.commodities_proxy; pts = await closes(symbol, cache);
    }
    legs.push({ role, symbol, proxyFor, missing: !pts.length, last: pts.length ? pts[pts.length - 1].t : null });
    trends.push(trend(pts));
  }
  if (legs.some(l => l.missing)) return { legs, months: [] };
  const months = [...trends[0].keys()].filter(m => trends[1].has(m) && trends[2].has(m)).sort((a, b) => a - b).map(t => {
    const up = trends.map(tr => tr.get(t)!) as [boolean, boolean, boolean];
    return { t, up, stage: STAGE[up.map(u => (u ? 'U' : 'D')).join('')] ?? null };
  });
  return { legs, months };
}
