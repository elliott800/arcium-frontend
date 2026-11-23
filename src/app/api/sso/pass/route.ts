// body: { client, return_to, state } -> { redirect } : the return page with a
// signed pass in its fragment (see src/lib/sso.ts). Needs the session cookie,
// which the browser only sends from this site's own pages (SameSite=Lax), and
// a pass only ever goes to the client's registered origins.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { isSimUrl } from '@/lib/sim-db';
import { isDemo } from '@/lib/site-mode';
import { checkRequest, makePass } from '@/lib/sso';

export async function POST(req: NextRequest) {
  // The demo site signs no one in to the other sites; the simulated backend (npm run sim) does, so the Services Hub
  // and the Arcade can be tried locally.
  if (isDemo && !isSimUrl(process.env.DATABASE_URL)) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const checked = checkRequest(body.client, body.return_to);
  if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  const state = String(body.state ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(state)) return NextResponse.json({ error: 'Bad request.' }, { status: 400 });

  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Not signed in.', code: 'NOT_SIGNED_IN' }, { status: 401 });

  const pass = makePass(checked.client, account, state);
  const url = checked.url;
  return NextResponse.json({
    redirect: `${url.toString()}#arcium_pass=${encodeURIComponent(pass)}&state=${encodeURIComponent(state)}`,
    site: url.host,
  });
}
