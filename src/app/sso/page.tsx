'use client';

// Single sign-on: another Arcium site sent the browser here to sign in with
// the Arcium account (see src/lib/sso.ts). Signed in already -> straight back
// with a pass; otherwise sign in first.

import { useCallback, useEffect, useState } from 'react';
import { AuthCard, BASE, Shell, postJson, useSiteInfo } from '../_public/Shell';
import { SignInForm } from '../_public/SignInForm';
import t from '../_public/theme.module.css';

export default function SingleSignOnPage() {
  const info = useSiteInfo();
  const [step, setStep] = useState<'checking' | 'signin' | 'going' | 'error'>('checking');
  const [error, setError] = useState('');
  const [site, setSite] = useState('');

  const getPass = useCallback(async () => {
    const q = new URLSearchParams(window.location.search);
    let host = '';
    try { host = new URL(q.get('return') ?? '').host; } catch {}
    setSite(host);
    const { ok, status, data } = await postJson('/api/sso/pass',
      { client: q.get('client'), return_to: q.get('return'), state: q.get('state') });
    if (ok && data.redirect) { setStep('going'); window.location.replace(data.redirect); return; }
    if (status === 401) { setStep('signin'); return; }
    setError(data.error ?? 'Could not sign you in.'); setStep('error');
  }, []);

  useEffect(() => { getPass(); }, [getPass]);

  const signUp = info?.signup_open ? <a className={`${t.btn} ${t.primary}`} href={`${BASE}/signup`}>Sign up</a> : null;

  return (
    <Shell actions={signUp}>
      {step === 'checking' && <AuthCard title="Arcium account" intro="Checking your sign-in…" />}
      {step === 'going' && <AuthCard title="Signed in" intro={<>Taking you back to <strong>{site}</strong>…</>} />}
      {step === 'error' && (
        <AuthCard title="Can't sign in" intro={error}>
          <div className={t.links}><a href={`${BASE}/account`}>Your Arcium account</a></div>
        </AuthCard>
      )}
      {step === 'signin' && (
        <AuthCard title="Sign in with Arcium"
                  intro={<>One Arcium account for every Arcium site. Sign in to continue to <strong>{site || 'the site'}</strong>.</>}>
          <SignInForm signupOpen={info?.signup_open} onSignedIn={() => { setStep('checking'); getPass(); }} />
        </AuthCard>
      )}
    </Shell>
  );
}
