// The page controls a ```control block in the Fusion content turns into. Controls that need live data say which
// source they wait for ("data pending") and never show made-up numbers; what the Data Hub warehouse already
// holds (factor readings, chart series, the ETF prices behind the phase index and cycle position) comes in
// through `data`, read on the server for the page.

import { chartTiles, factorSeries, rowReadings, type ControlType } from '@/lib/fusion/content';
import { cycleKey, NO_DATA, phasesKey, type FusionData } from '@/lib/fusion/data';
import { fusionHref } from '@/lib/fusion/modules';
import type { Reading } from '@/lib/macro';
import ChartGrid, { type TileData } from './ChartGrid';
import PhaseChart from './PhaseChart';
import SortableTable from './SortableTable';

type Spec = Record<string, unknown> & { type: ControlType };
type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const list = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (t: number) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmt = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function Pending({ source }: { source?: unknown }) {
  return (
    <p className="fu-pending" role="note">
      <span className="fu-pending-dot" aria-hidden="true" /> Data pending{source ? <>: <code>{str(source)}</code></> : null}
    </p>
  );
}

function Frame({ title, children, pending, source }: { title?: unknown; children: React.ReactNode; pending?: boolean; source?: unknown }) {
  return (
    <figure className="fu-control">
      {title ? <figcaption className="fu-control-title">{str(title)}</figcaption> : null}
      {children}
      {pending && <Pending source={source} />}
    </figure>
  );
}

function Table({ spec }: { spec: Spec }) {
  const columns = list<string>(spec.columns).map(str);
  const rows = list<Row>(spec.rows).map(r => columns.map(c => str(r?.[c])));
  return (
    <Frame title={spec.title}>
      <SortableTable columns={columns} rows={rows} caption={spec.title ? str(spec.title) : undefined} />
    </Frame>
  );
}

function ReadingCell({ ids, data }: { ids: string[]; data: FusionData }) {
  const macro = data.macro;
  if (!ids.length || !macro || macro.error) return <td className="fu-empty">—</td>;
  return (
    <td>
      {ids.map(id => {
        const r: Reading | undefined = macro.readings[id];
        if (!r) return <div key={id} className="fu-read-missing">No indicator “{id}”</div>;
        if (r.status !== 'ok' || !r.latest) {
          return (
            <div key={id} className="fu-read-missing" title={r.plug ? `Data plug: ${r.plug.connection} ${Object.values(r.plug.params).join(' ')}` : undefined}>
              {r.name}: not recorded{r.plug ? <> (<code>{Object.values(r.plug.params).join(' ')}</code>)</> : null}
            </div>
          );
        }
        return (
          <div key={id} className="fu-read">
            <span className="fu-read-value">{fmt(r.latest.v, r.decimals)}<small> {r.units}</small></span>
            <span className="fu-read-meta">{ids.length > 1 ? `${r.name} · ` : ''}{when(r.latest.t)}</span>
          </div>
        );
      })}
    </td>
  );
}

// From a series' complete recorded history: its average, its change over the last year, and where its last value
// sits among all its values (the percentile). Nothing is estimated: a series with too little history shows a dash.
function historyStats(points: [number, number][] | undefined, last: { t: number; v: number } | null) {
  if (!points?.length || !last) return null;
  const avg = points.reduce((a, p) => a + p[1], 0) / points.length;
  const pct = Math.round((points.filter(p => p[1] <= last.v).length / points.length) * 100);
  const yearAgo = [...points].reverse().find(p => p[0] <= last.t - 365 * 86400000);
  return { avg, pct, n: points.length, yoy: yearAgo ? last.v - yearAgo[1] : null, from: points[0][0] };
}

function StatCell({ kind, row, data }: { kind: 'average' | 'yoy'; row: Row; data: FusionData }) {
  const fs = factorSeries(row ?? {});
  if (!fs.length) return <td className="fu-empty">—</td>;
  const s = data.series[fs[0].series];
  const st = historyStats(s?.points, s?.last ?? null);
  if (!st) return <td className="fu-empty">—</td>;
  const dec = Math.abs(st.avg) >= 1000 ? 0 : Math.abs(st.avg) >= 100 ? 1 : 2;
  if (kind === 'average') return <td><span className="fu-read-value">{fmt(st.avg, dec)}<small> {fs[0].units}</small></span><span className="fu-read-meta">since {when(st.from)}</span></td>;
  if (st.yoy === null) return <td className="fu-empty">—</td>;
  return <td><span className="fu-read-value">{st.yoy >= 0 ? '+' : ''}{fmt(st.yoy, dec)}<small> {fs[0].units}</small></span><span className="fu-read-meta">vs a year earlier</span></td>;
}

