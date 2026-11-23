'use client';

// The model catalog the machines sync: every stored model per source (a silo's own optimizer `<silo>`, or a
// stack `stack/<user>/<silo>/<RATE>`), with in- and out-of-sample stats. Pick a source and a table.
import { useState } from 'react';
import { Page, Table, num, useJson } from '@/ui/kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- catalog rows carry whatever stat columns the optimizer stored
type Row = Record<string, any>;
const TABLES = [
  { id: 'models', label: 'Models' },
  { id: 'signals', label: 'Signals' },
  { id: 'stats', label: 'Live stats' },
] as const;

export default function CatalogModule() {
  const { data: sources } = useJson<string[]>('/api/catalogs');
  const [source, setSource] = useState('__all__');
  const [table, setTable] = useState<(typeof TABLES)[number]['id']>('models');
  const [filter, setFilter] = useState('');
  const { data, error } = useJson<Row[]>(`/api/catalogs?table=${table}&source=${encodeURIComponent(source)}`);
  const q = filter.trim().toLowerCase();
  const rows = (data ?? []).filter(r => !q || JSON.stringify([r.model_name, r.signal_name, r.instrument_name, r.model_type, r.catalog_source]).toLowerCase().includes(q));
  return (
    <Page title="Model catalog" intro="Stored models with their in-sample (IS) and out-of-sample (OOS) stats."
      actions={<>
        <select className="m-input" aria-label="Source" value={source} onChange={e => setSource(e.target.value)}>
          <option value="__all__">All sources</option>
          {(sources ?? []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="m-input" aria-label="Table" value={table} onChange={e => setTable(e.target.value as typeof table)}>
          {TABLES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input className="m-input" placeholder="Filter" aria-label="Filter" value={filter} onChange={e => setFilter(e.target.value)} />
      </>}>
      {error && <p className="m-error">{error}</p>}
      <p className="m-muted" style={{ margin: 0 }}>{data ? `${rows.length} of ${data.length} rows` : 'Loading…'}</p>
      <Table rows={rows.slice(0, 500)} rowKey={r => `${r.username ?? ''}/${r.catalog_source}/${r.model_name ?? r.signal_name}/${r.instrument_name ?? ''}/${r.blob_hash ?? ''}/${r.data_rate ?? ''}`}
        empty={data ? 'No rows.' : 'Loading…'} columns={[
          { key: 'catalog_source', label: 'Source' },
          { key: 'name', label: 'Name', value: r => r.model_name ?? r.signal_name },
          { key: 'model_type', label: 'Type', value: r => r.model_type ?? r.type },
          { key: 'instrument_name', label: 'Instrument' },
          { key: 'data_rate', label: 'Rate' },
          { key: 'ins_sr', label: 'IS Sharpe', numeric: true, render: r => num(r.ins_sr) },
          { key: 'oos_sr', label: 'OOS Sharpe', numeric: true, render: r => num(r.oos_sr) },
          { key: 'oos_accuracy', label: 'OOS acc.', numeric: true, render: r => num(r.oos_accuracy, 3) },
          { key: 'current_sharpe', label: 'Current Sharpe', numeric: true, render: r => num(r.current_sharpe) },
          { key: 'use_flag', label: 'In use', render: r => r.use_flag ? <span className="m-badge good">yes</span> : '' },
        ]} />
    </Page>
  );
}
