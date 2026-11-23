// Datahub at a glance for the control panel: hooks per connection, the stock watchlist,
// fund holdings, storage and recent source errors. Reads the hub tables (same database);
// commands go to the source manager through wh_process_control.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

const COMMANDS = new Set(['watchlist_add', 'watchlist_remove', 'watchlist_pass']);

async function safe<T>(q: () => Promise<T>, fallback: T): Promise<T> {
  try { return await q(); } catch { return fallback; }
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const db = getDb();
  const [connections, watchlist, watchTotal, funds, errors, size] = await Promise.all([
    safe(() => db.prepare(`
      SELECT connection_name AS connection, count(*)::int AS hooks,
             count(*) FILTER (WHERE last_status = 'ok')::int AS ok,
             count(*) FILTER (WHERE last_status IS NOT NULL AND last_status <> 'ok')::int AS failing,
             count(*) FILTER (WHERE last_run_at IS NULL)::int AS waiting,
             max(last_run_at) AS last_run
      FROM wh_hooks GROUP BY 1 ORDER BY 1`).all(), []),
    safe(() => db.prepare(`SELECT stage, count(*)::int AS n, max(note) AS note FROM wh_watchlist GROUP BY 1 ORDER BY 1`).all(), []),
    safe(() => db.prepare(`SELECT count(*)::int AS n FROM wh_watchlist`).get(), { n: 0 }),
    safe(() => db.prepare(`
      SELECT h.params->>'fund' AS fund, h.key, h.last_status AS status, h.last_run_at AS updated,
             -- the fund's members on the watchlist (last_rows only counts rows a run added)
             (SELECT count(*)::int FROM wh_watchlist w WHERE ('fund:' || (h.params->>'fund')) = ANY(w.sources)) AS holdings
      FROM wh_hooks h WHERE h.connection_name = 'holdings' ORDER BY 1`).all(), []),
    safe(() => db.prepare(`
      SELECT at, connection_name AS connection, hook_id, stage, left(problem, 200) AS problem
      FROM wh_source_errors ORDER BY at DESC LIMIT 8`).all(), []),
    safe(() => db.prepare(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`).get(), { size: null }),
  ]);
  return NextResponse.json({ connections, watchlist, watchlist_total: (watchTotal as { n: number }).n, funds, errors,
                             database_size: (size as { size: string | null }).size });
}

// body: { command: 'watchlist_add' | 'watchlist_remove' | 'watchlist_pass', symbols?: string[] }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { command, symbols } = await req.json().catch(() => ({}));
  if (!COMMANDS.has(command)) return NextResponse.json({ error: 'unknown command' }, { status: 400 });
  const clean = Array.isArray(symbols)
    ? symbols.map((s: unknown) => String(s).trim().toUpperCase()).filter(s => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)).slice(0, 500)
    : [];
  if (command !== 'watchlist_pass' && !clean.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });
  const db = getDb();
  const proc = await db.prepare(`SELECT machine_name FROM wh_process_state WHERE process_name = 'source_manager'
                                 ORDER BY last_tick_at DESC NULLS LAST LIMIT 1`).get() as { machine_name: string } | undefined;
  if (!proc) return NextResponse.json({ error: 'the source manager is not running' }, { status: 503 });
  const row = await db.prepare(`
    INSERT INTO wh_process_control (machine_name, process_name, command, args, requested_by)
    VALUES (?, 'source_manager', ?, ?::jsonb, ?) RETURNING id
  `).get(proc.machine_name, command, JSON.stringify({ symbols: clean, by: admin.username }), admin.email) as { id: number };
  return NextResponse.json({ ok: true, control_id: row.id, symbols: clean.length });
}