function SeriesCell({ row, data, status }: { row: Row; data: FusionData; status?: Status | null }) {
  const fs = factorSeries(row ?? {});
  const needs = row?.needs ? str(row.needs) : '';
  if (!fs.length) return needs ? <td><div className="fu-read-missing">Needs {needs}</div></td> : <td className="fu-empty">—</td>;
  return (
    <td className={status ? `fu-cur fu-cur-${status}` : undefined}>
      {fs.map(f => {
        const s = data.series[f.series];
        if (!s || !s.last) {
          return <div key={f.series} className="fu-read-missing">{fs.length > 1 ? `${f.name}: ` : ''}not recorded yet (<code>{(s?.missing.length ? s.missing : [f.series]).join(', ')}</code>)</div>;
        }
        const dec = Math.abs(s.last.v) >= 1000 ? 0 : Math.abs(s.last.v) >= 100 ? 1 : 2;
        const st = historyStats(s.points, s.last);
        return (
          <div key={f.series} className="fu-read">
            <span className="fu-read-value">{fmt(s.last.v, dec)}<small> {f.units}</small></span>
            <span className="fu-read-meta">{fs.length > 1 ? `${f.name} · ` : ''}{when(s.last.t)}{st ? ` · ${st.pct}% of ${st.n} obs. at or below` : ''}</span>
          </div>
        );
      })}
    </td>
  );
}

type Status = 'bullish' | 'neutral' | 'bearish';
// Where a factor's current value sits against its own bullish side. The bias says which side of the level is
// bullish (higher or lower). put/call has numeric levels; other factors use the thirds of their complete history.
function statusOf(row: Row, data: FusionData): Status | null {
  const bias = str(row?.bias);
  if (bias !== 'higher' && bias !== 'lower') return null;
  const fs = factorSeries(row ?? {});
  const s = fs.length ? data.series[fs[0].series] : undefined;
  if (!s?.last) return null;
  const v = s.last.v;
  const bu = Number(row?.bullish_above), be = Number(row?.bearish_below);
  const flip = (up: boolean): Status => (up === (bias === 'higher') ? 'bullish' : 'bearish');
  if (Number.isFinite(bu) && Number.isFinite(be)) {
    if (v > bu) return flip(true);
    if (v < be) return flip(false);
    return 'neutral';
  }
  const pts = s.points;
  if (!pts || pts.length < 9) return null;
  const vals = pts.map(p => p[1]).sort((a, b) => a - b);
  const at = (q: number) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))];
  if (v >= at(2 / 3)) return flip(true);
  if (v <= at(1 / 3)) return flip(false);
  return 'neutral';
}

