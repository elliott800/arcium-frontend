// GET [?q=EUR] -> { instruments: [{ symbol, source, rates, bars, first, last }] }: what the Data Hub records.

import { type NextRequest, NextResponse } from 'next/server';
import { recordedInstruments, requireWorkbenchUser } from '@/lib/workbench';

export async function GET(req: NextRequest) {
  const user = await requireWorkbenchUser(req);
  if (user instanceof NextResponse) return user;
  const q = (req.nextUrl.searchParams.get('q') || '').trim().slice(0, 20).replace(/[%_]/g, '');
  return NextResponse.json({ instruments: await recordedInstruments(q) }, { headers: { 'Cache-Control': 'no-store' } });
}
