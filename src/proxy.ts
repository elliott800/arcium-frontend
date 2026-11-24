// First line of defense for the API: every /api request needs a valid
// session except sign-in/invite endpoints and machine endpoints (which
// authenticate with their own machine key). Routes still check the session
// themselves via requireUser/requireAdmin — this gate just guarantees an
// unconverted route can never be reached anonymously or used to read
// another user's data via ?username=.

import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, userFromToken } from '@/lib/auth';
import { isDemo } from '@/lib/site-mode';
import { APP_ORIGIN, DATAHUB_ORIGIN, isAppHost, isArcadeHost, isBrokerhubHost, isDatahubHost, isServicesHost } from '@/lib/hosts';

const PUBLIC_PREFIXES = ['/api/login', '/api/logout', '/api/invite/accept', '/api/machine/',
  // The midend's server-to-server routes check MIDEND_SECRET themselves.
  '/api/internal/midend/',
  '/api/signup', '/api/verify-email', '/api/password-reset', '/api/site-info', '/api/demo/start',
  // Single sign-on: these check the Arcium account themselves (src/lib/auth.ts accountFromToken).
  '/api/sso/',
  // Passkeys (the Admin button): sign-in is public; saving, listing and approving check the account themselves
  // (src/app/api/passkey, accountFromToken / requireAdmin).
  '/api/passkey',
  // The hubs' repos: public ones are readable signed out; changes check the Arcium account (src/lib/hub-http.ts).
  '/api/hubs/',
  // The Dashboards menu on every Arcium site: signed out it lists the public dashboards (src/app/api/nav).
  '/api/nav',
  // The user dashboard's Request access: an account without the portal's functions (it checks the account itself).
  '/api/access/',
  // The seed workbench (arcium-signals): signs in with the Arcium account, then a bearer token (src/lib/workbench.ts).
  '/api/workbench/'];

// Demo site: actions that hand work to a machine or the hub services. The demo
// runs on simulated machines that never pick work up, so these would just sit
// queued; answer straight away instead. Reads still work.
const DEMO_MACHINE_ACTIONS = ['/api/scripts/dispatch', '/api/engines/', '/api/optimizers/', '/api/processes/',
  '/api/sources', '/api/seeds', '/api/accounts', '/api/admin/sources', '/api/admin/services'];
const DEMO_ACTION_MESSAGE =
  "This is a simulated session: its machine is simulated, so jobs don't run here. Everything you see comes from simulated runs.";

// datahub.arciumsignals.com (src/lib/hosts.ts): the Data Hub page at its root, its own APIs, and the sign-in hand-off.
// Everything else on that host belongs to the app, so it goes there. Files (a dot in the last segment) are served here.
const DATAHUB_APIS = ['/api/admin/datahub/', '/api/sso/accept', '/api/me', '/api/nav', '/api/logout'];
const isFile = (path: string) => /\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? '');

async function datahubHost(req: NextRequest): Promise<NextResponse | null> {
  const { pathname: path, search } = req.nextUrl;
  if (path.startsWith('/api/')) {
    if (!DATAHUB_APIS.some(p => path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : p + '/'))) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    return null;                                          // the API checks below apply as on the app
  }
  if (path === '/hub-signin' || path.startsWith('/_next/') || isFile(path)) return NextResponse.next();
  if (path === '/datahub' || path.startsWith('/datahub/')) return NextResponse.redirect(new URL('/' + search, req.url), 308);
  if (path !== '/') return NextResponse.redirect(`${APP_ORIGIN}${path}${search}`, 307);
  const user = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.redirect(new URL(`/hub-signin?next=${encodeURIComponent('/' + search)}`, req.url), 307);
  if (user.role !== 'admin') return NextResponse.redirect(`${APP_ORIGIN}/workspace`, 307);
  return NextResponse.rewrite(new URL('/datahub' + search, req.url));
}

// brokerhub.arciumsignals.com (src/lib/hosts.ts): the BrokerHub page at its root, its own API, and the sign-in hand-off;
// everything else goes to the app. Signed in like the Data Hub host; admins only.
const BROKERHUB_APIS = ['/api/admin/brokerhub/', '/api/sso/accept', '/api/me', '/api/nav', '/api/logout'];

