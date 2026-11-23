// GET ?series_id=123[&from=2020-01-01][&to=...][&limit=5000]
//   -> { series_id, hook_id, part, field, store, rows: [...], truncated }
// One stored series from the Data Hub (find ids with ./catalog), machine key required. Rows are in time order:
// the range when given, else the latest `limit` (at most 50 000). Option chains without a range return the
// latest snapshot. See src/lib/warehouseRead.ts for the row shape of each store.

import { type NextRequest, NextResponse } from 'next/server';
import { authenticateMachine } from '@/lib/machine-auth';
import { readSeries } from '@/lib/warehouseRead';

export async function GET(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const id = Number(q.get('series_id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'series_id is required.' }, { status: 400 });
  const day = (v: string | null) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = day(q.get('from')), to = day(q.get('to'));
  if (from === null || to === null) return NextResponse.json({ error: 'Bad from or to date.' }, { status: 400 });
  const out = await readSeries(id, { from, to, limit: Number(q.get('limit')) || 5000 });
  if (!out) return NextResponse.json({ error: `No series ${id}.` }, { status: 404 });
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
