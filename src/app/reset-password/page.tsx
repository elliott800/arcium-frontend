'use client';

// Page (public): set a new password from a reset link.

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthCard, Shell, postJson } from '../_public/Shell';
import t from '../_public/theme.module.css';

const MIN_LENGTH = 10;

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_LENGTH) return setError(`Password must be at least ${MIN_LENGTH} characters.`);
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    const { ok, data } = await postJson('/api/password-reset', { token, password });
    setBusy(false);
    if (!ok) return setError(data.error ?? 'Could not reset the password.');
    setDone(true);
  }

  if (done) {
    return (
      <AuthCard title="Password changed" intro="Sign in with your new password. Other devices were signed out.">
        <Link className={`${t.btn} ${t.primary}`} href="/">Go to sign in</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit}>
        <label htmlFor="rp-pw">New password</label>
        <input id="rp-pw" type="password" autoComplete="new-password"
               value={password} onChange={e => setPassword(e.target.value)} required />
        <div className={t.hint}>At least {MIN_LENGTH} characters.</div>
        <label htmlFor="rp-pw2">Confirm password</label>
        <input id="rp-pw2" type="password" autoComplete="new-password"
               value={confirm} onChange={e => setConfirm(e.target.value)} required />
        <button type="submit" className={`${t.btn} ${t.primary}`} disabled={busy || !token}>{busy ? 'Saving…' : 'Set password'}</button>
      </form>
      <div className={t.error} role="alert">{token ? error : 'This link is missing its token.'}</div>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return <Shell actions={<Link className={t.btn} href="/">Sign in</Link>}><Suspense><Reset /></Suspense></Shell>;
}