async function brokerhubHost(req: NextRequest): Promise<NextResponse | null> {
  const { pathname: path, search } = req.nextUrl;
  if (path.startsWith('/api/')) {
    if (!BROKERHUB_APIS.some(p => path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : p + '/'))) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    return null;                                          // the API checks below apply as on the app
  }
  if (path === '/hub-signin' || path.startsWith('/_next/') || isFile(path)) return NextResponse.next();
  if (path !== '/') return NextResponse.redirect(`${APP_ORIGIN}${path}${search}`, 307);
  const user = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.redirect(new URL(`/hub-signin?next=${encodeURIComponent('/' + search)}`, req.url), 307);
  if (user.role !== 'admin') return NextResponse.redirect(`${APP_ORIGIN}/workspace`, 307);
  return NextResponse.rewrite(new URL('/brokerhub' + search, req.url));
}

// ── the Services Hub and the Arcade (src/lib/hosts.ts) ──
// Their pages are files in public/services/, served as Fusion Hub served them: / (the Services Hub front page),
// /trader, /arcade, and /static/<file>; on the Arcade's host the game is at /. Their API, /v1/..., is the Services Hub
// service: in production nginx sends /v1 there before it reaches this app; otherwise SERVICES_API_URL (a running
// Fusion Hub, e.g. http://127.0.0.1:8094), or under `npm run sim` the simulated one (src/lib/sim-services.ts).
const SERVICES_PAGES: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/trader': 'trader.html', '/trader/': 'trader.html',
  '/arcade': 'arcade.html', '/arcade/': 'arcade.html',
};
const ARCADE_PAGES: Record<string, string> = { '/': 'arcade.html', '/arcade': 'arcade.html', '/arcade/': 'arcade.html' };

function servicesHost(req: NextRequest, arcade: boolean): NextResponse {
  const { pathname: path, search } = req.nextUrl;
  if (path === '/healthz') return NextResponse.json({ ok: true });
  if (path.startsWith('/v1/')) {
    const upstream = process.env.SERVICES_API_URL?.trim().replace(/\/$/, '');
    if (upstream) return NextResponse.rewrite(`${upstream}${path}${search}`);
    if (process.env.DATABASE_URL?.startsWith('sim:')) {
      return NextResponse.rewrite(new URL(`/api/sim/services${path}${search}`, req.url));
    }
    return NextResponse.json({ error: 'The Services Hub API is not connected here (set SERVICES_API_URL).',
      code: 'NO_SERVICES_API' }, { status: 503 });
  }
  if (path.startsWith('/static/')) return NextResponse.rewrite(new URL(`/services/${path.slice('/static/'.length)}`, req.url));
  const page = (arcade ? ARCADE_PAGES : SERVICES_PAGES)[path];
  if (page) return NextResponse.rewrite(new URL(`/services/${page}`, req.url));
  if (path.startsWith('/services/') || path.startsWith('/_next/') || path === '/arcium-nav.js') return NextResponse.next();
  return NextResponse.json({ error: 'Not found.' }, { status: 404 });
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const host = req.headers.get('host');
  if (isServicesHost(host)) return servicesHost(req, false);
  if (isArcadeHost(host)) return servicesHost(req, true);
  if (isDatahubHost(host) || isBrokerhubHost(host)) {
    const res = isDatahubHost(host) ? await datahubHost(req) : await brokerhubHost(req);
    if (res) return res;
  } else if (path === '/datahub' || path.startsWith('/datahub/')) {
    // The Data Hub lives at datahub.arciumsignals.com: the app's old address goes there.
    if (isAppHost(host)) return NextResponse.redirect(`${DATAHUB_ORIGIN}/${req.nextUrl.search}`, 308);
    return NextResponse.next();
  } else if (!path.startsWith('/api/')) {
    return NextResponse.next();                           // pages on the app check their own session
  }
  if (PUBLIC_PREFIXES.some(p => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'))) {
    return NextResponse.next();
  }

  const user = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  if ((isDemo || user.demo_expires_at) && req.method !== 'GET'
      && DEMO_MACHINE_ACTIONS.some(p => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'))) {
    return NextResponse.json({ error: DEMO_ACTION_MESSAGE, code: 'DEMO_SIMULATED' }, { status: 409 });
  }

  if (user.role !== 'admin') {
    const url = req.nextUrl.clone();
    let changed = false;
    for (const key of ['username', 'owner_username']) {
      const v = url.searchParams.get(key);
      if (v !== null && v !== user.username) {
        url.searchParams.set(key, user.username);
        changed = true;
      }
    }
    if (changed) return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  // Every request but Next's own static files: the API gate, and the Data Hub host's routing.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
