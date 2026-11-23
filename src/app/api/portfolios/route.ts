// Every portfolio, in one object shape, whether the site keeps it (scope 'mine', a person's own lists) or the Data
// Hub does (scope 'hub', its recording lists; admins only). The shape is the same for both:
//   { id, name, scope, kind, category, tags, symbols, sources, record, sublists }
// A list holds assets (symbols), sources (fred:UNRATE, catalog:yahoo.etfs) and other lists (sublists: then it is a
// collection). A person's list names its own lists by name and a Data Hub list as 'hub:Name'.
// GET ?scope=mine|hub|all  -> { portfolios: [...] }
// GET ?open=<id>           -> { portfolio, lists, missing, cycles }: a collection opened as one universe, the union
//                             of its symbols and sources and every list under it (cycles skipped), in the same shape
// Writing still goes through each store's own endpoint (/api/watchlists/items, /api/admin/datahub/lists) until the
// two stores share one table.

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin, requireUser } from '@/lib/auth';
import { listWatchlists } from '@/lib/watchlists';
import { flattenCollection, sublistKey } from '@/lib/watchlist-logic';

export interface Portfolio {
  id: string;
  name: string;
  scope: 'mine' | 'hub';
  kind: string;                 // 'manual' or 'collection' for a person's list; the Data Hub's kind otherwise (fund, collection, manual, tracker)
  category: string | null;      // the asset class (Stocks, Commodities, ...), or null
  tags: string[];
  symbols: string[];
  sources: string[];            // non-asset members: kind:id (fred:UNRATE, catalog:yahoo.etfs)
  record: boolean;              // mine: always false (the site doesn't record); hub: whether the hub records it
  sublists: string[];           // the lists it contains
}

async function minePortfolios(username: string): Promise<Portfolio[]> {
  const lists = await listWatchlists(username);
  return lists.filter(l => l.watchlist_name !== 'favorites').map(l => ({
    id: `mine:${l.watchlist_name}`, name: l.watchlist_name, scope: 'mine' as const, kind: l.sublists.length ? 'collection' : 'manual',
    category: null, tags: [], symbols: l.instruments, sources: l.sources, record: false, sublists: l.sublists,
  }));
}

async function hubPortfolios(): Promise<Portfolio[]> {
  try {
    const rows = await getDb().prepare(`
      SELECT l.name, l.kind, l.category, l.tags, l.record,
             COALESCE(array_agg(upper(m.member) ORDER BY m.added_at, m.member) FILTER (WHERE m.member_type = 'symbol'), '{}') AS members,
             COALESCE(array_agg(m.member ORDER BY m.member) FILTER (WHERE m.member_type = 'list'), '{}') AS sublists,
             COALESCE(array_agg(m.member ORDER BY m.member) FILTER (WHERE m.member_type = 'source'), '{}') AS sources
      FROM wh_lists l LEFT JOIN wh_list_members m ON m.list_name = l.name
      GROUP BY l.name, l.kind, l.category, l.tags, l.record ORDER BY l.kind, l.name`).all() as
      { name: string; kind: string; category: string | null; tags: string[]; record: boolean; members: string[]; sublists: string[]; sources: string[] }[];
    return rows.map(r => ({
      id: `hub:${r.name}`, name: r.name, scope: 'hub' as const, kind: r.kind, category: r.category, tags: r.tags ?? [],
      symbols: r.members ?? [], sources: r.sources ?? [], record: !!r.record, sublists: r.sublists ?? [],
    }));
  } catch {
    return [];                  // the Data Hub has no lists table yet
  }
}

/** A portfolio opened as one universe: itself and every list under it, flattened. */
function openPortfolio(id: string, all: Portfolio[]) {
  const byId = new Map(all.map(p => [p.id, p]));
  const root = byId.get(id);
  if (!root) return null;
  const u = flattenCollection(id, k => byId.get(k), (parent, ref) => sublistKey(parent.startsWith('hub:') ? 'hub' : 'mine', ref));
  const portfolio: Portfolio = { ...root, kind: root.sublists.length ? 'collection' : root.kind, symbols: u.symbols, sources: u.sources };
  return { portfolio, lists: u.lists, missing: u.missing, cycles: u.cycles };
}

const noStore = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: NextRequest) {
  const open = req.nextUrl.searchParams.get('open');
  if (open) {
    const user = await requireUser(req);
    if (user instanceof NextResponse) return user;
    const all = [...await minePortfolios(user.username), ...(user.role === 'admin' ? await hubPortfolios() : [])];
    const r = openPortfolio(open, all);
    if (!r) return NextResponse.json({ error: `No portfolio "${open}".` }, { status: 404 });
    return NextResponse.json(r, noStore);
  }
  const scope = req.nextUrl.searchParams.get('scope') ?? 'mine';
  if (scope === 'hub') {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    return NextResponse.json({ portfolios: await hubPortfolios() }, noStore);
  }
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const mine = await minePortfolios(user.username);
  if (scope === 'mine') return NextResponse.json({ portfolios: mine }, noStore);
  if (user.role !== 'admin') return NextResponse.json({ portfolios: mine }, noStore);
  return NextResponse.json({ portfolios: [...mine, ...(await hubPortfolios())] }, noStore);
}
