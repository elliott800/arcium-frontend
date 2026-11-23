'use client';

// Sign up: create an Arcium account (one account for every Arcium site). After confirming the email the account signs
// in to its user dashboard, where its functions stay locked until the owner grants access. /api/signup.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AuthCard, Shell, postJson, useSiteInfo } from '../_public/Shell';
import t from '../_public/theme.module.css';

const MIN_LENGTH = 10;
const USERNAME = /^[a-z][a-z0-9_]{2,31}$/;

export default function SignUpPage() {
  const info = useSiteInfo();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ to: string; emailed: boolean; approval?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!USERNAME.test(username)) return setError('Username: 3–32 characters, starting with a letter; lowercase letters, numbers and _ only.');
    if (password.length < MIN_LENGTH) return setError(`Password must be at least ${MIN_LENGTH} characters.`);
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    const { ok, data } = await postJson('/api/signup', { username, email, phone, password });
    setBusy(false);
    if (!ok) return setError(data.error ?? 'Could not create the account.');
    setDone({ to: email, emailed: data.emailed !== false, approval: data.approval });
  }

  const signIn = <Link className={t.btn} href="/">Sign in</Link>;

  if (info && !info.signup_open) {
    return (
      <Shell actions={signIn}>
        <AuthCard title="Sign-up is closed" intro="New Arcium accounts can't be made here right now." />
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell actions={signIn}>
        {done.emailed ? (
          <AuthCard title="Check your email" intro={<>We sent a confirmation link to <strong>{done.to}</strong>.</>}>
            <p className={t.hint}>After you confirm, sign in: your dashboard shows your functions, and you can ask for access there.</p>
          </AuthCard>
        ) : done.approval === 'approved' ? (
          <AuthCard title="Account created" intro={<>Your Arcium account for <strong>{done.to}</strong> is ready.</>}>
            <Link className={`${t.btn} ${t.primary}`} href="/">Sign in</Link>
          </AuthCard>
        ) : (
          <AuthCard title="Account created" intro={<>Your Arcium account for <strong>{done.to}</strong> is waiting for approval.</>}>
            <p className={t.hint}>Once it&rsquo;s approved, sign in here or choose &ldquo;Sign in with Arcium&rdquo; on any Arcium site.</p>
          </AuthCard>
        )}
      </Shell>
    );
  }

  return (
    <Shell actions={signIn}>
      <AuthCard title="Create your Arcium account" intro="One account for every Arcium site. Pick a username; you can sign in with it or your email.">
        <form onSubmit={submit}>
          <label htmlFor="su-user">Username</label>
          <input id="su-user" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
                 value={username} onChange={e => setUsername(e.target.value.toLowerCase())} required />
          <div className={t.hint}>3–32 characters: lowercase letters, numbers and _, starting with a letter.</div>
          <label htmlFor="su-email">Email</label>
          <input id="su-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
          <label htmlFor="su-phone">Phone <span className={t.hint}>(optional)</span></label>
          <input id="su-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+1 555 123 4567"
                 value={phone} onChange={e => setPhone(e.target.value)} />
          <label htmlFor="su-pw">Password</label>
          <input id="su-pw" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
          <div className={t.hint}>At least {MIN_LENGTH} characters.</div>
          <label htmlFor="su-pw2">Confirm password</label>
          <input id="su-pw2" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          <button type="submit" className={`${t.btn} ${t.primary}`} disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        </form>
        <div className={t.error} role="alert">{error}</div>
        <div className={t.links}><span>Already have an account? <Link href="/">Sign in</Link></span></div>
      </AuthCard>
    </Shell>
  );
}
