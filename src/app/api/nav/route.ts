// The Dashboards menu for every Arcium site (public/arcium-nav.js) and this app's own pages
// (src/app/_public/AppSwitcher.tsx).
// GET -> { signed_in, username, admin, groups, schedule, app }
//   groups:   the dashboards this person may open, links made absolute
//   schedule: Release 1 at a glance, for admins only
// Read-only. The session cookie (SameSite=Lax) only comes along from *.arciumsignals.com pages;
// other Arcium sites get the signed-out menu, whose links still sign in through this app.

import { type NextRequest, NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/public-origin';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { appsFor } from '@/lib/apps';
import { hubOrigins } from '@/lib/hub-origins';
import { scheduleStatus } from '@/lib/schedule-status';

const SITES = [
  'https://discordhub.arciumsignals.com', 'https://arcade.arciumsignals.com', 'https://serviceshub.arciumsignals.com',
  'https://www.arciumsignals.com', 'https://arciumsignals.com', 'https://demo.arciumsignals.com',
  'https://fusionhub.arciumfinancial.com', 'https://www.arciumfinancial.com',
  'https://www.arciumsites.com', 'https://arciumsites.com', 'https://leadgenerator.arciumsites.com',
];

function allowedOrigins(): string[] {
  const production = process.env.NODE_ENV === 'production';
  const extra = (process.env.NAV_EXTRA_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const local = production ? [] : [8080, 3002, 3100, 8094].flatMap(p => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
  return [...hubOrigins('', production), ...SITES, ...local, ...extra];
}

function cors(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
}

export async function GET(req: NextRequest) {
  const base = publicOrigin(req);
  const account = await accountFromToken(sessionToken(req));
  const admin = account?.role === 'admin';
  const groups = appsFor({ admin, owner: !!account?.portal }).map(g => ({
    site: g.site,
    apps: g.apps.map(a => ({ id: a.id, name: a.name, desc: a.desc, href: a.href.startsWith('/') ? base + a.href : a.href })),
  }));
  const schedule = admin ? await scheduleStatus().catch(() => null) : null;
  return NextResponse.json(
    { signed_in: !!account, username: account?.username ?? null, admin, groups, schedule, app: base },
    { headers: { ...cors(req), 'Cache-Control': 'no-store' } },
  );
}
