// The Data Hub's streams (every recorded series: one symbol, from one source, at one rate or kind), admin only.
//   GET ?q=AAPL          -> { streams: [...] } every stream whose symbol, series id or path matches
//   GET (no q)           -> { summary: [{ source, kind, streams, rows, fresh, stale, off }] } what is recorded, by source
// A stream is fresh when its last row is within 3 of its recording intervals (or a day for slow series).

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export interface StreamRow {
  series_id: number; store: string; part: string; field: string; rows: number; first: string | null; last: string | null;
  hook_id: string; source: string; key: string; symbol: string; rate: string | null; params: Record<string, unknown>;
  enabled: boolean; every: number; status: string | null; error: string | null; ran: string | null; path: string | null; fresh: boolean;
}

const SYMBOL_OF = `upper(coalesce(h.params->>'instrument', h.params->>'ticker', h.params->>'series_id', h.params->>'symbol', ''))`;
// fresh: the recorder ran the stream's job successfully within three of its intervals (slow monthly data stays fresh)
const FRESH = `(h.enabled AND h.last_status = 'ok' AND h.last_run_at > now() - make_interval(secs => GREATEST(h.interval_seconds * 3, 3600)))`;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const db = getDb();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 40);
  try {
    if (!q) {
      const summary = await db.prepare(`
        SELECT h.connection_name AS source, split_part(h.key, '.', array_length(string_to_array(h.key, '.'), 1)) AS kind,
               count(*)::int AS streams, coalesce(sum(s.n_rows), 0)::bigint AS rows,
               count(*) FILTER (WHERE h.enabled AND ${FRESH})::int AS fresh,
               count(*) FILTER (WHERE h.enabled AND NOT ${FRESH})::int AS stale,
               count(*) FILTER (WHERE NOT h.enabled)::int AS off,
               max(s.last_ts) AS last
        FROM wh_series s JOIN wh_hooks h USING (hook_id)
        GROUP BY 1, 2 ORDER BY 1, 2`).all();
      return NextResponse.json({ summary }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = await db.prepare(`
      SELECT s.series_id, s.store, s.part, s.field, s.n_rows AS rows, s.first_ts AS first, s.last_ts AS last,
             h.hook_id, h.connection_name AS source, h.key, ${SYMBOL_OF} AS symbol, h.params->>'data_rate' AS rate,
             h.params, h.enabled, h.interval_seconds AS every, h.last_status AS status, h.last_error AS error,
             h.last_run_at AS ran, h.data_path AS path, ${FRESH} AS fresh
      FROM wh_series s JOIN wh_hooks h USING (hook_id)
      WHERE ${SYMBOL_OF} = upper(?) OR ${SYMBOL_OF} LIKE upper(?) OR h.data_path ILIKE ?
      ORDER BY (${SYMBOL_OF} = upper(?)) DESC, ${SYMBOL_OF}, h.connection_name, h.key, s.part, s.field
      LIMIT 500`).all(q, like, like, q) as StreamRow[];
    return NextResponse.json({ streams: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: `The Data Hub tables can't be read here (${(e as Error).message.slice(0, 120)}).` }, { status: 503 });
  }
}
