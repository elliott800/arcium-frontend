// HTTP plumbing for /api/hubs/...: the hub pages call these from their own origins with the
// Arcium session cookie, so responses carry CORS headers for those origins only, and every
// change (non-GET) must come from one of them or from this app itself.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from './auth';
import { hubOrigins, isHubId, type HubId } from './hub-origins';
import { HubError, getRepo, type Repo, type Viewer } from './hubs';
import { isDemo } from './site-mode';

const allowed = () => hubOrigins(process.env.HUB_EXTRA_ORIGINS ?? '', process.env.NODE_ENV === 'production');

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowed().includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export const preflight = (req: NextRequest) => new NextResponse(null, { status: 204, headers: corsHeaders(req) });

export function json(req: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(req), 'Cache-Control': 'no-store' } });
}

/** Runs a hub API handler: checks the origin of changes, turns HubErrors into JSON errors. */
export async function handle(req: NextRequest, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  if (isDemo) return json(req, { error: 'The hubs run on the live site.' }, 404);
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== req.nextUrl.origin && !allowed().includes(origin)) return json(req, { error: 'Not allowed from this site.' }, 403);
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HubError) return json(req, { error: err.message }, err.status);
    console.error('hub api:', err);
    return json(req, { error: 'Something went wrong.' }, 500);
  }
}

export async function viewerOf(req: NextRequest): Promise<Viewer | null> {
  const a = await accountFromToken(sessionToken(req));
  return a ? { username: a.username, admin: a.role === 'admin' } : null;
}

export async function requireViewer(req: NextRequest): Promise<Viewer> {
  const v = await viewerOf(req);
  if (!v) throw new HubError('Sign in with your Arcium account first.', 401);
  return v;
}

export function hubParam(hub: string): HubId {
  if (!isHubId(hub)) throw new HubError('No such hub.', 404);
  return hub;
}

/** The repo named in the URL, or 404 when it does not exist or this viewer may not see it. */
export async function repoParam(hub: string, owner: string, name: string, see: (r: Repo) => boolean): Promise<Repo> {
  const r = await getRepo(hubParam(hub), owner, name);
  if (!r || !see(r)) throw new HubError('No such repo.', 404);
  return r;
}
