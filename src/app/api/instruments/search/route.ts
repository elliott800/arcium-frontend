// GET ?q=EUR&limit=50 -> { instruments: [{ symbol, sources, rates, bars }] }: the Watchlist Maker's search,
// across the Data Hub's recorded instruments, the cluster data and the Data Hub's lists.

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { searchInstruments } from '@/lib/watchlists';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const q = (req.nextUrl.searchParams.get('q') || '').slice(0, 40);
  if (!q.trim()) return NextResponse.json({ instruments: [] });
  const limit = Number(req.nextUrl.searchParams.get('limit')) || 50;
  return NextResponse.json({ instruments: await searchInstruments(q, limit) }, { headers: { 'Cache-Control': 'no-store' } });
}
