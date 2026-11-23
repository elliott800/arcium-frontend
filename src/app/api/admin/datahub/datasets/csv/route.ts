// Download one dataset for one symbol as CSV. Admin only, read only.
// GET /api/admin/datahub/datasets/csv?symbol=MSFT&dataset=fundamentals
// Only 'fundamentals' (the SEC facts as recorded) is stored as rows today; the others are computed in the Data Hub.

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { SYMBOL_RE } from '@/lib/warehouse';
import { factsCsv, type FactRow } from '@/lib/datahubDatasets';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const dataset = req.nextUrl.searchParams.get('dataset') ?? '';
  if (!SYMBOL_RE.test(symbol)) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  if (dataset !== 'fundamentals') return NextResponse.json({ error: `no download for ${dataset || 'that dataset'} yet` }, { status: 404 });
  const rows = await getDb().prepare(`
    SELECT s.part AS concept, v.ts AS available, v.value
    FROM wh_values v
    JOIN wh_series s ON s.series_id = v.series_id
    JOIN wh_hooks h ON h.hook_id = s.hook_id
    WHERE h.key = 'facts' AND s.field = 'value' AND upper(h.params->>'ticker') = ?
    ORDER BY s.part, v.ts`).all(symbol) as { concept: string; available: string | Date; value: number | null }[];
  const facts: FactRow[] = rows.map(r => ({
    concept: r.concept, available: new Date(r.available).toISOString().slice(0, 10), value: r.value == null ? null : Number(r.value),
  }));
  return new NextResponse(factsCsv(facts), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${symbol}-fundamentals.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
