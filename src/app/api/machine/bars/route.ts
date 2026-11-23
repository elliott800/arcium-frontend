// GET ?symbol=AAPL&rate=M1[&limit=5000] -> { symbol, rate, source, bars: [{t, o, h, l, c, v}] }
// Data Hub bars for an engine (the seed's hub source: hub_source_api.py), authenticated with the machine's
// key (X-Machine-Name / X-Machine-Key headers): the latest `limit` bars (at most 50 000) of the recording, most current
// recorded series for the symbol at that rate. Read-only.

import { type NextRequest, NextResponse } from 'next/server';
import { authenticateMachine } from '@/lib/machine-auth';
import { barsFor, RATE_RE, SYMBOL_RE } from '@/lib/warehouse';

export async function GET(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const symbol = (q.get('symbol') || '').trim().toUpperCase();
  const rate = (q.get('rate') || 'D').trim().toUpperCase();
  const limit = Math.max(1, Math.min(50_000, Number(q.get('limit')) || 5000));
  if (!SYMBOL_RE.test(symbol) || !RATE_RE.test(rate)) return NextResponse.json({ error: 'Bad symbol or rate.' }, { status: 400 });
  const { source, bars } = await barsFor(symbol, rate, limit);
  if (!bars.length) return NextResponse.json({ error: `No ${rate} bars recorded for ${symbol}.` }, { status: 404 });
  return NextResponse.json({ symbol, rate, source, bars }, { headers: { 'Cache-Control': 'no-store' } });
}
