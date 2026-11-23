// One stream's rows, newest first, as JSON (a preview) or CSV (a download, oldest first), admin only.
//   GET ?series_id=123&limit=200            -> { columns, rows }
//   GET ?series_id=123&format=csv&limit=N   -> text/csv (up to 200 000 rows)
// Times are UTC (ISO 8601).

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

const MAX_CSV = 200_000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const sp = req.nextUrl.searchParams;
  const id = Number(sp.get('series_id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'series_id required' }, { status: 400 });
  const csv = sp.get('format') === 'csv';
  const limit = Math.min(csv ? MAX_CSV : 1000, Math.max(1, Number(sp.get('limit')) || (csv ? MAX_CSV : 200)));
  const db = getDb();
  const s = await db.prepare(`SELECT s.series_id, s.store, s.part, s.hook_id FROM wh_series s WHERE s.series_id = ?`).get(id) as
    { series_id: number; store: string; part: string; hook_id: string } | undefined;
  if (!s) return NextResponse.json({ error: 'no such stream' }, { status: 404 });

  let columns: string[];
  let sql: string;
  let args: unknown[];
  if (s.store === 'ohlcv') {
    columns = ['time', 'open', 'high', 'low', 'close', 'volume'];
    sql = `SELECT ts AS time, open, high, low, close, volume FROM wh_ohlcv WHERE series_id = ? ORDER BY ts DESC LIMIT ${limit}`;
    args = [id];
  } else if (s.store === 'values') {
    columns = ['time', 'value'];
    sql = `SELECT ts AS time, value FROM wh_values WHERE series_id = ? ORDER BY ts DESC LIMIT ${limit}`;
    args = [id];
  } else if (s.store === 'options') {
    columns = ['time', 'expiry', 'side', 'strike', 'last', 'bid', 'ask', 'volume', 'open_interest', 'iv', 'spot'];
    sql = `SELECT ts AS time, expiry, side, strike, last, bid, ask, volume, open_interest, iv, spot FROM wh_options
           WHERE series_id = ? ORDER BY ts DESC, expiry, side, strike LIMIT ${limit}`;
    args = [id];
  } else {
    columns = ['time', 'index', 'data'];
    sql = `SELECT coalesce(idx_time, fetched_at) AS time, idx AS index, data FROM wh_records
           WHERE hook_id = ? AND part = ? ORDER BY coalesce(idx_time, fetched_at) DESC LIMIT ${limit}`;
    args = [s.hook_id, s.part];
  }
  const rows = await db.prepare(sql).all(...args) as Record<string, unknown>[];
  if (!csv) return NextResponse.json({ store: s.store, columns, rows }, { headers: { 'Cache-Control': 'no-store' } });
  const body = [columns.join(','), ...rows.reverse().map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n');
  const name = `${s.hook_id}${s.part ? `.${s.part}` : ''}`.replace(/[^\w.-]+/g, '_');
  return new NextResponse(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' } });
}
