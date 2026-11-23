'use client';

// Control panel > Users: which accounts may use the portal's functions (a switch per account; accounts that asked are
// listed first), and the sign-in page's User button (the template of simulated systems its sessions copy, and how many
// sessions are running). /api/admin/access and /api/admin/test-sessions.

import { useEffect, useState } from 'react';

interface Account { user_id: string; username: string; email: string; portal_access: boolean; portal_requested_at: string | null }
interface Sessions { template_silos: number; template_models: number; active_sessions: number }

export default function AccessPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => Promise.all([
    fetch('/api/admin/access', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])),
    fetch('/api/admin/test-sessions', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
  ]).then(([a, s]) => { setAccounts(a); setSessions(s); });
  useEffect(() => { load(); }, []);

  async function post(url: string, body: unknown, done: string) {
    setBusy(true); setMsg('');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? done : d.error ?? 'Request failed.');
      await load();
    } finally { setBusy(false); }
  }

  return (
    <>
      <section className="m-card" aria-label="Access">
        <h2>Access</h2>
        <p>Accounts that may use the portal&apos;s functions (the Factory, the Portfolio Maker). Without access an account signs in to its user dashboard and can ask for it.</p>
        {!accounts ? <p>Loading…</p> : !accounts.length ? <p>No other accounts yet.</p> : (
          <table className="m-table"><thead><tr><th>Account</th><th>Email</th><th>Access</th><th /></tr></thead>
            <tbody>{accounts.map(a => (
              <tr key={a.user_id}>
                <td>{a.username}</td><td>{a.email}</td>
                <td>{a.portal_access ? 'granted' : a.portal_requested_at ? `asked ${a.portal_requested_at.slice(0, 10)}` : 'not granted'}</td>
                <td><button type="button" className="m-btn" disabled={busy}
                  onClick={() => post('/api/admin/access', { user_id: a.user_id, on: !a.portal_access }, `${a.username}: access ${a.portal_access ? 'taken away' : 'granted'}.`)}>
                  {a.portal_access ? 'Take away' : 'Grant access'}</button></td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
      <section className="m-card" aria-label="Simulated users">
        <h2>Simulated users</h2>
        <p>The sign-in page&apos;s User button gives a visitor a simulated profile for two hours: a copy of the template below (simulated silos, models, engines and equity on a simulated machine). Your own views leave these out.</p>
        {sessions && <p>Template: {sessions.template_silos} silos, {sessions.template_models} models{sessions.template_silos ? '' : ' (not built yet: the User button waits for it)'} · running now: {sessions.active_sessions} session{sessions.active_sessions === 1 ? '' : 's'}</p>}
        <button type="button" className="m-btn" disabled={busy}
          onClick={() => { if (window.confirm('Build the simulated template now? Running sessions keep their own copies.')) post('/api/admin/test-sessions', { action: 'seed' }, 'Template built.'); }}>
          {sessions?.template_silos ? 'Rebuild the template' : 'Build the template'}</button>
      </section>
      {msg && <p className="controller-status" role="status">{msg}</p>}
    </>
  );
}
