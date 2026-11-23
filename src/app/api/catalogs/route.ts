// API: the model catalogs this user may read (Factory > Model catalog).

import { type NextRequest, NextResponse } from 'next/server';
import { getCatalogSources, getCatalogSignals, getAllCatalogSignals, getCatalogTableRows, getCatalogMissingStatsCount } from '@/lib/db';
import { requireUser, scopedUsername } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = scopedUsername(user, req.nextUrl.searchParams.get('username'));
  const source = req.nextUrl.searchParams.get('source');
  const table = req.nextUrl.searchParams.get('table');
  const isAdmin = user.role === 'admin';
  if (req.nextUrl.searchParams.has('missing')) return NextResponse.json({ count: await getCatalogMissingStatsCount(username, source ?? undefined) });
  if (table) return NextResponse.json(await getCatalogTableRows(username, table, source, isAdmin));
  if (source) return NextResponse.json(await getCatalogSignals(username, source));
  if (req.nextUrl.searchParams.has('all')) return NextResponse.json(await getAllCatalogSignals(username));
  return NextResponse.json(await getCatalogSources(username, isAdmin));
}
