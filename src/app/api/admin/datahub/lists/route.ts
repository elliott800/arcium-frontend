// The Data Hub's portfolios (its lists: fund holdings, collections, trackers, the Discord hub's watchlist, manual lists) for the portfolio
// maker, admin only. Reads the hub tables (same database); changes go to the hub's source manager as its own
// list commands through wh_process_control, so the hub stays the one writer of its tables.
//   GET  -> { lists: [{ name, kind, category, tags, record, members: [symbol] }], running: bool }
//   POST { command: 'list_create' | 'list_add' | 'list_remove' | 'list_edit', name, symbols?, category?, tags?, record? }
//        -> { ok, control_id }

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { parseBatch } from '@/lib/watchlists';
import { clearTreeCache } from '@/lib/datahubTree';

const COMMANDS = new Set(['list_create', 'list_add', 'list_remove', 'list_edit']);
const NAME_RE = /^[\w .:\-&()/+#]{1,80}$/;
const CATEGORIES = new Set(['Stocks', 'Commodities', 'Currencies', 'Real estate', 'Bonds', 'Crypto']);

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const db = getDb();
  try {
    const lists = await db.prepare(`
      SELECT l.name, l.kind, l.category, l.tags, l.record,
             COALESCE(array_agg(upper(m.member) ORDER BY m.added_at, m.member) FILTER (WHERE m.member_type = 'symbol'), '{}') AS members,
             COALESCE(array_agg(m.member ORDER BY m.member) FILTER (WHERE m.member_type = 'list'), '{}') AS sublists
      FROM wh_lists l LEFT JOIN wh_list_members m ON m.list_name = l.name
      GROUP BY l.name, l.kind, l.category, l.tags, l.record ORDER BY l.kind, l.name`).all();
    const proc = await db.prepare(`SELECT 1 FROM wh_process_state WHERE process_name = 'source_manager'
                                   AND last_tick_at > now() - interval '5 minutes' LIMIT 1`).get().catch(() => undefined);
    return NextResponse.json({ lists, running: !!proc }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ lists: [], running: false, note: 'The Data Hub has no lists yet.' });
  }
}

export async function POST(req: NextRequest) {
  clearTreeCache();   // anything changed shows on the next load
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({}));
  const command = String(body.command ?? '');
  const name = String(body.name ?? '').trim();
  if (!COMMANDS.has(command)) return NextResponse.json({ error: 'unknown command' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ error: 'A portfolio name is needed (up to 80 characters).' }, { status: 400 });
  const args: Record<string, unknown> = { name, by: admin.username };
  if (command !== 'list_edit') {
    const symbols = parseBatch(Array.isArray(body.symbols) ? body.symbols.map(String).join(',') : String(body.symbols ?? '')).symbols;
    if (command !== 'list_create' && !symbols.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });
    if (symbols.length > 2000) return NextResponse.json({ error: 'Too many symbols in one change.' }, { status: 400 });
    args.symbols = symbols;
  }
  if (command === 'list_create' || command === 'list_edit') {
    if (body.category != null) {
      if (!CATEGORIES.has(String(body.category))) return NextResponse.json({ error: `category must be one of ${[...CATEGORIES].join(', ')}` }, { status: 400 });
      args.category = String(body.category);
    }
    if (Array.isArray(body.tags)) args.tags = body.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    if (typeof body.record === 'boolean') args.record = body.record;
    if (command === 'list_create') args.kind = 'manual';
  }
  const db = getDb();
  const proc = await db.prepare(`SELECT machine_name FROM wh_process_state WHERE process_name = 'source_manager'
                                 ORDER BY last_tick_at DESC NULLS LAST LIMIT 1`).get() as { machine_name: string } | undefined;
  if (!proc) return NextResponse.json({ error: 'The Data Hub source manager is not running.' }, { status: 503 });
  const row = await db.prepare(`
    INSERT INTO wh_process_control (machine_name, process_name, command, args, requested_by)
    VALUES (?, 'source_manager', ?, ?::jsonb, ?) RETURNING id
  `).get(proc.machine_name, command, JSON.stringify(args), admin.email) as { id: number };
  return NextResponse.json({ ok: true, control_id: row.id });
}
