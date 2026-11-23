// GET ?symbol=EUR_USD&rate=M5[&limit=5000] -> { symbol, rate, source, bars: [{t, o, h, l, c, v}] }: the
// latest `limit` bars (at most 50 000) of the longest recorded series for the symbol at that rate.

import { type NextRequest, NextResponse } from 'next/server';
import { barsFor, RATE_RE, SYMBOL_RE } from '@/lib/warehouse';
import { requireWorkbenchUser } from '@/lib/workbench';

export async function GET(req: NextRequest) {
  const user = await requireWorkbenchUser(req);
  if (user instanceof NextResponse) return user;
  const symbol = (req.nextUrl.searchParams.get('symbol') || '').trim().toUpperCase();
  const rate = (req.nextUrl.searchParams.get('rate') || 'D').trim().toUpperCase();
  const limit = Math.max(1, Math.min(50_000, Number(req.nextUrl.searchParams.get('limit')) || 5000));
  if (!SYMBOL_RE.test(symbol) || !RATE_RE.test(rate)) return NextResponse.json({ error: 'Bad symbol or rate.' }, { status: 400 });
  const { source, bars } = await barsFor(symbol, rate, limit);
  if (!bars.length) return NextResponse.json({ error: `No ${rate} bars recorded for ${symbol}.` }, { status: 404 });
  return NextResponse.json({ symbol, rate, source, bars }, { headers: { 'Cache-Control': 'no-store' } });
}
