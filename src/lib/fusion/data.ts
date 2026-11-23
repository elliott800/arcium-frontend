import 'server-only';
// The live data a set of Fusion pages asks for, read once per request on the server and handed to the
// controls. Only what the Data Hub warehouse already holds: US macro readings for factor rows that name an
// indicator, the FRED and price series the chart grids name, the ETF prices behind the sector phase index and
// the cycle position. Everything else stays "data pending" with its exact source.

import { readings, type Point, type Reading } from '@/lib/macro';
import { cyclePositionData, phaseIndexData, type CyclePositionData, type PhaseIndexData } from './analytics';
import { chartTiles, factorSeries, parseControl, playbookOutlines, type FusionPage } from './content';
import { loadSeries, type LoadedSeries } from './series';

export interface MacroData { country: string; readings: Record<string, Reading>; error: string | null }
export interface FusionData {
  macro: MacroData | null;
  series: Record<string, LoadedSeries>;
  phases: Record<string, PhaseIndexData>;
  cycles: Record<string, CyclePositionData>;
  outlines: Record<string, { title: string; summary: string }>;
  embed: boolean;               // links the controls make stay inside a Workspace panel
}

export const NO_DATA: FusionData = { macro: null, series: {}, phases: {}, cycles: {}, outlines: {}, embed: false };

type Spec = Record<string, unknown>;
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** The key a phases or cycle-position control's data is stored under (the same spec gives the same key). */
export function phasesKey(spec: Spec) {
  return JSON.stringify([list(spec.phases).map(p => [(p as Spec).phase, (p as Spec).etfs]), spec.denominators]);
}
export function cycleKey(spec: Spec) {
  return JSON.stringify([spec.bonds, spec.stocks, spec.commodities, spec.commodities_proxy ?? null]);
}

function specsOf(pages: { body: string; file: string }[]): Spec[] {
  return pages.flatMap(p => [...p.body.matchAll(/```control\n([\s\S]*?)```/g)].map(b => parseControl(b[1], p.file)));
}

export async function dataFor(pages: { body: string; file: string; controls?: FusionPage['controls'] }[], opts: { embed?: boolean } = {}): Promise<FusionData> {
  const specs = specsOf(pages);
  const out: FusionData = { ...NO_DATA, series: {}, phases: {}, cycles: {}, outlines: {}, embed: !!opts.embed };
  const cache = new Map<string, Promise<Point[]>>();

  if (specs.some(s => s.type === 'factor-levels' && list(s.rows).some(r => (r as Spec)?.reading !== undefined))) {
    try {
      const got = await readings('US');
      out.macro = { country: 'US', readings: Object.fromEntries((got ?? []).map(r => [r.id, r])), error: null };
    } catch {
      out.macro = { country: 'US', readings: {}, error: 'The Data Hub warehouse could not be read on this server.' };
    }
  }

  const factorExprs = specs.filter(s => s.type === 'factor-levels').flatMap(s => list(s.rows).flatMap(r => factorSeries(r as Spec).map(f => f.series)));
  const exprs = [...new Set([...factorExprs, ...specs.filter(s => s.type === 'chart-grid').flatMap(s => chartTiles(s).flatMap(t => [...(t.series ? [t.series] : []), ...t.compare, ...t.lines.map(l => l.series)]))])];
  const loaded = await Promise.all(exprs.map(e => loadSeries(e, cache)));
  for (const s of loaded) out.series[s.expr] = s;

  for (const s of specs.filter(x => x.type === 'phases' && x.compute !== false)) {
    const phases = list(s.phases).map(p => ({ phase: String((p as Spec).phase), etfs: list((p as Spec).etfs).map(String) }));
    const fixed = list(s.ratios).map(r => ({ name: String((r as Spec).name), num: String((r as Spec).num).toUpperCase(), den: String((r as Spec).den).toUpperCase() }));
    out.phases[phasesKey(s)] = await phaseIndexData(phases, list(s.denominators).map(String), cache, fixed);
  }
  for (const s of specs.filter(x => x.type === 'cycle-position')) {
    out.cycles[cycleKey(s)] = await cyclePositionData(s as { bonds: string; stocks: string; commodities: string; commodities_proxy?: string }, cache);
  }
  if (specs.some(s => s.type === 'outline')) {
    for (const o of playbookOutlines()) out.outlines[o.slug] = { title: o.title, summary: o.summary };
  }
  return out;
}
