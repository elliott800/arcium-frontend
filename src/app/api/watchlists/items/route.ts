// The Watchlist Maker's lists (the signed-in user's own):
//   GET                                   -> { watchlists: [{ watchlist_name, instruments[], catalog_source, data_rate, tags }] }
//   POST { watchlist_name, add?, remove?, create? }  add: symbols (array) or a pasted list (string)
//                                         -> { watchlist } after the change; only the instruments change
//   POST also takes add_members / remove_members: arrays of 'list:Name' (another of your lists, making this one a
//                                         collection; 'list:hub:Name' a Data Hub list, admins), 'source:kind:id' or
//                                         'kind:id' (a source: fred:UNRATE, catalog:yahoo.etfs), or plain symbols
//   PUT { from, to }                      rename
//   DELETE ?name=                         delete

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { deleteWatchlist, editWatchlist, listWatchlists, parseBatch, renameWatchlist, validName } from '@/lib/watchlists';
import { parseMember, sublistKey, wouldCycle, type Member } from '@/lib/watchlist-logic';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ watchlists: await listWatchlists(user.username) }, { headers: { 'Cache-Control': 'no-store' } });
}

const symbolsOf = (v: unknown) => parseBatch(Array.isArray(v) ? v.map(String).join(',') : String(v ?? '')).symbols;
/** Members from an array of written members; null if any can't be read (list names may hold spaces, so no splitting). */
const membersOf = (v: unknown): Member[] | null => {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out: Member[] = [];
  for (const raw of v) { const m = parseMember(String(raw)); if (!m) return null; out.push(m); }
  return out;
};

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const name = String(body.watchlist_name ?? '').trim();
  if (!validName(name)) return NextResponse.json({ error: 'A watchlist name: letters, numbers, spaces and . - & ( ) / + (up to 60).' }, { status: 400 });
  const add = symbolsOf(body.add);
  const remove = symbolsOf(body.remove);
  const addMembers = membersOf(body.add_members);
  const removeMembers = membersOf(body.remove_members);
  if (addMembers === null || removeMembers === null) return NextResponse.json({ error: 'Members are list:Name, a source such as fred:UNRATE or catalog:yahoo.etfs, or symbols.' }, { status: 400 });
  for (const m of [...addMembers, ...removeMembers]) if (m.type === 'symbol') (addMembers.includes(m) ? add : remove).push(...symbolsOf([m.value]));
  if (add.length + remove.length + addMembers.length + removeMembers.length > 2000) return NextResponse.json({ error: 'Too many instruments in one change.' }, { status: 400 });
  const newLists = addMembers.filter(m => m.type === 'list');
  if (newLists.length) {
    const mine = await listWatchlists(user.username);
    const graph = new Map(mine.map(l => [`mine:${l.watchlist_name}`, { symbols: [], sublists: l.sublists }]));
    for (const m of newLists) {
      const key = sublistKey('mine', m.value);
      if (key.startsWith('hub:')) {
        if (user.role !== 'admin') return NextResponse.json({ error: 'Only admins can put a Data Hub list in a collection.' }, { status: 403 });
        continue;                                   // a Data Hub list never holds a person's list: no cycle possible
      }
      if (!graph.has(key)) return NextResponse.json({ error: `No watchlist named "${m.value}".` }, { status: 404 });
      if (wouldCycle(`mine:${name}`, key, k => graph.get(k), (_p, ref) => sublistKey('mine', ref))) {
        return NextResponse.json({ error: `"${m.value}" already holds "${name}", so it can't go inside it.` }, { status: 400 });
      }
    }
  }
  const watchlist = await editWatchlist(user.username, name, add, remove, !!body.create, addMembers, removeMembers);
  if (!watchlist) return NextResponse.json({ error: `No watchlist named "${name}".` }, { status: 404 });
  return NextResponse.json({ ok: true, watchlist, added: add.length, removed: remove.length });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const from = String(body.from ?? '').trim();
  const to = String(body.to ?? '').trim();
  if (!validName(from) || !validName(to)) return NextResponse.json({ error: 'Both names are needed.' }, { status: 400 });
  const r = await renameWatchlist(user.username, from, to);
  if (r === 'missing') return NextResponse.json({ error: `No watchlist named "${from}".` }, { status: 404 });
  if (r === 'exists') return NextResponse.json({ error: `A watchlist named "${to}" already exists.` }, { status: 409 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const name = (req.nextUrl.searchParams.get('name') ?? '').trim();
  if (!validName(name)) return NextResponse.json({ error: 'name required' }, { status: 400 });
  return (await deleteWatchlist(user.username, name))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No watchlist named "${name}".` }, { status: 404 });
}
