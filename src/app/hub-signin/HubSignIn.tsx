'use client';

// Two steps on one page.
//   Arriving without a pass: remember a random state and the page to return to, then go to the app's /sso page.
//   Arriving with #arcium_pass=...&state=...: check the state, post the pass to /api/sso/accept (which sets this
//   host's session), then go back to the page the person wanted.

import { useEffect, useState } from 'react';

const KEY = 'arcium_hub_signin';

export default function HubSignIn({ appOrigin }: { appOrigin: string }) {
  const [msg, setMsg] = useState('Signing you in with your Arcium account…');

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const pass = hash.get('arcium_pass');
    if (pass) {
      history.replaceState(null, '', window.location.pathname);          // the pass leaves the address bar at once
      let saved: { state?: string; next?: string } = {};
      try { saved = JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      if (!saved.state || saved.state !== hash.get('state')) { setMsg('That sign-in did not start here. Open the page again.'); return; }
      fetch('/api/sso/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }) })
        .then(async r => {
          if (r.ok) { window.location.replace(saved.next && saved.next.startsWith('/') ? saved.next : '/'); return; }
          const d = await r.json().catch(() => ({}));
          setMsg(d.error ?? 'Could not sign you in.');
        })
        .catch(() => setMsg('Could not sign you in. Check your connection and try again.'));
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const next = new URLSearchParams(window.location.search).get('next') ?? '/';
    try { sessionStorage.setItem(KEY, JSON.stringify({ state, next })); } catch { /* ignore */ }
    const q = new URLSearchParams({ client: 'datahub', return: `${window.location.origin}/hub-signin`, state });
    window.location.replace(`${appOrigin}/sso?${q}`);
  }, [appOrigin]);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', background: '#f6f7f4', color: '#344033' }}>
      <p role="status">{msg}</p>
    </main>
  );
}
