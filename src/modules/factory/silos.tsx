'use client';

// The optimization silos the machines report (silo_registry): their settings, stacks and best models.
// Settings are read here; they change only from the backend's terminal, by setting a dictionary
// (`arcium.py settings set <silo> '{...}'`), and reach this page with the next heartbeat.
import { useMemo, useState } from 'react';
import { Page, Table, ago, num, useJson } from '@/ui/kit';
import type { SiloRegistryRow } from '@/lib/api-types';

const parse = <T,>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

interface ModelRow { username?: string; model_name?: string; signal_name?: string; model_type?: string; data_rate?: string; instrument_name?: string;
  ins_sr?: number | null; oos_sr?: number | null; oos_accuracy?: number | null; catalog_source: string }

function Settings({ title, data, keys }: { title: string; data: Record<string, unknown> | null; keys: string[] }) {
  if (!data) return <div className="m-card"><h2>{title}</h2><p className="m-muted">Not synced yet.</p></div>;
  const show = (v: unknown) => Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}: ${v.slice(0, 8).join(', ')}${v.length > 8 ? '…' : ''}`
    : v && typeof v === 'object' ? JSON.stringify(v) : v == null ? '—' : String(v);
  return (
    <div className="m-card">
      <h2>{title}</h2>
      <dl className="m-kv">{keys.filter(k => k in data).map(k => <FragmentKV key={k} k={k} v={show(data[k])} />)}</dl>
    </div>
  );
}
const FragmentKV = ({ k, v }: { k: string; v: string }) => <><dt>{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></>;

function Detail({ silo }: { silo: SiloRegistryRow }) {
  const trader = parse<Record<string, unknown> | null>(silo.trader_settings, null);
  const optimizer = parse<Record<string, unknown> | null>(silo.optimizer_settings, null);
  const stacks = parse<string[]>(silo.stack_rates, []);
  const built = parse<string[]>(silo.built_rates, []);
  const { data: models } = useJson<ModelRow[]>(`/api/catalogs?table=models&source=${encodeURIComponent(silo.silo_name)}`);
  return (
    <>
      <div className="m-grid">
        <Settings title="Trader" data={trader} keys={['watchlist_name', 'watchlist', 'data_rate', 'mode', 'theta', 'hurdle', 'max_risk', 'sim_balance', 'broker', 'timezone']} />
        <Settings title="Optimizer" data={(optimizer?.general as Record<string, unknown> | undefined) ?? optimizer} keys={['pop_size', 'max_generations', 'min_sharpe', 'sample_size', 'holdout_frac']} />
        <div className="m-card">
          <h2>Stacks</h2>
          {stacks.length ? (
            <div className="m-row">{stacks.map(r => <span key={r} className={`m-badge ${built.includes(r) ? 'good' : ''}`}>{r}{built.includes(r) ? '' : ' (not built)'}</span>)}</div>
          ) : <p className="m-muted">No stacks.</p>}
          <p className="m-muted" style={{ fontSize: 12, marginTop: 8 }}>Change settings from the backend terminal: <code>arcium.py settings set {silo.silo_name} &apos;{'{…}'}&apos;</code></p>
        </div>
      </div>
      <h2 style={{ fontSize: 14, margin: 0 }}>Best models</h2>
      <Table rows={(models ?? []).slice(0, 25)} rowKey={r => `${r.username ?? ''}/${r.catalog_source}/${r.model_name ?? r.signal_name}/${r.instrument_name ?? ''}`}
        empty={models ? 'No scored models yet.' : 'Loading…'} columns={[
          { key: 'model_name', label: 'Model', value: r => r.model_name ?? r.signal_name },
          { key: 'model_type', label: 'Type' },
          { key: 'data_rate', label: 'Rate' },
          { key: 'ins_sr', label: 'IS Sharpe', numeric: true, render: r => num(r.ins_sr) },
          { key: 'oos_sr', label: 'OOS Sharpe', numeric: true, render: r => num(r.oos_sr) },
          { key: 'oos_accuracy', label: 'OOS acc.', numeric: true, render: r => num(r.oos_accuracy, 3) },
        ]} />
    </>
  );
}

export default function SilosModule() {
  const { data, error } = useJson<SiloRegistryRow[]>('/api/silos', 30000);
  const [pick, setPick] = useState<string | null>(null);
  const silos = useMemo(() => data ?? [], [data]);
  const current = useMemo(() => silos.find(s => s.silo_key === pick) ?? silos[0] ?? null, [silos, pick]);
  return (
    <Page title="Silos" intro="Optimization silos: what each optimizes, at which rates, and its best models so far.">
      {error && <p className="m-error">{error}</p>}
      <Table rows={silos} rowKey={r => r.silo_key} selected={current?.silo_key} onRow={r => setPick(r.silo_key)}
        empty={data ? 'No silos reported yet.' : 'Loading…'} columns={[
          { key: 'silo_name', label: 'Silo', render: r => <strong>{r.silo_name}</strong> },
          { key: 'machine_name', label: 'Machine' },
          { key: 'status', label: 'Status', render: r => <span className="m-badge">{r.status ?? 'active'}</span> },
          { key: 'stacks', label: 'Stacks', value: r => parse<string[]>(r.stack_rates, []).join(' ') },
          { key: 'watchlist', label: 'Watchlist', value: r => parse<{ watchlist_name?: string }>(r.trader_settings, {}).watchlist_name ?? '—' },
          { key: 'last_synced', label: 'Synced', render: r => ago(r.last_synced) },
        ]} />
      {current && <Detail key={current.silo_key} silo={current} />}
    </Page>
  );
}