function FactorLevels({ spec, data }: { spec: Spec; data: FusionData }) {
  const columns = list<string>(spec.columns).map(str);
  const rows = list<Row>(spec.rows);
  const macro = data.macro;
  const bySeries = rows.some(r => factorSeries(r ?? {}).length || r?.needs);
  const live = bySeries
    ? rows.filter(r => factorSeries(r ?? {}).some(f => data.series[f.series]?.last)).length
    : macro && !macro.error ? rows.filter(r => rowReadings(r ?? {}).some(id => macro.readings[id]?.status === 'ok')).length : 0;
  const mapped = bySeries ? rows.length : rows.filter(r => rowReadings(r ?? {}).length).length;
  // one chart per factor, from the same series as its reading, in the table's order
  return (
    <Frame title={spec.title} pending source={spec.source}>
      {mapped > 0 && (
        <p className="fu-note">
          {macro?.error
            ? <>Current readings: {macro.error}</>
            : <>Current readings: {live} of {rows.length} factors from the Data Hub{bySeries ? '' : ` (${macro?.country ?? 'US'}, FRED first releases)`}.
                Bands with no level set in the content show the thirds of each factor&rsquo;s own history (marked as such).</>}
        </p>
      )}
      {(() => {
        const sts = rows.map(r => statusOf(r ?? {}, data)).filter((x): x is Status => x !== null);
        const b = sts.filter(x => x === 'bullish').length, br = sts.filter(x => x === 'bearish').length, n = sts.length - b - br;
        const score = sts.length ? (b - br) / sts.length : 0;
        return sts.length ? (
          <p className={`fu-score ${score > 0 ? 'fu-score-bull' : score < 0 ? 'fu-score-bear' : ''}`}>
            Bullish {b} · Neutral {n} · Bearish {br} of {sts.length} factors read: score (bullish − bearish) ÷ factors = <strong>{score >= 0 ? '+' : ''}{score.toFixed(2)}</strong>
          </p>
        ) : null;
      })()}
      <div className="fu-table-wrap">
        <table className="fu-table">
          {spec.title ? <caption className="fu-sr">{str(spec.title)}</caption> : null}
          <thead>
            <tr><th scope="col">Factor</th>{columns.map(c => <th key={c} scope="col" className={`fu-band-${c.toLowerCase()}`}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{str(r?.factor)}{statusOf(r ?? {}, data) ? <span className={`fu-st fu-st-${statusOf(r ?? {}, data)}`}>{statusOf(r ?? {}, data)}</span> : null}</th>
                {columns.map(c => {
                  const k = c.toLowerCase();
                  if (k === 'current') return bySeries ? <SeriesCell key={c} row={r} data={data} status={statusOf(r ?? {}, data)} /> : <ReadingCell key={c} ids={rowReadings(r ?? {})} data={data} />;
                  if (k === 'average') return <StatCell key={c} kind="average" row={r} data={data} />;
                  if (k === 'yoy change') return <StatCell key={c} kind="yoy" row={r} data={data} />;
                  const band = str((r as Row)?.[k]);
                  if (band && band !== 'undefined') return <td key={c} className="fu-band-text">{band}</td>;
                  // no level set in the content: the thirds of the factor's own complete history (not a judgement of direction)
                  const fs0 = factorSeries(r ?? {});
                  const pts0 = fs0.length ? data.series[fs0[0].series]?.points : undefined;
                  if (pts0 && pts0.length >= 9) {
                    const vals = pts0.map(p => p[1]).sort((a, b) => a - b);
                    const at = (q: number) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))];
                    const d = Math.abs(at(0.5)) >= 100 ? 1 : 2;
                    const lo = fmt(at(1 / 3), d), hi = fmt(at(2 / 3), d);
                    const txt = k === 'bullish' ? `top third: ${fmt(at(2 / 3), d)} and above` : k === 'bearish' ? `bottom third: ${fmt(at(1 / 3), d)} and below` : `middle third: ${lo} to ${hi}`;
                    return <td key={c} className="fu-band-hist" title="Thirds of this factor's complete history; replace with a set level when you have one">{txt}</td>;
                  }
                  return <td key={c} className="fu-empty" title="The level for this band is not in the workbook yet">—</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function PairDifferentials({ spec }: { spec: Spec }) {
  const metrics = list<string>(spec.metrics);
  return (
    <Frame title={spec.title} pending source={spec.source}>
      <p className="fu-note">One row per OANDA pair (base minus quote), with a rank from most bullish to most bearish on{' '}
        {list<string>(spec.rank_by).join(', ')}.</p>
      <div className="fu-table-wrap">
        <table className="fu-table">
          {spec.title ? <caption className="fu-sr">{str(spec.title)}</caption> : null}
          <thead><tr><th scope="col">Pair</th>{metrics.map(m => <th key={m} scope="col">{m}</th>)}<th scope="col">Rank</th></tr></thead>
          <tbody>
            <tr><td colSpan={metrics.length + 2} className="fu-empty">No pairs yet: the rows fill in once the OANDA pair list and the macro series by nation are connected.</td></tr>
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function Flow({ spec }: { spec: Spec }) {
  const nodes = list<string>(spec.nodes);
  if (spec.layout === 'triangle') {
    return (
      <Frame title={spec.title}>
        <div className="fu-triangle" role="list">
          {nodes.map((n, i) => <div key={i} role="listitem" className={`fu-tri-node fu-tri-${i}`}>{n}</div>)}
          <div className="fu-tri-note">Pick two</div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame title={spec.title}>
      <ol className="fu-chain">
        {nodes.map((n, i) => <li key={i}>{n}</li>)}
        {spec.repeat ? <li className="fu-chain-repeat">{str(spec.repeat)}</li> : null}
      </ol>
    </Frame>
  );
}

function Checklist({ spec }: { spec: Spec }) {
  const items = list<Row>(spec.items);
  return (
    <Frame title={spec.title} pending={!!spec.source} source={spec.source}>
      <ul className="fu-checklist">
        {items.map((it, i) => (
          <li key={i}><strong>{str(it.item)}</strong>{it.detail ? <span>{str(it.detail)}</span> : null}</li>
        ))}
      </ul>
    </Frame>
  );
}

/** Eras like 1949-1966 drawn to scale on one line (the Kondratieff waves). */
function EraTimeline({ stages }: { stages: Row[] }) {
  const eras = stages.map(s => str(s.era).match(/^(\d{4})\s*[-–]\s*(\d{4})$/)).filter((m): m is RegExpMatchArray => !!m)
    .map(m => [Number(m[1]), Number(m[2])] as const);
  if (eras.length !== stages.length || !eras.length) return null;
  const start = eras[0][0], end = eras[eras.length - 1][1], span = end - start || 1;
  return (
    <div className="fu-eras" role="img" aria-label={`Timeline of the waves, ${start} to ${end}`}>
      {eras.map(([a, b], i) => (
        <div key={a} className={`fu-era fu-era-${i % 4}`} style={{ flexGrow: (b - a) / span }}>
          <span className="fu-era-years">{a}–{b}</span>
        </div>
      ))}
    </div>
  );
}

function Stages({ spec }: { spec: Spec }) {
  const stages = list<Row>(spec.stages);
  return (
    <Frame title={spec.title}>
      <EraTimeline stages={stages} />
      <ol className="fu-stages">
        {stages.map((s, i) => (
          <li key={i} id={s.stage !== undefined ? `stage-${str(s.stage)}` : undefined}>
            <span className="fu-stage-tag">{s.era ? str(s.era) : `Stage ${str(s.stage ?? i + 1)}`}</span>
            <span className="fu-stage-text">{str(s.text)}</span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

function Phases({ spec, data }: { spec: Spec; data: FusionData }) {
  const phases = list<Row>(spec.phases);
  const dens = list<string>(spec.denominators);
  const got = data.phases[phasesKey(spec)];
  const drawn = got ? Object.values(got.lines).some(byPhase => Object.values(byPhase).some(l => l.length)) : false;
  return (
    <Frame title={spec.title} pending={!drawn} source={spec.source}>
      {got && <PhaseChart phases={got.phases} denominators={got.denominators} lines={got.lines} ratios={got.ratios ?? []} ratioLines={got.ratioLines ?? {}} indexLines={got.indexLines ?? {}} last={got.last} />}
      <div className="fu-phases">
        {phases.map((p, i) => (
          <div key={i} className="fu-phase">
            <div className="fu-phase-name">{str(p.phase)}</div>
            <div className="fu-phase-etfs">{list<string>(p.etfs).map(e => <span key={e} className="fu-chip">{e}</span>)}</div>
            <div className="fu-phase-den">vs {dens.join(' · ')}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Charts({ spec, data, bare = false }: { spec: Spec; data: FusionData; bare?: boolean }) {
  const tiles: TileData[] = chartTiles(spec).map(t => {
    const load = (expr: string) => {
      const s = data.series[expr];
      return { expr, data: s && !s.missing.length ? s.points : null, missing: s ? s.missing : [expr] };
    };
    const main = t.series ? load(t.series) : null;
    const lines = t.lines.map(l => ({ name: l.name, units: l.units, ...load(l.series), last: data.series[l.series]?.last ?? null }));
    return { section: t.section, name: t.name, units: t.units, main, compare: t.compare.map(load), lines, last: t.series ? data.series[t.series]?.last ?? null : null,
             needs: t.needs ?? (t.series || t.compare.length || t.lines.length ? null : str(spec.source) || 'a series to be named') };
  });
  const real = tiles.filter(t => (t.main?.data || (t.compare.length && t.compare.every(c => c.data)) || (t.lines?.length && t.lines.every(l => l.data)))).length;
  const body = (<>
    <p className="fu-note">{real} of {tiles.length} charts drawn from the Data Hub; the rest name the series they wait for.</p>
    <ChartGrid id={`charts-${str(spec.title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} tiles={tiles} lookbacks={list<string>(spec.lookback).map(String)} intervals={list<string>(spec.interval).map(String)} />
  </>);
  if (bare) return <div className="fu-factor-charts"><h4 className="fu-sub">{str(spec.title)}</h4>{body}</div>;
  return <Frame title={spec.title}>{body}</Frame>;
}

const STAGE_LABEL = ['', 'Bonds up', 'Bonds and stocks up', 'All three up', 'Stocks and commodities up', 'Commodities up', 'All three down'];
const ROLE_LABEL = { bonds: 'Bonds', stocks: 'Stocks', commodities: 'Commodities' } as const;

function CyclePosition({ spec, data }: { spec: Spec; data: FusionData }) {
  const got = data.cycles[cycleKey(spec)];
  const months = got?.months ?? [];
  const now = months.at(-1);
  const recent = months.slice(-120);
  const stagesHref = spec.stages_anchor && now?.stage ? `#stage-${now.stage}` : null;
  return (
    <Frame title={spec.title} pending={!months.length} source={got ? got.legs.filter(l => l.missing).map(l => `price:${l.symbol}`).join(', ') : 'datahub:prices'}>
      {got && (
        <ul className="fu-legs">
          {got.legs.map(l => (
            <li key={l.role}>
              <b>{ROLE_LABEL[l.role]}</b> <code>{l.symbol}</code>
              {l.proxyFor && <span className="fu-warn"> standing in for {l.proxyFor} (not recorded)</span>}
              {l.last && <span className="fu-mini-date"> · last close {new Date(l.last).toISOString().slice(0, 10)}</span>}
              {now && <span className={now.up[['bonds', 'stocks', 'commodities'].indexOf(l.role)] ? 'fu-good' : 'fu-bad'}> · {now.up[['bonds', 'stocks', 'commodities'].indexOf(l.role)] ? 'uptrend' : 'downtrend'}</span>}
            </li>
          ))}
        </ul>
      )}
      {now && (<>
        <p className="fu-cycle-now">
          {now.stage
            ? <>Now (month of {new Date(now.t).toISOString().slice(0, 7)}): <b>Stage {now.stage}</b>, {STAGE_LABEL[now.stage].toLowerCase()}.{stagesHref ? <> <a href={stagesHref}>Read stage {now.stage}</a></> : null}</>
            : <>Now (month of {new Date(now.t).toISOString().slice(0, 7)}): outside the six-stage path ({now.up.map((u, i) => `${['bonds', 'stocks', 'commodities'][i]} ${u ? 'up' : 'down'}`).join(', ')}).</>}
        </p>
        <div className="fu-cycle-strip" role="img" aria-label={`Stage by month over the last ${Math.round(recent.length / 12)} years; now ${now.stage ? `stage ${now.stage}` : 'off the path'}`}>
          {recent.map(m => <span key={m.t} className={`fu-cyc fu-cyc-${m.stage ?? 0}`} title={`${new Date(m.t).toISOString().slice(0, 7)}: ${m.stage ? `stage ${m.stage}` : 'off the path'}`} />)}
        </div>
        <div className="fu-cycle-axis"><span>{new Date(recent[0].t).getUTCFullYear()}</span><span>{new Date(now.t).getUTCFullYear()}</span></div>
        <ul className="fu-cycle-legend">
          {[1, 2, 3, 4, 5, 6, 0].map(n => <li key={n}><span className={`fu-cyc fu-cyc-${n}`} aria-hidden="true" />{n ? `${n} · ${STAGE_LABEL[n]}` : 'Off the path'}</li>)}
        </ul>
        <p className="fu-note">A leg is in an uptrend when its month-end close is above its 10-month average. Bonds, stocks and commodities by that rule give the stage.</p>
      </>)}
    </Frame>
  );
}

function OutlineLink({ spec, data }: { spec: Spec; data: FusionData }) {
  const slug = str(spec.outline);
  const o = data.outlines[slug];
  return (
    <aside className="fu-outline-link" aria-label="Moved to the Playbook">
      <span className="fu-outline-kicker">Study outline in the Playbook</span>
      <a href={fusionHref(`/fusion/playbook/outlines#${slug}`, data.embed)}>{o?.title ?? slug}</a>
      {o?.summary && <span className="fu-outline-summary">{o.summary}</span>}
    </aside>
  );
}

function CycleProbability({ spec }: { spec: Spec }) {
  return (
    <Frame title={spec.title} pending source={spec.source}>
      <p className="fu-note">Probability of an up {list<string>(spec.periods).join(' and an up ')} for a {str(spec.input)}.</p>
    </Frame>
  );
}

export function Control({ spec, data = NO_DATA }: { spec: Spec; data?: FusionData }) {
  switch (spec.type) {
    case 'table': return <Table spec={spec} />;
    case 'factor-levels': return <FactorLevels spec={spec} data={data} />;
    case 'pair-differentials': return <PairDifferentials spec={spec} />;
    case 'flow': return <Flow spec={spec} />;
    case 'checklist': return <Checklist spec={spec} />;
    case 'stages': return <Stages spec={spec} />;
    case 'phases': return <Phases spec={spec} data={data} />;
    case 'chart-grid': return <Charts spec={spec} data={data} />;
    case 'cycle-probability': return <CycleProbability spec={spec} />;
    case 'cycle-position': return <CyclePosition spec={spec} data={data} />;
    case 'outline': return <OutlineLink spec={spec} data={data} />;
  }
}
