'use client';

// Confirm an email address: the link the sign-up email sends (/verify-email?token=...). /api/verify-email.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthCard, Shell, postJson } from '../_public/Shell';
import t from '../_public/theme.module.css';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'checking' | 'done' | 'failed'>(token ? 'checking' : 'failed');
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token.');
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || !token) return;   // the token is single-use; don't post it twice
    sent.current = true;
    postJson('/api/verify-email', { token }).then(({ ok, data }) => {
      if (!ok) { setState('failed'); setMessage(data.error ?? 'This link is invalid, already used, or expired.'); return; }
      setState('done');
      setMessage(data.approval === 'approved'
        ? 'Your email is confirmed. Sign in: your dashboard shows your functions, and you can ask for access there.'
        : 'Your email is confirmed. Your account is waiting for approval; you\'ll get an email when you can sign in.');
    });
  }, [token]);

  return (
    <AuthCard title={state === 'checking' ? 'Confirming your email…' : state === 'done' ? 'Email confirmed' : 'Link not valid'}>
      {state !== 'checking' && <p className={state === 'done' ? t.ok : t.error}>{message}</p>}
      {state !== 'checking' && <Link className={`${t.btn} ${t.primary}`} href="/">Go to sign in</Link>}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return <Shell><Suspense><Verify /></Suspense></Shell>;
}
