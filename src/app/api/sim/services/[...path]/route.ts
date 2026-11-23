// The simulated Services Hub's /v1 API (src/lib/sim-services.ts), for `npm run sim` only: src/proxy.ts rewrites
// /v1/... on the Services Hub and Arcade hosts here when the site runs on the simulated database. Anywhere else it
// answers 404, so the real site never serves it.

import { type NextRequest, NextResponse } from 'next/server';
import { isSimUrl } from '@/lib/sim-db';
import { handle, SimServicesError } from '@/lib/sim-services';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

async function answer(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!isSimUrl(process.env.DATABASE_URL)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (req.method === 'OPTIONS') return new NextResponse(null, { status: 204, headers: CORS });
  const path = '/' + (await params).path.join('/');
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  // The app's own address for "Sign in with Arcium": the same server, on localhost.
  const appOrigin = `${req.nextUrl.protocol}//localhost${req.nextUrl.port ? ':' + req.nextUrl.port : ''}`;
  try {
    const out = await handle(req.method, path, req.nextUrl.searchParams, body, req.headers.get('authorization'), appOrigin);
    if (out.csv != null) {
      return new NextResponse(out.csv, { status: 200, headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="predictions-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }
    return NextResponse.json(out.json, { status: out.status, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof SimServicesError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status, headers: CORS });
    console.error('[sim services]', e);
    return NextResponse.json({ error: 'Something went wrong on the server.' }, { status: 500, headers: CORS });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: NextRequest, ctx: Ctx) { return answer(req, ctx); }
export async function POST(req: NextRequest, ctx: Ctx) { return answer(req, ctx); }
export async function OPTIONS(req: NextRequest, ctx: Ctx) { return answer(req, ctx); }
