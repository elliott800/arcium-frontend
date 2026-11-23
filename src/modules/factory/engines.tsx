'use client';

// The Engine Hangar: each silo's simulated and practice-live engine on its controller machine. Start a
// bounded or open run, stop it (cleanly, or the kill switch), and watch its equity from the curve the
// machine syncs (web_equity_curve). Live runs only on the OANDA practice account: the backend refuses
// anything else.
import { useMemo, useState } from 'react';
import { Notice, Page, ago, num, useJson } from '@/ui/kit';
import { isStale, useControl, useMachines, type EngineState } from './machine';

interface Point { cycle_time: string; equity: number | null; balance: number | null }
const KINDS = [{ kind: 'sim', label: 'Simulated', curve: 'simulated' }, { kind: 'live', label: 'Practice live', curve: 'live' }] as const;

function Spark({ points }: { points: Point[] }) {
  const ys = points.map(p => Number(p.equity ?? p.balance)).filter(Number.isFinite);
  if (ys.length < 2) return <div className="m-muted" style={{ fontSize: 12 }}>No equity synced yet.</div>;
  const lo = Math.min(...ys), hi = Math.max(...ys), w = 260, h = 56;
  const d = ys.map((y, i) => `${i ? 'L' : 'M'}${(i / (ys.length - 1)) * w},${h - ((y - lo) / (hi - lo || 1)) * h}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`Equity from ${num(ys[0])} to ${num(ys[ys.length - 1])}`} style={{ height: h }}>
      <path d={d} fill="none" stroke={up ? 'var(--good)' : 'var(--bad)'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function EngineCard({ machine, silo, kind, label, curve, state, stale, send, control }: {
  machine: string; silo: string; kind: 'sim' | 'live'; label: string; curve: string; state?: EngineState; stale: boolean; control: boolean;
  send: (m: string, a: string, x?: Record<string, unknown>) => void;
}) {
  const { data } = useJson<{ equityCurve: Point[]; total?: number }>(`/api/silos/${encodeURIComponent(silo)}/data?engineKind=${curve}&only=equity&points=300`, 30000);
  const [cycles, setCycles] = useState('');
  const [balance, setBalance] = useState('10000');
  const running = !!state?.pid;
  const points = data?.equityCurve ?? [];
  const last = points[points.length - 1];
  const start = () => {
    if (kind === 'live' && !window.confirm(`Start ${silo} live on the OANDA practice account?`)) return;
    send(machine, 'engine_start', { silo, kind, ...(cycles ? { max_cycles: Number(cycles) } : {}), ...(kind === 'sim' ? { sim_balance: Number(balance) } : {}) });
  };
  return (
    <div className="m-card" data-engine={`${silo}/${kind}`}>
      <div className="m-row">
        <h2 style={{ margin: 0 }}>{label}</h2>
        <span className={`m-badge ${running ? 'good' : state?.state === 'failed' ? 'bad' : ''}`}>{state?.state ?? 'not run'}</span>
        {state && <span className="m-muted m-num">cycle {state.cycle}{state.max_cycles ? ` / ${state.max_cycles}` : ''}</span>}
      </div>
      <Spark points={points} />
      <div className="m-row m-muted" style={{ fontSize: 12 }}>
        <span>Equity <b className="m-num">{num(state?.equity ?? last?.equity ?? last?.balance)}</b></span>
        <span>{data?.total ?? points.length} points</span>
        <span>{state ? `updated ${ago(state.updated)}` : last ? `synced ${ago(last.cycle_time)}` : ''}</span>
      </div>
      {state?.error && <p className="m-error" style={{ fontSize: 12 }}>{state.error}</p>}
      {control && <div className="m-row" style={{ marginTop: 8 }}>
        {running ? (
          <>
            <button className="m-btn" onClick={() => send(machine, 'engine_stop', { silo, kind })}>Stop</button>
            <button className="m-btn danger" onClick={() => window.confirm(`Kill ${silo} (${label}) now?`) && send(machine, 'engine_stop', { silo, kind, force: true })}>Kill</button>
          </>
        ) : (
          <>
            <input className="m-input" style={{ width: 80 }} inputMode="numeric" placeholder="cycles" aria-label="Cycles (empty: run until stopped)"
              value={cycles} onChange={e => setCycles(e.target.value.replace(/\D/g, ''))} />
            {kind === 'sim' && <input className="m-input" style={{ width: 90 }} inputMode="decimal" aria-label="Simulated balance"
              value={balance} onChange={e => setBalance(e.target.value.replace(/[^\d.]/g, ''))} />}
            <button className="m-btn primary" disabled={stale} onClick={start}>Start</button>
          </>
        )}
      </div>}
    </div>
  );
}

export default function EnginesModule() {
  const { data: machines, control, demo, error, reload } = useMachines();
  const { msg, send } = useControl(reload);
  const rows = useMemo(() => (machines ?? []).filter(m => m.live_status).flatMap(m => {
    const s = m.live_status!;
    const silos = [...new Set([...(s.silos ?? []), ...Object.keys(s.engines ?? {})])].sort();
    return silos.map(silo => ({ machine: m.machine_name, stale: isStale(m), silo, engines: s.engines?.[silo] ?? {} }));
  }), [machines]);
  return (
    <Page title="Engine Hangar" intro={demo ? "Each silo's simulated engine and its equity, on the demo's simulated machine." : "Each silo's simulated and practice-live engine. Live trades the OANDA practice account only."}>
      <Notice msg={msg} />
      {error && <p className="m-error">{error}</p>}
      {machines && !rows.length && <div className="m-card m-empty">No controller has reported its silos yet.</div>}
      {rows.map(r => (
        <section key={`${r.machine}/${r.silo}`} className="m-card" style={{ background: 'var(--bg)' }}>
          <div className="m-row"><h2 style={{ margin: 0 }}>{r.silo}</h2><span className="m-muted">on {r.machine}</span></div>
          <div className="m-grid" style={{ marginTop: 10 }}>
            {KINDS.map(k => (
              <EngineCard key={k.kind} machine={r.machine} silo={r.silo} kind={k.kind} label={k.label} curve={k.curve}
                state={r.engines[k.kind]} stale={r.stale} send={send} control={control} />
            ))}
          </div>
        </section>
      ))}
    </Page>
  );
}
