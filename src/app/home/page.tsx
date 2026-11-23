// Page: the user dashboard (/home): a signed-in Arcium account that the owner has not granted the portal's functions
// yet. It shows the account, the functions with the locked ones marked, and asks the owner for access. With access the
// account goes to the workspace (/w) instead.

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, accountFromToken } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { MODULES } from '@/modules/registry';
import RequestAccess, { SignOut } from './RequestAccess';
import '@/shell/shell.css';

export const metadata: Metadata = { title: 'Your dashboard' };
export const dynamic = 'force-dynamic';

export default async function UserHome() {
  const account = await accountFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) redirect('/?next=%2Fhome');
  if (account.portal) redirect('/w');
  const row = await getDb().prepare(`SELECT portal_requested_at FROM users WHERE user_id = ?`).get(account.user_id) as
    { portal_requested_at: string | null } | undefined;
  const functions = MODULES.filter(m => m.access === 'portal' && m.status === 'live');
  return (
    <div className="m-page" style={{ maxWidth: 860, margin: '40px auto' }}>
      <div className="m-head"><h1>Welcome, {account.username}</h1><p>Your Arcium account: {account.email}</p></div>
      <section className="m-card">
        <h2>Your functions</h2>
        <p>These open once the owner grants your account access.</p>
        <ul>{functions.map(m => <li key={m.id}><strong>{m.title}</strong> <span className="m-badge">locked</span> <small>{m.summary}</small></li>)}</ul>
        <RequestAccess requested={row?.portal_requested_at ? new Date(row.portal_requested_at).toISOString() : null} />
      </section>
      <p><SignOut /></p>
    </div>
  );
}
