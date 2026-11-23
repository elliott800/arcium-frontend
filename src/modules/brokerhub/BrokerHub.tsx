'use client';

// The BrokerHub (brokerhub.arciumsignals.com, admin only): the broker API registry, matching the Data Hub's source
// registry. Brokers: register a broker (its broker API connector, the API key entry it uses, and the Arcium account
// it belongs to: the owner's or a sub-account) and see each one's map, the getters and setters of its connector with
// their argument and return types. API keys & accounts: the broker API keys, secret and public keys and account IDs,
// as on the Data Hub. Talks to /api/admin/brokerhub (src/lib/brokerhub.ts).

import { useEffect, useState } from 'react';
import DrillTable from '@/modules/datahub/view/hub/DrillTable';
import ApiKeys from '@/modules/datahub/view/hub/ApiKeys';
import { api } from '@/modules/datahub/view/hub/api';
import type { DhNode } from '@/lib/datahubTypes';
import type { BrokerHubView } from '@/lib/brokerhub';

const BASE = '/api/admin/brokerhub';
type View = BrokerHubView & { trees: Record<string, DhNode[]> };
const empty = { name: '', connector: '', credential_id: '', owner: '', description: '' };

function Brokers() {
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState(empty);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<View>(`${BASE}?view=home`).then(setView).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg('');
    try { await api(BASE, { method: 'POST', body: JSON.stringify(body) }); setMsg(done); await load(); return true; }
    catch (e) { setMsg((e as Error).message); return false; } finally { setBusy(false); }
  };

  if (!view) return <p className="empty-state">{msg || 'Loading the BrokerHub…'}</p>;
  const set = (patch: Partial<typeof empty>) => setForm(f => ({ ...f, ...patch }));
  const tree: DhNode[] = view.brokers.map(b => ({
    id: `broker/${b.name}`, label: b.name, source: b.connector, tags: [], count: 2,
    contents: `account: ${b.owner} · key: ${b.key_name ?? 'none'}${b.credential_id ? ` · ${b.accounts} account ID${b.accounts === 1 ? '' : 's'}` : ''}${b.description ? ` · ${b.description}` : ''}`,
    children: view.trees[b.name] ?? [],
  }));
  const action = (n: DhNode) => {
    const b = view.brokers.find(x => `broker/${x.name}` === n.id);
    if (!b) return null;
    return (
      <span style={{ display: 'flex', gap: 6 }}>
        <a className="secondary-action" href={`${BASE}?view=markdown&broker=${encodeURIComponent(b.name)}`} download>Markdown</a>
        <a className="secondary-action" href={`${BASE}?view=dictionary&connector=${encodeURIComponent(b.connector)}`} download>Dictionary</a>
        <button type="button" className="secondary-action" disabled={busy}
          onClick={() => { if (window.confirm(`Remove the broker ${b.name}? Its API key stays under API keys.`)) send({ action: 'broker_remove', name: b.name }, `Removed ${b.name}.`); }}>Remove</button>
      </span>
    );
  };
  const exists = view.brokers.find(b => b.name === form.name.trim().toLowerCase());
  return (
    <section className="panel" aria-label="Brokers">
      <div className="panel-heading"><div><h3>Broker API registry</h3><p>Each broker registered here uses a broker API connector, one of the API keys under API keys &amp; accounts, and belongs to your Arcium Signals account or a sub-account. Its map is its connector&apos;s getters (what it reads, and the type each returns) and setters (what it changes, with typed arguments).</p></div></div>
      <div className="mapping-form" aria-label="Register a broker">
        <label>BROKER NAME<input value={form.name} onChange={e => set({ name: e.target.value })} placeholder="oanda_practice" /></label>
        <label>BROKER API (CONNECTOR)<select value={form.connector} onChange={e => set({ connector: e.target.value })}>
          <option value="">Choose…</option>{view.connectors.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>API KEY<select value={form.credential_id} onChange={e => set({ credential_id: e.target.value })}>
          <option value="">none yet</option>
          {view.keys.filter(k => !form.connector || k.connector === form.connector || k.connector === 'broker' || k.connector === 'other')
            .map(k => <option key={k.id} value={k.id}>{k.name} ({k.connector})</option>)}</select></label>
        <label>ACCOUNT<select value={form.owner} onChange={e => set({ owner: e.target.value })}>
          <option value="">Choose…</option>{view.owners.map(o => <option key={o.username} value={o.username}>{o.label}</option>)}</select></label>
        <label style={{ gridColumn: '1 / -1' }}>DESCRIPTION<input value={form.description} onChange={e => set({ description: e.target.value })} placeholder="optional" /></label>
        <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="builder-action" disabled={busy || !form.name.trim() || !form.connector || !form.owner}
            onClick={async () => { if (await send({ action: 'broker_register', ...form }, exists ? `Updated ${exists.name}.` : `Registered ${form.name.trim().toLowerCase()}.`)) setForm(empty); }}>
            {exists ? `Update ${exists.name}` : 'Register broker'}</button>
          <span>Add the broker&apos;s keys and account IDs under API keys &amp; accounts first, then choose them here.</span>
        </div>
      </div>
      <DrillTable nodes={tree} rainbow empty="No brokers registered yet." columns={{ first: 'Broker · getters and setters', action: { title: '', cell: action } }} />
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </section>
  );
}

export default function BrokerHub() {
  const [tab, setTab] = useState<'brokers' | 'keys'>('brokers');
  return (
    <div className="m-page dh-module">
      <div className="m-head"><h1>BrokerHub</h1><p>The broker APIs registered to your Arcium accounts, their keys and account IDs, and their maps.</p></div>
      <div className="dhx"><section className="datahub-content">
      <div className="section-tabs" role="tablist" aria-label="BrokerHub views">
        <button className={`section-tab${tab === 'brokers' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={tab === 'brokers'} onClick={() => setTab('brokers')}>Brokers</button>
        <button className={`section-tab${tab === 'keys' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={tab === 'keys'} onClick={() => setTab('keys')}>API keys &amp; accounts</button>
      </div>
      {tab === 'brokers' ? <Brokers /> : <ApiKeys rainbow base={BASE} what="broker" />}
      </section></div>
    </div>
  );
}
