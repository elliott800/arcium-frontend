// GET -> { lists: [{ id, name, kind, symbols, category?, tags? }] }: what the Compare view can load:
// your watchlists, your engines' current portfolios (instruments by weight), and the Data Hub's
// lists (a watchlist per fund, ETF collections, the Discord forum assets) with their category and tags.

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb, getWatchlists } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const wl = (await getWatchlists(user.username)) as { watchlist_name: string; instrument_names: string }[];
  const lists: { id: string; name: string; kind: string; symbols: string[]; category?: string | null; tags?: string[] }[] =
    wl.map(w => ({ id: `wl:${w.watchlist_name}`, name: w.watchlist_name, kind: 'Watchlist',
      symbols: w.instrument_names.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) }));
  const allocs = await getDb().prepare(`
    SELECT trader_name, silo_name, instrument_name, tot_weight FROM web_portfolio_allocs
    WHERE username = ? ORDER BY trader_name, silo_name, tot_weight DESC NULLS LAST`).all(user.username) as
    { trader_name: string; silo_name: string; instrument_name: string }[];
  const byPortfolio = new Map<string, string[]>();
  for (const a of allocs) {
    const k = `${a.trader_name} · ${a.silo_name}`;
    byPortfolio.set(k, [...(byPortfolio.get(k) ?? []), a.instrument_name.toUpperCase()]);
  }
  for (const [name, symbols] of byPortfolio) lists.push({ id: `pf:${name}`, name, kind: 'Portfolio', symbols: [...new Set(symbols)] });
  try {   // the Data Hub's lists live in the same database (wh_lists); absent until the hub has made them
    const hub = await getDb().prepare(`
      SELECT l.name, l.kind, l.category, l.tags, array_remove(array_agg(m.member ORDER BY m.member), NULL) AS members
      FROM wh_lists l LEFT JOIN wh_list_members m ON m.list_name = l.name
      GROUP BY l.name, l.kind, l.category, l.tags ORDER BY l.kind, l.name`).all() as
      { name: string; kind: string; category: string | null; tags: string[]; members: string[] }[];
    const KIND: Record<string, string> = { fund: 'Fund', collection: 'Collection', discord: 'Discord', manual: 'Hub list' };
    for (const h of hub) lists.push({ id: `hub:${h.name}`, name: h.name, kind: KIND[h.kind] ?? 'Hub list',
      symbols: h.members.map(s => s.toUpperCase()), category: h.category, tags: h.tags });
  } catch {}
  return NextResponse.json({ lists }, { headers: { 'Cache-Control': 'no-store' } });
}
