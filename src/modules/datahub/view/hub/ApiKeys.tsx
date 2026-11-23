'use client';

// API keys (Data Hub, admin only): one drill table of the data sources' APIs. Each API name holds its API key (with
// its secret key and public key under it) and its account IDs (up to 100), each with a Remove button. The form above
// adds an API, or adds to one with the same name (keys replace the stored ones, account IDs are appended). Values are
// stored encrypted on the server and never come back to the browser: the table shows whether a key is set, and each
// account ID's last characters (src/lib/datahubKeys.ts).

import { useEffect, useMemo, useState } from 'react';
import DrillTable from './DrillTable';
import { api, hub, post } from './api';
import type { DhNode } from '@/lib/datahubTypes';
import type { KeysView } from '@/lib/datahubKeys';

const empty = { name: '', connector: '', api_key: '', secret_key: '', public_key: '', account_ids: '' };
const isSet = (b: boolean) => (b ? 'set' : 'not set');

export default function ApiKeys({ rainbow }: { rainbow: boolean }) {
  const [view, setView] = useState<KeysView | null>(null);
  const [form, setForm] = useState(empty);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<KeysView>(hub({ view: 'keys' })).then(setView).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);

  const tree: DhNode[] = useMemo(() => {
    if (!view) return [];
    const nodes: DhNode[] = view.keys.map(k => ({
      id: `key/${k.id}`, label: k.name, source: k.connector, tags: [], count: 2,
      contents: `${k.managed ? '' : 'a broker login (read-only here) · '}${k.used_by.length ? `used by ${k.used_by.join(', ')}` : 'not used by a source yet'}`,
      children: [
        { id: `key/${k.id}/api_key`, label: 'API key', source: k.connector, tags: [], count: 2, contents: isSet(k.api_key),
          children: [
            { id: `key/${k.id}/secret_key`, label: 'Secret key', source: k.connector, tags: [], count: 1, contents: isSet(k.secret_key) },
            { id: `key/${k.id}/public_key`, label: 'Public key', source: k.connector, tags: [], count: 1, contents: isSet(k.public_key) },
          ] },
        { id: `key/${k.id}/accounts`, label: 'Account IDs', source: k.connector, tags: [], count: k.accounts.length || 1,
          contents: `${k.accounts.length} of ${view.max_accounts}`,
          children: k.accounts.map((a, i) => ({ id: `key/${k.id}/account/${i}`, label: a, source: k.connector, tags: [], count: 1,
            contents: i === 0 ? 'the connector uses this one' : '' })) },
      ],
    }));
    if (view.settings_refs.length) nodes.push({
      id: 'settings', label: 'Data Hub settings file', tags: [], count: view.settings_refs.length,
      contents: 'keys kept in the settings file on the server (names only): add one here to manage it',
      children: view.settings_refs.map(r => ({ id: `settings/${r.ref}`, label: r.ref, tags: [], count: 1, contents: `used by ${r.used_by.join(', ')}` })),
    });
    return nodes;
  }, [view]);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true); setMsg('');
    try { await post(body); setMsg(done); await load(); return true; }
    catch (e) { setMsg((e as Error).message); return false; } finally { setBusy(false); }
  }

  function removeCell(n: DhNode) {
    const m = n.id.match(/^key\/([0-9a-f-]{36})(?:\/(api_key|secret_key|public_key|account)(?:\/(\d+))?)?$/);
    if (!m || !view) return null;
    const k = view.keys.find(x => x.id === m[1]);
    if (!k?.managed) return null;
    const [, id, part, index] = m;
    if (part && part !== 'account' && !k[part as 'api_key' | 'secret_key' | 'public_key']) return null;
    const what = !part ? `the API ${k.name} and everything under it` : part === 'account' ? `account ID ${n.label} from ${k.name}` : `the ${n.label.toLowerCase()} of ${k.name}`;
    return (
      <button type="button" className="secondary-action" disabled={busy} onClick={() => {
        if (window.confirm(`Remove ${what}?`)) send({ action: 'key_remove', id, ...(part ? { part, index: Number(index ?? -1), masked: n.label } : {}) }, `Removed ${what}.`);
      }}>Remove</button>
    );
  }

  if (!view) return <p className="empty-state">{msg || 'Loading API keys…'}</p>;
  const existing = view.keys.find(k => k.managed && k.name === form.name.trim());
  const set = (patch: Partial<typeof empty>) => setForm(f => ({ ...f, ...patch }));
  return (
    <section className="panel" aria-label="API keys">
      <div className="panel-heading"><div><h3>API keys</h3><p>Each data source API with its API key, secret and public keys, and account IDs (up to {view.max_accounts}). Stored encrypted on the server, where the Data Hub reads them; a saved key is never shown again. Admin only.</p></div></div>
      <div className="mapping-form" aria-label="Add an API">
        <label>API NAME<input list="dh-api-names" value={form.name} onChange={e => set({ name: e.target.value })} placeholder="OANDA practice" />
          <datalist id="dh-api-names">{view.keys.filter(k => k.managed).map(k => <option key={k.id} value={k.name} />)}</datalist></label>
        <label>FOR CONNECTOR<select value={existing ? existing.connector : form.connector} disabled={!!existing} onChange={e => set({ connector: e.target.value })}>
          <option value="">other</option>{view.connectors.filter(c => c !== 'other').map(c => <option key={c}>{c}</option>)}</select></label>
        <label>API KEY<input type="password" autoComplete="off" value={form.api_key} onChange={e => set({ api_key: e.target.value })} placeholder={existing ? 'leave blank to keep' : ''} /></label>
        <label>SECRET KEY<input type="password" autoComplete="off" value={form.secret_key} onChange={e => set({ secret_key: e.target.value })} placeholder="optional" /></label>
        <label>PUBLIC KEY<input type="password" autoComplete="off" value={form.public_key} onChange={e => set({ public_key: e.target.value })} placeholder="optional" /></label>
        <label style={{ gridColumn: '1 / -1' }}>ACCOUNT IDS (ONE PER LINE)<textarea rows={3} value={form.account_ids} onChange={e => set({ account_ids: e.target.value })} placeholder="101-001-1234567-001" /></label>
        <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="builder-action" disabled={busy || !form.name.trim()}
            onClick={async () => { if (await send({ action: 'key_save', ...form }, existing ? `Updated ${form.name.trim()}.` : `Added ${form.name.trim()}.`)) setForm(empty); }}>
            {existing ? `Add to ${existing.name}` : 'Add API'}</button>
          <span>{existing ? 'Keys you fill in replace the stored ones; account IDs are added.' : 'An API needs its API key (or a public and a secret key).'}</span>
        </div>
      </div>
      <DrillTable nodes={tree} rainbow={rainbow} empty="No APIs stored here yet."
        columns={{ first: 'API name · key · account ID', action: { title: '', cell: removeCell } }} />
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </section>
  );
}
