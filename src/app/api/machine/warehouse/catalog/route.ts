// GET ?connection=fred&key=series&match=UNRATE&limit=500
//   -> { hooks: [{ hook_id, connection, key, params, enabled, series: [{ series_id, part, field, store, first, last, rows }] }] }
// What the Data Hub records, for the other projects (machine key: X-Machine-Name / X-Machine-Key). Every filter
// is optional; `match` finds any recording with that parameter value (a ticker, FRED id, pair or fund).

import { type NextRequest, NextResponse } from 'next/server';
import { authenticateMachine } from '@/lib/machine-auth';
import { catalog, validName } from '@/lib/warehouseRead';

export async function GET(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const connection = (q.get('connection') || '').trim();
  const key = (q.get('key') || '').trim();
  const match = (q.get('match') || '').trim();
  for (const v of [connection, key, match]) if (v && !validName(v)) return NextResponse.json({ error: 'Bad filter.' }, { status: 400 });
  const hooks = await catalog({ connection: connection || undefined, key: key || undefined, match: match || undefined,
    limit: Number(q.get('limit')) || 500 });
  return NextResponse.json({ hooks }, { headers: { 'Cache-Control': 'no-store' } });
}
