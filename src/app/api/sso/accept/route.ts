// The admin hosts' side of single sign-on (datahub. and brokerhub.arciumsignals.com, this same app on other hosts).
// body: { pass } -> sets this host's session cookie. Only on the Data Hub host, only a valid pass for the 'datahub'
// client (signature, audience, two-minute expiry; src/lib/sso.ts), and only for admins, since the Data Hub is the
// owner's. The browser checked the pass's state against the one it sent (src/app/hub-signin).

import { type NextRequest, NextResponse } from 'next/server';
import { createSession, destroySession, setSessionCookie, userFromToken } from '@/lib/auth';
import { isAdminHubHost, isBrokerhubHost } from '@/lib/hosts';
import { verifyPass } from '@/lib/sso';

export async function POST(req: NextRequest) {
  if (!isAdminHubHost(req.headers.get('host'))) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
  const hub = isBrokerhubHost(req.headers.get('host')) ? 'The BrokerHub' : 'The Data Hub';
  const body = await req.json().catch(() => ({}));
  const pass = verifyPass('datahub', String(body.pass ?? ''));
  if (!pass) return NextResponse.json({ error: 'That sign-in link is invalid or expired. Try again.' }, { status: 401 });
  if (pass.role !== 'admin') return NextResponse.json({ error: `${hub} is for the Arcium owner.` }, { status: 403 });

  const token = await createSession(pass.sub, req.headers.get('user-agent'));
  const user = await userFromToken(token);              // the account still exists and may use the site
  if (!user || user.role !== 'admin') {
    await destroySession(token);
    return NextResponse.json({ error: `${hub} is for the Arcium owner.` }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, token);
  return res;
}
