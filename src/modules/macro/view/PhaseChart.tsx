'use client';

// The sector phase indexes against a chosen denominator (UUP, GLD or SPY), on one Arcium chart with a
// look-back. The lines come from the server (src/lib/fusion/analytics.ts); a phase with an ETF not recorded
// is listed, not drawn.

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadArciumChart, type ArciumChartApi } from '@/lib/arcium-chart';

type Pt = [number, number];
export interface PhaseChartProps {
  phases: { phase: string; etfs: string[]; missing: string[] }[];
  denominators: { symbol: string; missing: boolean }[];
  lines: Record<string, Record<string, Pt[]>>;
  ratios: { name: string; num: string; den: string; missing: string[] }[];   // drawn whatever the denominator
  ratioLines: Record<string, Pt[]>;
  indexLines: Record<string, Pt[]>;                    // the straight index per phase (no denominator)
  last: number | null;
}

const LOOKBACKS: [string, number | null][] = [['1Y', 1], ['5Y', 5], ['10Y', 10], ['Max', null]];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLORS = ['#0D9FD8', '#f59e0b', '#10b981', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#f472b6'];
const RATIO_COLORS = ['#e2e8f0', '#94a3b8'];

const INDEX = '__index__';

export default function PhaseChart({ phases, denominators, lines, ratios, ratioLines, indexLines, last }: PhaseChartProps) {
  const dens = denominators.filter(d => !d.missing).map(d => d.symbol);
  const [den, setDen] = useState(dens[0] ?? INDEX);
  const src = useMemo(() => den === INDEX ? indexLines : (lines[den] ?? {}), [den, indexLines, lines]);
  const dLabel = den === INDEX ? 'index (no ratio)' : `/ ${den}`;
  const [lb, setLb] = useState('5Y');
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ArciumChartApi | null>(null);
  const drawn = phases.filter(p => (src[p.phase] ?? []).length);

  useEffect(() => {
    if (!den || !last) return;
    let gone = false;
    const years = LOOKBACKS.find(l => l[0] === lb)?.[1] ?? null;
    const from = years === null ? -Infinity : last - years * 365.25 * 86400000;
    loadArciumChart().then(lib => {
      if (gone || !box.current) return;
      chart.current ??= lib.create(box.current, { height: 300 });
      chart.current.setData({
        mode: 'compare',
        series: [
          ...phases.map((p, i) => ({ id: p.phase, name: `${p.phase} (${p.etfs.join(', ')}) ${dLabel}`, color: COLORS[i % COLORS.length],
            data: (src[p.phase] ?? []).filter(([t]) => t >= from).map(([t, c]) => ({ t, c })) })),
          ...ratios.map((r, i) => ({ id: `ratio-${r.name}`, name: `${r.name}`, color: RATIO_COLORS[i % RATIO_COLORS.length],
            data: (ratioLines[r.name] ?? []).filter(([t]) => t >= from).map(([t, c]) => ({ t, c })) })),
        ].filter(s => s.data.length),
      });
    }).catch(() => {});
    return () => { gone = true; };
  }, [den, dLabel, src, lb, phases, ratios, ratioLines, last]);
  useEffect(() => () => { chart.current?.destroy(); chart.current = null; }, []);

  const missingDens = denominators.filter(d => d.missing).map(d => d.symbol);
  const pending = phases.filter(p => p.missing.length);
  return (
    <div className="fu-phasechart">
      {drawn.length > 0 && (<>
        <div className="fu-chart-tools">
          <div className="m-seg" role="group" aria-label="Denominator">
            {dens.map(d => <button key={d} type="button" className={den === d ? 'on' : ''} aria-pressed={den === d} onClick={() => setDen(d)}>vs {d}</button>)}
            <button type="button" className={den === INDEX ? 'on' : ''} aria-pressed={den === INDEX} onClick={() => setDen(INDEX)}>Index only</button>
          </div>
          <div className="m-seg" role="group" aria-label="Look-back">
            {LOOKBACKS.map(([l]) => <button key={l} type="button" className={lb === l ? 'on' : ''} aria-pressed={lb === l} onClick={() => setLb(l)}>{l}</button>)}
          </div>
        </div>
        <div ref={box} className="m-chart fu-phase-canvas" role="img" aria-label={`Sector phase indexes against ${den}, % change over the look-back`} />
        <p className="fu-note">Each line: the phase&apos;s ETFs weighted by inverse volatility (trailing 252 trading days, reset monthly), divided by {den},
          shown as % change over the look-back.{ratios.length ? ` ${ratios.map(r => r.name).join(' and ')} are drawn on the same scale and don't change with the denominator.` : ''} Weekly, last close{last ? ` ${new Date(last).getUTCDate()} ${MON[new Date(last).getUTCMonth()]} ${new Date(last).getUTCFullYear()}` : ''}.</p>
      </>)}
      {(pending.length > 0 || missingDens.length > 0) && (
        <ul className="fu-pending-list">
          {pending.map(p => (
            <li key={p.phase}><span className="fu-pending-dot" aria-hidden="true" /> {p.phase}: data pending, {[...new Set(p.missing)].map(m => <code key={m}>price:{m}</code>)} not recorded in the Data Hub yet</li>
          ))}
          {ratios.filter(r => r.missing.length).map(r => (
            <li key={r.name}><span className="fu-pending-dot" aria-hidden="true" /> {r.name}: data pending, {[...new Set(r.missing)].map(m => <code key={m}>price:{m}</code>)} not recorded in the Data Hub yet</li>
          ))}
          {missingDens.map(d => <li key={d}><span className="fu-pending-dot" aria-hidden="true" /> Denominator {d}: data pending, <code>price:{d}</code></li>)}
        </ul>
      )}
    </div>
  );
}
