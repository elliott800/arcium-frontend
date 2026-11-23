'use client';

// The user dashboard's Request access button: tells the owner this account wants the portal's functions.
import { useState } from 'react';

export default function RequestAccess({ requested }: { requested: string | null }) {
  const [at, setAt] = useState(requested);
  const [msg, setMsg] = useState('');
  async function ask() {
    const r = await fetch('/api/access/request', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setAt(d.requested_at); else setMsg(d.error ?? 'Could not send the request.');
  }
  return at
    ? <p>Access requested on {at.slice(0, 10)}. The owner will switch your functions on.</p>
    : <p><button type="button" className="m-btn primary" onClick={ask}>Request access</button> {msg}</p>;
}

/** Signs out and goes back to the sign-in page. */
export function SignOut() {
  return <button type="button" className="m-btn" onClick={async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/'; }}>Sign out</button>;
}
