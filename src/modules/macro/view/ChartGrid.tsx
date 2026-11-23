'use client';

// Small multiples of the core economic series on the Arcium chart, with the workbook's look-back and interval
// controls. Each chart shows its last observation (value and date: some recorded series are stale) and where
// that value sits within the look-back (its percentile). A chart without a recorded series says exactly which
// series it waits for; nothing is drawn for it.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '@/ui/kit';
import { loadArciumChart, type ArciumChartApi } from '@/lib/arcium-chart';

export type Pt = [number, number];
export interface TileSeries { expr: string; data: Pt[] | null; missing: string[] }
export interface TileData {
  section?: string;                 // the heading this tile sits under (from `sections:` in the content)
  name: string;
  units: string;
  main: TileSeries | null;          // one series
  compare: TileSeries[];            // or several, drawn together as % change from the start of the look-back
  lines?: (TileSeries & { name: string; units: string; last: { t: number; v: number } | null })[];   // or several levels on one chart
  last: { t: number; v: number } | null;
  needs: string | null;             // what a chart with no series named yet is waiting for
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;
const when = (t: number) => { const d = new Date(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmt = (v: number) => {
  const a = Math.abs(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : a >= 100 ? 1 : 2, minimumFractionDigits: a >= 1000 ? 0 : a >= 100 ? 1 : 2 });
};
const YEARS: Record<string, number | null> = { '1y': 1, '2y': 2, '5y': 5, '10y': 10, '20y': 20, max: null };
const LABEL = (lb: string) => (lb === 'max' ? 'Max' : lb.toUpperCase());
const INTERVAL_LABEL: Record<string, string> = { D: 'Daily', W: 'Weekly', M: 'Monthly', Q: 'Quarterly' };

function bucket(t: number, iv: string) {
  const d = new Date(t);
  if (iv === 'D') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (iv === 'W') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  if (iv === 'M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
}

/** The points in the look-back, at the interval (the last value of each period), or as recorded. */
function view(data: Pt[], from: number, iv: string): Pt[] {
  const inRange = data.filter(p => p[0] >= from);
  if (!iv) return inRange;
  const out: Pt[] = [];
  for (const [t, v] of inRange) {
    const b = bucket(t, iv);
    if (out.length && out[out.length - 1][0] === b) out[out.length - 1] = [b, v]; else out.push([b, v]);
  }
  return out;
}

function MiniChart({ tile, from, iv, palette }: { tile: TileData; from: number; iv: string; palette: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ArciumChartApi | null>(null);
  useEffect(() => {
    let gone = false;
    loadArciumChart().then(lib => {
      if (gone || !box.current) return;
      chart.current ??= lib.create(box.current, { height: 120 });
      const lines = (tile.lines ?? []).filter(l => l.data);
      const series = lines.length
        ? lines.map((l, i) => ({ id: `l${i}`, name: l.name, color: palette[i % palette.length], data: view(l.data!, from, iv).map(([t, c]) => ({ t, c })) }))
        : tile.main?.data
        ? [{ id: 'a', name: tile.name, color: palette[0], data: view(tile.main.data, from, iv).map(([t, c]) => ({ t, c })) }]
        : tile.compare.filter(s => s.data).map((s, i) => ({ id: `c${i}`, name: s.expr, color: palette[i % palette.length],
            data: view(s.data!, from, iv).map(([t, c]) => ({ t, c })) }));
      chart.current.setData({ mode: tile.main || lines.length ? 'line' : 'compare', series, format: fmt });
    }).catch(() => {});
    return () => { gone = true; };
  }, [tile, from, iv, palette]);
  useEffect(() => () => { chart.current?.destroy(); chart.current = null; }, []);
  return <div ref={box} className="fu-mini-chart m-chart" role="img" aria-label={`${tile.name} chart`} />;
}

function Tile({ tile, from, lb, iv, palette }: { tile: TileData; from: number; lb: string; iv: string; palette: string[] }) {
  const now = useNow(3_600_000);                       // "old" means a year and more: hourly is plenty
  const parts = [...(tile.main ? [tile.main] : []), ...tile.compare, ...(tile.lines ?? [])];
  const missing = [...new Set(parts.flatMap(p => p.missing))];   // series shared by several lines are listed once
  if (!parts.length || missing.length) {
    return (
      <li className="fu-mini is-pending">
        <div className="fu-mini-name">{tile.name}</div>
        <p className="fu-mini-pending"><span className="fu-pending-dot" aria-hidden="true" /> Data pending:{' '}
          {missing.length ? missing.map(m => <code key={m}>{m}</code>) : <span>{tile.needs}</span>}
          {missing.length ? <span className="fu-mini-why"> not recorded in the Data Hub yet</span> : null}</p>
      </li>
    );
  }
  const shown = tile.main?.data ? view(tile.main.data, from, iv) : [];
  const pct = tile.main && tile.last && shown.length > 1
    ? Math.round((shown.filter(p => p[1] <= tile.last!.v).length / shown.length) * 100) : null;
  const old = tile.last ? now - tile.last.t > 400 * DAY : false;
  return (
    <li className="fu-mini">
      <div className="fu-mini-name">{tile.name}</div>
      {tile.lines?.length ? (
        <div className="fu-mini-read fu-mini-lines">{tile.lines.map((l, i) => (
          <span key={l.expr}><i style={{ background: palette[i % palette.length] }} />{l.name}{' '}
            <b>{l.last ? fmt(l.last.v) : '–'}</b><small> {l.units}</small>{l.last ? <em> {when(l.last.t)}</em> : null}</span>))}</div>
      ) : tile.main && tile.last ? (
        <div className="fu-mini-read">
          <span className="fu-mini-value">{fmt(tile.last.v)}<small> {tile.units}</small></span>
          <span className={old ? 'fu-mini-date is-old' : 'fu-mini-date'} title="Last observation">{when(tile.last.t)}{old ? ' · stale' : ''}</span>
        </div>
      ) : (
        <div className="fu-mini-read"><span className="fu-mini-legend">{tile.compare.map((s, i) => (
          <span key={s.expr}><i style={{ background: palette[i % palette.length] }} />{s.expr}</span>))}</span></div>
      )}
      <MiniChart tile={tile} from={from} iv={iv} palette={palette} />
      <div className="fu-mini-foot">
        <code title="Series">{tile.lines?.length ? tile.lines.map(l => l.expr).join(' · ') : tile.main ? tile.main.expr : '% change over the look-back'}</code>
        {pct !== null && <span title={`Where the last value sits within the ${LABEL(lb)} look-back`}>{pct}th pct · {LABEL(lb)}</span>}
      </div>
    </li>
  );
}

export default function ChartGrid({ id, tiles, lookbacks, intervals }: { id: string; tiles: TileData[]; lookbacks: string[]; intervals: string[] }) {
  const lbs = lookbacks.filter(l => l in YEARS);
  const [lb, setLb] = useState(lbs.includes('10y') ? '10y' : lbs[lbs.length - 1] ?? 'max');
  const [iv, setIv] = useState('');
  const [palette, setPalette] = useState<string[]>(['#0D9FD8', '#f59e0b', '#10b981', '#a855f7']);
  useEffect(() => { loadArciumChart().then(l => { if (l.palette?.length) setPalette(l.palette); }).catch(() => {}); }, []);
  // "now" is the latest observation on the grid, so a look-back reads the same however stale the data is
  const now = useMemo(() => Math.max(0, ...tiles.flatMap(t => [t.last?.t ?? 0, ...t.compare.map(c => c.data?.at(-1)?.[0] ?? 0), ...(t.lines ?? []).map(l => l.last?.t ?? 0)])), [tiles]);
  const years = YEARS[lb];
  const from = years === null || !now ? -Infinity : now - years * 365.25 * DAY;
  const ivs = intervals.filter(i => i in INTERVAL_LABEL);
  return (
    <div className="fu-chartgrid">
      <div className="fu-chart-tools">
        <div className="m-seg" role="group" aria-label="Look-back">
          {lbs.map(l => <button key={l} type="button" className={lb === l ? 'on' : ''} aria-pressed={lb === l} onClick={() => setLb(l)}>{LABEL(l)}</button>)}
        </div>
        {ivs.length > 0 && (
          <div className="m-seg" role="group" aria-label="Interval">
            <button type="button" className={!iv ? 'on' : ''} aria-pressed={!iv} onClick={() => setIv('')}>As recorded</button>
            {ivs.map(i => <button key={i} type="button" className={iv === i ? 'on' : ''} aria-pressed={iv === i} onClick={() => setIv(i)}>{INTERVAL_LABEL[i]}</button>)}
          </div>
        )}
      </div>
      <ul className="fu-grid" id={id}>
        {tiles.map((t, i) => (
          <Fragment key={`${i}-${t.name}`}>
            {t.section && t.section !== tiles[i - 1]?.section ? <li className="fu-grid-head" role="presentation"><h3>{t.section}</h3></li> : null}
            <Tile tile={t} from={from} lb={lb} iv={iv} palette={palette} />
          </Fragment>
        ))}
      </ul>
    </div>
  );
}
