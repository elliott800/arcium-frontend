'use client';

// API access (Data Hub center, admin only): who may read the Data Hub API (arcium_midend/api). The guest switch lets
// visitors without a key read the source bundles' raw data (limited); the Subscriptions drill tree lists each
// processed-data product with the accounts subscribed to it, and Activate / Pause / End buttons beside each. Requests
// come from the accounts' Subscribe buttons; you can also start a subscription for any account below.
// Server: /api/admin/datahub/access (src/lib/datahubAccess.ts).

import { useEffect, useMemo, useState } from 'react';
import DrillTable from './DrillTable';
import { api } from './api';
import type { DhNode } from '@/lib/datahubTypes';
import type { DhProduct, DhSub, SubStatus } from '@/lib/datahubAccess';

interface View { guest_enabled: boolean; products: DhProduct[]; subscriptions: DhSub[]; accounts: string[] }
const BASE = '/api/admin/datahub/access';
const NEXT: Record<SubStatus, SubStatus[]> = { requested: ['active', 'ended'], active: ['paused', 'ended'], paused: ['active', 'ended'], ended: ['active'] };
const VERB: Record<SubStatus, string> = { active: 'Activate', paused: 'Pause', ended: 'End', requested: '' };
const day = (t: string | null) => (t ? t.slice(0, 10) : '');

export default function ApiAccess({ rainbow }: { rainbow: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState({ id: '', name: '', description: '', kind: 'processed' });
  const [grant, setGrant] = useState({ username: '', product: '' });
  const load = () => api<View>(BASE).then(setView).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true); setMsg('');
    try { await api(BASE, { method: 'POST', body: JSON.stringify(body) }); setMsg(done); await load(); return true; }
    catch (e) { setMsg((e as Error).message); return false; } finally { setBusy(false); }
  }

  const tree: DhNode[] = useMemo(() => (view?.products ?? []).map(p => {
    const subs = view!.subscriptions.filter(s => s.product_id === p.id);
    const active = subs.filter(s => s.status === 'active').length;
    const waiting = subs.filter(s => s.status === 'requested').length;
    return {
      id: `product/${p.id}`, label: p.name, tags: [], count: subs.length || 1,
      contents: `${p.visible ? '' : 'hidden · '}${active} active${waiting ? ` · ${waiting} waiting` : ''} · ${p.description}`,
      children: subs.map(s => ({
        id: `sub/${p.id}/${s.username}`, label: s.username, tags: [], count: 1,
        contents: `${s.status}${s.status === 'active' ? ` since ${day(s.activated_at)}` : s.status === 'requested' ? ` ${day(s.requested_at)}` : s.status === 'ended' ? ` ${day(s.ended_at)}` : ''} · ${s.source}`,
      })),
    };
  }), [view]);

  function actions(n: DhNode) {
    if (!view) return null;
    const m = n.id.match(/^sub\/([^/]+)\/(.+)$/);
    if (m) {
      const s = view.subscriptions.find(x => x.product_id === m[1] && x.username === m[2]);
      if (!s) return null;
      return <>{NEXT[s.status].map(to => (
        <button key={to} type="button" className="secondary-action" disabled={busy}
          onClick={() => send({ action: 'sub_set', username: s.username, product: s.product_id, status: to }, `${VERB[to]}d ${s.username}'s ${s.product_id}.`)}>
          {VERB[to]}</button>))}</>;
    }
    const p = view.products.find(x => `product/${x.id}` === n.id);
    if (!p) return null;
    return <>
      <button type="button" className="secondary-action" disabled={busy}
        onClick={() => send({ action: 'product_save', ...p, visible: !p.visible }, `${p.name} is ${p.visible ? 'hidden from' : 'shown on'} account dashboards.`)}>
        {p.visible ? 'Hide' : 'Show'}</button>
      <button type="button" className="secondary-action" disabled={busy}
        onClick={() => { if (window.confirm(`Remove the product ${p.name}?`)) send({ action: 'product_remove', id: p.id }, `Removed ${p.name}.`); }}>Remove</button>
    </>;
  }

  if (!view) return <p className="empty-state">{msg || 'Loading API access…'}</p>;
  return (
    <section className="panel" aria-label="API access">
      <div className="panel-heading"><div><h3>API access</h3><p>Who may read the Data Hub API. Raw recorded data needs only a key (accounts register theirs on their dashboard); processed data needs an active subscription. Admin only.</p></div></div>

      <div className="builder-selection-bar">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={view.guest_enabled} disabled={busy}
            onChange={e => send({ action: 'guest', on: e.target.checked }, `Guest access is ${e.target.checked ? 'on' : 'off'}.`)} />
          Guest access
        </label>
        <span>{view.guest_enabled ? 'On: visitors without a key read the source bundles’ raw data (last 30 days, 500 rows a request, 60 requests a minute).' : 'Off: every request needs an account’s Data Hub key.'}</span>
      </div>

      <h4>Subscriptions</h4>
      <DrillTable nodes={tree} rainbow={rainbow} empty="No products yet: add one below."
        columns={{ first: 'Product · account', action: { title: '', cell: actions } }} />

      <div className="mapping-form" aria-label="Start a subscription">
        <label>ACCOUNT<select value={grant.username} onChange={e => setGrant(g => ({ ...g, username: e.target.value }))}>
          <option value="">choose…</option>{view.accounts.map(a => <option key={a}>{a}</option>)}</select></label>
        <label>PRODUCT<select value={grant.product} onChange={e => setGrant(g => ({ ...g, product: e.target.value }))}>
          <option value="">choose…</option>{view.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="builder-action" disabled={busy || !grant.username || !grant.product}
            onClick={() => send({ action: 'sub_set', username: grant.username, product: grant.product, status: 'active' }, `Activated ${grant.product} for ${grant.username}.`)}>
            Activate for this account</button>
          <span>For now you activate subscriptions; later the accounts’ Subscribe buttons will go through Stripe.</span>
        </div>
      </div>

      <div className="mapping-form" aria-label="Add a product">
        <label>PRODUCT ID<input value={product.id} onChange={e => setProduct(p => ({ ...p, id: e.target.value.toLowerCase() }))} placeholder="cluster-outputs" /></label>
        <label>NAME<input value={product.name} onChange={e => setProduct(p => ({ ...p, name: e.target.value }))} placeholder="Cluster outputs" /></label>
        <label>KIND<input value={product.kind} onChange={e => setProduct(p => ({ ...p, kind: e.target.value }))} placeholder="processed" /></label>
        <label style={{ gridColumn: '1 / -1' }}>DESCRIPTION<input value={product.description} onChange={e => setProduct(p => ({ ...p, description: e.target.value }))} /></label>
        <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="builder-action" disabled={busy || !product.id || !product.name}
            onClick={async () => { if (await send({ action: 'product_save', ...product, visible: true }, `Saved ${product.name}.`)) setProduct({ id: '', name: '', description: '', kind: 'processed' }); }}>
            Add product</button>
          <span>A product is a processed-data node accounts can subscribe to.</span>
        </div>
      </div>
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </section>
  );
}
