'use client';

// The account's Data Hub API access (on the user dashboard /home and on "Your account"): its Data Hub keys (a new key
// is shown once; the site keeps only its hash) and the processed-data products, each viewable (an active
// subscription) or restricted with a Subscribe button. For now Subscribe asks the owner to activate; later it opens
// Stripe Checkout. API: /api/access/datahub (src/lib/datahubAccess.ts). The API itself: arcium_midend/api.

import { useState } from 'react';
import { Notice, postJson, useJson } from '@/ui/kit';

interface Key { id: string; label: string; tail: string; created_at: string }
interface Product { id: string; name: string; description: string; access: 'viewable' | 'restricted'; status: string | null }
interface View { keys: Key[]; max_keys: number; products: Product[] }

const API = '/api/access/datahub';

export default function DataHubAccess() {
  const { data, reload } = useJson<View>(API);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true); setMsg(null);
    const { ok, data: out } = await postJson(API, body);
    setBusy(false);
    if (!ok) { setMsg({ ok: false, text: out.error ?? 'That did not work.' }); return null; }
    setMsg({ ok: true, text: done }); reload();
    return out;
  }

  return (
    <section className="m-card">
      <h2>Data Hub API</h2>
      <p>Read the Data Hub&rsquo;s recorded data from your own code. Send your key in the <code>X-Datahub-Key</code> header;
        raw data needs only a key, processed data needs a subscription.</p>
      {!data ? <p className="m-muted">Loading…</p> : (
        <>
          <h3>Your keys</h3>
          {fresh && (
            <p className="m-badge good" style={{ wordBreak: 'break-all' }}>New key (copy it now, it is not shown again): <code>{fresh}</code></p>
          )}
          {data.keys.length > 0 && (
            <ul className="m-list">
              {data.keys.map(k => (
                <li key={k.id}>
                  <span>{k.label || 'Data Hub key'}<small className="m-muted"> · …{k.tail} · created {k.created_at.slice(0, 10)}</small></span>
                  <button type="button" className="m-btn danger" disabled={busy}
                    onClick={() => { if (window.confirm('Revoke this key? Programs using it stop working.')) act({ action: 'key_revoke', id: k.id }, 'Key revoked.'); }}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
          {data.keys.length < data.max_keys && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Key name (e.g. research laptop)" aria-label="Key name" />
              <button type="button" className="m-btn" disabled={busy}
                onClick={async () => { const out = await act({ action: 'key_create', label }, 'Key created.'); if (out?.key) { setFresh(out.key); setLabel(''); } }}>
                Create key</button>
            </div>
          )}

          <h3>Processed data</h3>
          {data.products.length === 0 ? <p className="m-muted">No products yet.</p> : (
            <ul className="m-list">
              {data.products.map(p => (
                <li key={p.id}>
                  <span><strong>{p.name}</strong> <span className={`m-badge${p.access === 'viewable' ? ' good' : ''}`}>{p.access}</span>
                    <small className="m-muted"> {p.description}</small></span>
                  {p.access === 'viewable' ? null
                    : p.status === 'requested' ? <span className="m-muted">Requested: waiting for activation</span>
                    : p.status === 'paused' ? <span className="m-muted">Paused</span>
                    : <button type="button" className="m-btn" disabled={busy}
                        onClick={() => act({ action: 'subscribe', product: p.id }, `Asked for ${p.name}. You will see it as viewable once activated.`)}>Subscribe</button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Notice msg={msg} />
    </section>
  );
}
