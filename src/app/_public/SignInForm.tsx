'use client';

// Public pages: the sign-in form (username or email and password), used by the sign-in page.

import { useEffect, useState, type FormEvent } from 'react';
import { BASE, postJson } from './Shell';
import { passkeySignIn, passkeysSupported } from './passkey';
import t from './theme.module.css';

export interface SignedIn { username: string; email: string; role: string; portal: boolean }

/** The Admin button (a passkey saved on this device: one click), then username-or-email and password; calls
 *  onSignedIn once the session cookie is set. */
export function SignInForm({ onSignedIn, signupOpen }: { onSignedIn: (u: SignedIn) => void; signupOpen?: boolean }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(false);
  useEffect(() => { setKeys(passkeysSupported()); }, []);

  async function withKey() {
    setError(''); setNotice(''); setCode('');
    setBusy(true);
    const { ok, data } = await passkeySignIn();
    setBusy(false);
    if (!ok) { setError(data.error ?? 'Something went wrong.'); setCode(data.code ?? ''); return; }
    signedIn(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the login route's JSON reply
  function signedIn(data: Record<string, any>) {
    try { sessionStorage.setItem('arcium_user', JSON.stringify({ username: data.username, email: data.email, role: data.role })); } catch {}
    onSignedIn({ username: data.username, email: data.email, role: data.role, portal: !!data.portal });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setNotice(''); setCode('');
    setBusy(true);
    const { ok, data } = await postJson('/api/login', { login, password });
    setBusy(false);
    if (!ok) { setError(data.error ?? 'Something went wrong.'); setCode(data.code ?? ''); return; }
    signedIn(data);
  }

  async function resend() {
    setError(''); setNotice('');
    const { ok, data } = await postJson('/api/verify-email', { resend: true, login, password });
    if (ok) setNotice(data.already ? 'Your email is already confirmed.' : 'A new confirmation link is on its way.');
    else setError(data.error ?? 'Could not resend the link.');
  }

  return (
    <>
      {keys && (
        <div className={t.keyBox}>
          <button type="button" className={`${t.btn} ${t.primary}`} onClick={withKey} disabled={busy}>Admin</button>
          <p>One click with the Arcium key saved on this device. No key yet? Sign in below, then save one from your account page.</p>
          <div className={t.or}><span>or sign in with your password</span></div>
        </div>
      )}
      <form onSubmit={submit}>
        <label htmlFor="login">Username or email</label>
        <input id="login" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
               value={login} onChange={e => setLogin(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password"
               value={password} onChange={e => setPassword(e.target.value)} required />
        <button type="submit" className={`${t.btn} ${t.primary}`} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className={t.error} role="alert">{error}</div>
      {code === 'EMAIL_UNVERIFIED' && (
        <button type="button" className={t.linkBtn} onClick={resend}>Resend the confirmation email</button>
      )}
      {notice && <div className={t.ok}>{notice}</div>}
      <div className={t.links}>
        <a href={`${BASE}/forgot-password`}>Forgot password?</a>
        {signupOpen && <a href={`${BASE}/signup`}>Create an Arcium account</a>}
      </div>
    </>
  );
}
