'use client';

// Sign in: one Arcium account for the app and every hub, three ways in.
//   Sign in   a real account: the workspace once the owner has granted it access, its user dashboard (/home) until then
//   User      a simulated user profile for this session: a throwaway test session on simulated systems, with its own
//             data, functions and settings, deleted when it ends (src/lib/demo.ts)
//   Admin     the owner: the admin dashboard (the sign-in form's Admin button: the owner's passkey)
// Already signed in, or after signing in, go to ?next (a page of this site, or a hub page) or the workspace.
import { useEffect, useState } from 'react';
import { AuthCard, BASE, Shell, postJson, useSiteInfo } from './_public/Shell';
import { SignInForm } from './_public/SignInForm';
import t from './_public/theme.module.css';
import { safeHubNext } from '@/lib/hub-origins';

function landing(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && /^\/(?![/\\])/.test(next)) return `${BASE}${next}`;
  return safeHubNext(next, window.location.protocol === 'https:') ?? `${BASE}/w`;
}

export default function SignInPage() {
  const info = useSiteInfo();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${BASE}/api/sso/me`).then(r => (r.ok ? r.json() : null)).then(me => {
      if (me) window.location.href = landing();
    }).catch(() => {});
  }, []);

  async function startTestSession() {
    setError('');
    setStarting(true);
    const { ok, data } = await postJson('/api/demo/start', {});
    if (!ok) { setStarting(false); setError(data.error ?? 'Could not start a simulated session.'); return; }
    window.location.href = `${BASE}/w/factory.silos`;
  }

  return (
    <Shell>
      <AuthCard title="Sign in" intro="One Arcium account for every Arcium site. Admin takes the owner to the admin dashboard; an account signs in to its dashboard, which shows the functions it can use.">
        <SignInForm onSignedIn={() => { window.location.href = landing(); }} />
        {info?.test_sessions && (
          <div className={t.links} style={{ display: 'block', marginTop: 18 }}>
            <p style={{ margin: '0 0 8px' }}>No account? Explore as a simulated user: simulated silos, models, engines and their
              equity, the Portfolio Maker, and your own settings, for this session only (deleted after {info.test_session_hours ?? 2} hours
              or when you sign out).</p>
            <button type="button" className={t.btn} onClick={startTestSession} disabled={starting}>
              {starting ? 'Starting…' : 'User'}
            </button>
            <div className={t.error} role="alert">{error}</div>
          </div>
        )}
      </AuthCard>
    </Shell>
  );
}
