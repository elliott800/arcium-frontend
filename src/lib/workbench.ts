// The seed workbench (the arcium-signals package) reads bars from the Data Hub with an Arcium
// account: POST /api/workbench/login gives a token, sent as "Authorization: Bearer <token>".
// Read-only: it lists what is recorded and serves candle bars.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, type AccountUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export function bearerToken(req: NextRequest): string | undefined {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() || undefined : undefined;
}

/** The account behind the bearer token, or a 401 response to return as-is. */
export async function requireWorkbenchUser(req: NextRequest): Promise<AccountUser | NextResponse> {
  const user = await accountFromToken(bearerToken(req));
  if (!user) return NextResponse.json({ error: 'Sign in to the Data Hub first (arcium-signals login).' }, { status: 401 });
  return user;
}

export interface Recorded { symbol: string; source: string; rates: string[]; bars: number; first: string | null; last: string | null }

/** Every instrument with recorded candle bars: its source and the rates it has. */
export async function recordedInstruments(q = '', limit = 500): Promise<Recorded[]> {
  const rows = await getDb().prepare(`
    SELECT upper(COALESCE(h.params->>'instrument', h.params->>'ticker')) AS symbol, h.connection_name AS source,
           array_agg(DISTINCT h.params->>'data_rate') AS rates, SUM(s.n_rows)::bigint AS bars,
           MIN(s.first_ts) AS first, MAX(s.last_ts) AS last
    FROM wh_hooks h JOIN wh_series s ON s.hook_id = h.hook_id AND s.store = 'ohlcv' AND s.n_rows > 0
    WHERE h.key LIKE '%candles' AND upper(COALESCE(h.params->>'instrument', h.params->>'ticker')) LIKE ?
    GROUP BY 1, 2 ORDER BY 1, 2 LIMIT ${Math.max(1, Math.min(limit, 5000))}`).all(`%${q.toUpperCase()}%`) as
    { symbol: string; source: string; rates: string[]; bars: string | number; first: Date | null; last: Date | null }[];
  return rows.map(r => ({ symbol: r.symbol, source: r.source, rates: (r.rates || []).filter(Boolean).sort(),
    bars: Number(r.bars), first: r.first ? new Date(r.first).toISOString() : null, last: r.last ? new Date(r.last).toISOString() : null }));
}
