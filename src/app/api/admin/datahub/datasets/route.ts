// What each Data Hub dataset holds for one symbol. Admin only, read only.
// GET /api/admin/datahub/datasets?symbol=MSFT  -> { symbol, datasets: [...] }

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { SYMBOL_RE } from '@/lib/warehouse';
import { summarizeDatasets, type DatasetCounts } from '@/lib/datahubDatasets';

const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null);

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  const db = getDb();
  const sec = await db.prepare(`
    SELECT count(DISTINCT s.part) AS concepts, count(*) AS n, min(v.ts) AS first, max(v.ts) AS last
    FROM wh_values v
    JOIN wh_series s ON s.series_id = v.series_id
    JOIN wh_hooks h ON h.hook_id = s.hook_id
    WHERE h.key = 'facts' AND s.field = 'value' AND upper(h.params->>'ticker') = ?`).get(symbol) as
    { concepts: number; n: number; first: string | null; last: string | null } | undefined;
  const count = async (sql: string) => Number(((await db.prepare(sql).get(symbol)) as { n?: number } | undefined)?.n ?? 0);
  const counts: DatasetCounts = {
    secConcepts: Number(sec?.concepts ?? 0),
    secRows: Number(sec?.n ?? 0),
    secFirst: day(sec?.first),
    secLast: day(sec?.last),
    yahooRows: await count(`SELECT count(*) AS n FROM wh_series_values WHERE key = 'stocks.fundamentals' AND upper(params->>'ticker') = ?`),
    valuationRows: await count(`SELECT count(*) AS n FROM wh_series_values WHERE key = 'stocks.valuation' AND upper(params->>'ticker') = ?`),
    estimateRows: await count(`SELECT count(*) AS n FROM wh_series_values WHERE (key ILIKE '%estimate%' OR key ILIKE '%earnings%') AND upper(params->>'ticker') = ?`),
    filingRows: await count(`SELECT coalesce(sum(s.n_rows), 0) AS n FROM wh_series s JOIN wh_hooks h ON h.hook_id = s.hook_id
      WHERE h.key = 'filings' AND upper(h.params->>'ticker') = ?`),
  };
  return NextResponse.json({ symbol, datasets: summarizeDatasets(counts) }, { headers: { 'Cache-Control': 'no-store' } });
}
