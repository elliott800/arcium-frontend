'use client';

// API keys (Data Hub, admin only): the keys, account ids and settings each data source's connector uses. Add a key
// (its API name, the connector it is for, and the fields that connector reads), update one (blank fields keep their
// stored value), delete an unused one, or point a source at a key. Values are stored encrypted on the server and never
// come back to the browser: the page shows only which fields are set (src/lib/datahubKeys.ts).

import { useEffect, useState } from 'react';
import { api, hub, post, waitFor } from './api';
import type { DhSource } from '@/lib/datahubTypes';
import type { KeysView, SourceKey } from '@/lib/datahubKeys';

interface Draft { id?: string; name: string; connector: string; fields: Record<string, string> }
const blank: Draft = { name: '', connector: '', fields: {} };

export default function ApiKeys({ sources }: { sources: DhSource[] }) {
  const [view, setView] = useState<KeysView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [use, setUse] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<KeysView>(hub({ view: 'keys' })).then(setView).catch(e => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true); setMsg('');
    try { await post(body); setMsg(done); setDraft(null); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function assignTo(k: SourceKey) {
    const connection = use[k.id];
    if (!connection) return;
    setBusy(true); setMsg(`Asking the Data Hub to use ${k.name} for ${connection}…`);
    try {
      const { control_id } = await post<{ control_id: number }>({ action: 'key_use', connection, id: k.id });
      const c = await waitFor(control_id);
      setMsg(c.status === 'done' ? `${connection} now uses ${k.name}.` : `The Data Hub did not switch ${connection}: ${String((c.result as { error?: string } | null)?.error ?? 'no answer yet')}`);
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  if (!view) return <p className="empty-state">{msg || 'Loading API keys…'}</p>;
  const fieldsOf = (connector: string) => view.fields[connector] ?? view.fields.other;
  const editing = draft && draft.id ? view.keys.find(k => k.id === draft.id) : null;

  return (
    <section className="panel" aria-label="API keys">
      <div className="panel-heading"><div><h3>API keys</h3><p>The API keys, account IDs and settings each data source&apos;s connector uses. They are stored encrypted on the server, where the Data Hub reads them; once saved, a value is never shown again, only whether it is set. Admin only.</p></div>
        <button type="button" className="builder-action" onClick={() => setDraft(d => (d && !d.id ? null : { ...blank }))}>{draft && !draft.id ? 'Close' : 'Add key'}</button></div>

      {draft && (
        <div className="mapping-form" aria-label={draft.id ? 'Update key' : 'Add key'}>
          <label>API NAME<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
            disabled={!!editing && !editing.managed} placeholder="OANDA practice" /></label>
          <label>CONNECTOR<select value={draft.connector} disabled={!!draft.id} onChange={e => setDraft({ ...draft, connector: e.target.value, fields: {} })}>
            <option value="">Choose…</option>{view.connectors.map(c => <option key={c}>{c}</option>)}</select></label>
          {draft.connector && fieldsOf(draft.connector).map(f => {
            const cur = editing?.fields.find(x => x.name === f.name);
            return (
              <label key={f.name}>{f.label.toUpperCase()}{f.required && !draft.id ? ' *' : ''}
                <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={draft.fields[f.name] ?? ''}
                  onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [f.name]: e.target.value } })}
                  placeholder={draft.id ? (cur?.set ? (f.secret ? 'set: leave blank to keep' : cur.value ?? '') : 'not set') : (f.placeholder ?? '')} />
              </label>
            );
          })}
          <div className="builder-selection-bar" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="builder-action" disabled={busy || !draft.connector || (!draft.id && !draft.name)}
              onClick={() => act({ action: 'key_save', ...draft }, draft.id ? `Updated ${draft.name}.` : `Added ${draft.name}. Choose it when you add a source, or use it for one below.`)}>
              {draft.id ? 'Save changes' : 'Save key'}</button>
            {draft.id && <button type="button" className="secondary-action" onClick={() => setDraft(null)}>Cancel</button>}
            <span>{draft.id ? 'Blank fields keep their stored value.' : 'Fields marked * are needed by this connector.'}</span>
          </div>
        </div>
      )}

      <div className="source-summary-table-wrap"><table className="source-summary-table">
        <thead><tr><th>API name</th><th>Connector</th><th>Fields</th><th>Used by</th><th>Updated</th><th>Actions</th></tr></thead>
        <tbody>{view.keys.length ? view.keys.map(k => (
          <tr key={k.id}>
            <td><strong>{k.name}</strong>{!k.managed && <small className="form-help"> (a broker login the Data Hub uses)</small>}</td>
            <td>{k.connector}</td>
            <td>{k.fields.map(f => <div key={f.name}><small>{f.label}: {f.set ? (f.secret ? 'set' : f.value) : 'not set'}</small></div>)}</td>
            <td>{k.used_by.join(', ') || '—'}</td>
            <td>{k.updated_at.slice(0, 10)}</td>
            <td>
              <div className="builder-selection-bar" style={{ padding: 0, border: 0 }}>
                <button type="button" className="secondary-action" disabled={busy} onClick={() => setDraft({ id: k.id, name: k.name, connector: k.connector, fields: {} })}>Update</button>
                {k.managed && !k.used_by.length && <button type="button" className="secondary-action" disabled={busy}
                  onClick={() => { if (window.confirm(`Delete the key ${k.name}?`)) act({ action: 'key_delete', id: k.id }, `Deleted ${k.name}.`); }}>Delete</button>}
                <select aria-label={`Use ${k.name} for a source`} value={use[k.id] ?? ''} onChange={e => setUse(u => ({ ...u, [k.id]: e.target.value }))}>
                  <option value="">use for a source…</option>
                  {sources.filter(s => !k.used_by.includes(s.connection)).map(s => <option key={s.connection} value={s.connection}>{s.connection} ({s.type})</option>)}</select>
                <button type="button" className="secondary-action" disabled={busy || !use[k.id]} onClick={() => assignTo(k)}>Use</button>
              </div>
            </td>
          </tr>
        )) : <tr><td colSpan={6} className="empty-state">No API keys stored here yet.</td></tr>}</tbody>
      </table></div>

      {!!view.settings_refs.length && (
        <div className="mapping-section">
          <div className="panel-heading"><div><h4>Keys in the Data Hub&apos;s settings file</h4><p>These sources read keys from the settings file on the server (names only here). To manage one on this page, add it as a key above, then use it for that source.</p></div></div>
          <div className="source-summary-table-wrap"><table className="source-summary-table">
            <thead><tr><th>Reference</th><th>Used by</th></tr></thead>
            <tbody>{view.settings_refs.map(r => <tr key={r.ref}><td>{r.ref}</td><td>{r.used_by.join(', ')}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </section>
  );
}
