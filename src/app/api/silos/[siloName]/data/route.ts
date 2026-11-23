// API: one silo's engine data (NAV, portfolio, equity curve; a lean equity-only mode for cards).

import { type NextRequest, NextResponse } from 'next/server';
import { getSiloNavData, getSiloPortfolioData, getEquityCurve, getPortfolioAllocs } from '@/lib/db';
import { requireUser, scopedUsername } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET ?engineKind=simulated|live                  -> { nav, portfolio, equityCurve, portfolioAllocs }  (everything)
// GET ?engineKind=...&only=equity&points=N         -> { equityCurve }  (N evenly spaced points, the last one kept):
//     what a sparkline needs. The full answer is ~4 MB for a long-running engine; this is a few KB.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ siloName: string }> }
) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const { siloName } = await params;
  const sp = req.nextUrl.searchParams;
  const username   = scopedUsername(user, sp.get('username'));
  const engineKind = sp.get('engineKind') ?? 'simulated';

  if (sp.get('only') === 'equity') {
    const points = Math.min(5000, Math.max(2, Number(sp.get('points')) || 300));
    const curve = await getEquityCurve(username, siloName, engineKind) as unknown[];
    return NextResponse.json({ equityCurve: thin(curve, points), total: curve.length });
  }

  const [nav, portfolio, equityCurve, portfolioAllocs] = await Promise.all([
    getSiloNavData(username, siloName, engineKind),
    getSiloPortfolioData(username, siloName, engineKind),
    getEquityCurve(username, siloName, engineKind),
    getPortfolioAllocs(username, siloName, engineKind),
  ]);

  return NextResponse.json({ nav, portfolio, equityCurve, portfolioAllocs });
}

/** n evenly spaced rows, always including the first and the last. */
function thin<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (n - 1))]);
  return out;
}
