'use client';

// Sign in: one Arcium account for the app and every hub. Already signed in, or after signing in, go to
// ?next (a page of this site, or a hub page) or the workspace. On the demo site (ARCIUM_SITE_MODE=demo)
// visitors start a throwaway test session on simulated systems instead (src/lib/demo.ts).
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
  const [owner, setOwner] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/sso/me`).then(r => (r.ok ? r.json() : null)).then(me => {
      if (me) window.location.href = landing();
    }).catch(() => {});
  }, []);

  async function startTestSession() {
    setError('');
    setStarting(true);
    const { ok, data } = await postJson('/api/demo/start', {});
    if (!ok) { setStarting(false); setError(data.error ?? 'Could not start a test session.'); return; }
    window.location.href = `${BASE}/w/factory.silos`;
  }

  return (
    <Shell actions={info?.demo_url ? <a className={t.btn} href={info.demo_url}>Try the demo</a> : undefined}>
      {info?.test_sessions && (
        <AuthCard title="Try Arcium Signals" intro={<>
          Start a private test session on simulated trading systems: the silos, the model catalog, the engines and
          their equity, and the Portfolio Maker. Nothing is kept: the session and everything in it are deleted after{' '}
          {info.test_session_hours ?? 2} hours or when you sign out.
        </>}>
          <button type="button" className={`${t.btn} ${t.primary}`} onClick={startTestSession} disabled={starting}>
            {starting ? 'Starting…' : 'Start a test session'}
          </button>
          <div className={t.error} role="alert">{error}</div>
          {!owner && (
            <div className={t.links}>
              <button type="button" className={t.linkBtn} onClick={() => setOwner(true)}>Owner sign-in</button>
            </div>
          )}
        </AuthCard>
      )}
      {info && (!info.test_sessions || owner) && (
        <AuthCard title="Sign in" intro="One Arcium account for every Arcium site. Sign in with your username or email.">
          <SignInForm onSignedIn={() => { window.location.href = landing(); }} />
        </AuthCard>
      )}
    </Shell>
  );
}
