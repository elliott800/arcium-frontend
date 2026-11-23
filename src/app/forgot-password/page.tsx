'use client';

// Page (public): ask for a password reset link.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AuthCard, Shell, postJson } from '../_public/Shell';
import t from '../_public/theme.module.css';

export default function ForgotPasswordPage() {
  const [login, setLogin] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { ok, data } = await postJson('/api/password-reset', { login });
    setBusy(false);
    if (!ok) return setError(data.error ?? 'Could not send the email.');
    setSent(true);
  }

  return (
    <Shell actions={<Link className={t.btn} href="/">Sign in</Link>}>
      {sent ? (
        <AuthCard title="Check your email"
                  intro="If that account exists, a reset link is on its way. It expires in an hour." />
      ) : (
        <AuthCard title="Reset your password" intro="Enter your username or email and we'll email you a reset link.">
          <form onSubmit={submit}>
            <label htmlFor="fp-login">Username or email</label>
            <input id="fp-login" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
                   value={login} onChange={e => setLogin(e.target.value)} required />
            <button type="submit" className={`${t.btn} ${t.primary}`} disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
          </form>
          <div className={t.error} role="alert">{error}</div>
        </AuthCard>
      )}
    </Shell>
  );
}
