import 'server-only';
// The series a Fusion chart names, read from the Data Hub warehouse on the server. A series is written in the
// content as a small expression:
//   fred:UNRATE                    a FRED series as recorded (first releases)
//   fred:CPIAUCSL@yoy              ... read as % y/y (also @change, @qoq_ann, @level)
//   price:SPY                      daily closes of a symbol (any source in the warehouse)
//   fred:FEDFUNDS - fred:CPIAUCSL@yoy   the difference of two series, the second taken as of each date of the first
// Nothing is filled in: a part that is not recorded makes the whole series "missing", named exactly.

import { fredSeries, hubValues, transform, type Point, type Transform } from '@/lib/macro';
import { barsFor } from '@/lib/warehouse';
import { SERIES_PART, seriesOp, seriesParts } from './series-expr';

export type Pt = [number, number];                 // [ms, value], compact for the page payload
export interface LoadedSeries {
  expr: string;
  points: Pt[];                                    // weekly last values when the source is daily
  last: { t: number; v: number } | null;           // the last observation, before any thinning
  missing: string[];                               // the parts not recorded in the Data Hub
  freq: 'D' | 'W' | 'M' | 'Q' | 'A' | null;
}

const PART = SERIES_PART;
const DAY = 86400000;

// A short server-side cache per series part, so the pages' live refresh (every minute) and several open panels
// read the warehouse once a minute at most, not once per request.
const TTL_MS = 60_000;
const recent = new Map<string, { at: number; pts: Promise<Point[]> }>();
function loadPart(part: string): Promise<Point[]> {
  const hit = recent.get(part);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pts;
  const pts = readPart(part);
  recent.set(part, { at: Date.now(), pts });
  pts.catch(() => recent.delete(part));
  if (recent.size > 2000) recent.delete(recent.keys().next().value!);
  return pts;
}

async function readPart(part: string): Promise<Point[]> {
  const m = part.match(PART);
  if (!m) return [];
  const [, kind, id, as] = m;
  if (kind === 'fred') {
    const pts = await fredSeries(id);
    return as ? transform(pts, as as Transform) : pts;
  }
  if (kind === 'putcall' || kind === 'breadth') {
    const pts = kind === 'putcall'
      ? await hubValues('cboe', 'putcall', { ratio: id.toLowerCase() })
      : await hubValues('yahoo', 'breadth.above_ma', { index: id.toUpperCase(), weeks: 50 });
    return as ? transform(pts, as as Transform) : pts;
  }
  const { bars } = await barsFor(id.toUpperCase(), 'D');
  const pts = bars.map(b => ({ t: b.t, v: b.c })).filter(p => Number.isFinite(p.v));
  return as ? transform(pts, as as Transform) : pts;
}

/** a / b, with b taken as of each date of a (the latest b at or before it) */
function ratioOf(a: Point[], b: Point[]): Point[] {
  const out: Point[] = [];
  let j = -1;
  for (const p of a) {
    while (j + 1 < b.length && b[j + 1].t <= p.t) j++;
    if (j >= 0 && b[j].v !== 0 && p.t - b[j].t < 120 * DAY) out.push({ t: p.t, v: p.v / b[j].v });
  }
  return out;
}

/** a − b, with b taken as of each date of a (the latest b at or before it) */
function difference(a: Point[], b: Point[]): Point[] {
  const out: Point[] = [];
  let j = -1;
  for (const p of a) {
    while (j + 1 < b.length && b[j + 1].t <= p.t) j++;
    if (j >= 0 && p.t - b[j].t < 120 * DAY) out.push({ t: p.t, v: p.v - b[j].v });
  }
  return out;
}

function frequency(pts: Point[]): LoadedSeries['freq'] {
  if (pts.length < 3) return null;
  const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((x, y) => x - y);
  const g = gaps[Math.floor(gaps.length / 2)] / DAY;
  return g <= 3 ? 'D' : g <= 10 ? 'W' : g <= 45 ? 'M' : g <= 120 ? 'Q' : 'A';
}

/** Daily data thinned to the last value of each week, so a page can carry decades of it. */
export function weekly(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const d = new Date(p.t);
    const wk = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    if (out.length && out[out.length - 1].t === wk) out[out.length - 1].v = p.v; else out.push({ t: wk, v: p.v });
  }
  return out;
}

const round = (v: number) => Number(v.toPrecision(6));

export async function loadSeries(expr: string, cache: Map<string, Promise<Point[]>>): Promise<LoadedSeries> {
  const parts = seriesParts(expr);
  const got = await Promise.all(parts.map(p => {
    if (!cache.has(p)) cache.set(p, loadPart(p).catch(() => []));
    return cache.get(p)!;
  }));
  const missing = parts.filter((_, i) => !got[i].length);
  if (missing.length) return { expr, points: [], last: null, missing, freq: null };
  const pts = got.length === 2 ? (seriesOp(expr) === 'ratio' ? ratioOf(got[0], got[1]) : difference(got[0], got[1])) : got[0];
  const freq = frequency(pts);
  const thin = freq === 'D' ? weekly(pts) : pts;
  const last = pts.length ? { t: pts[pts.length - 1].t, v: round(pts[pts.length - 1].v) } : null;
  return { expr, points: thin.map(p => [p.t, round(p.v)]), last, missing: pts.length ? [] : parts, freq };
}

/** Daily closes of a symbol (for the phase index and the cycle position). */
export async function closes(symbol: string, cache: Map<string, Promise<Point[]>>): Promise<Point[]> {
  const key = `price:${symbol.toUpperCase()}`;
  if (!cache.has(key)) cache.set(key, loadPart(key).catch(() => []));
  return cache.get(key)!;
}
