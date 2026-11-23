// Saved watchlist filters: must-have and can't-have tag lists, stored per person under a name.
//   GET                 -> { filters: [{ name, must[], not[] }] }
//   GET ?name=          -> { filter }  (load one by name, any case)
//   POST { name, must, not }  save (a filter of the same name is replaced) -> { filter }
//   DELETE ?name=       delete

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { deleteFilter, getFilter, listFilters, saveFilter } from '@/lib/watchlists';
import { normalizeFilter, validFilterName } from '@/lib/watchlist-logic';

const NAME_ERROR = 'A filter name: letters, numbers, spaces and . - & ( ) / + (up to 60).';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const name = req.nextUrl.searchParams.get('name');
  if (name != null) {
    if (!validFilterName(name)) return NextResponse.json({ error: NAME_ERROR }, { status: 400 });
    const filter = await getFilter(user.username, name);
    return filter
      ? NextResponse.json({ filter }, { headers: { 'Cache-Control': 'no-store' } })
      : NextResponse.json({ error: `No filter named "${name}".` }, { status: 404 });
  }
  return NextResponse.json({ filters: await listFilters(user.username) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  if (!validFilterName(name)) return NextResponse.json({ error: NAME_ERROR }, { status: 400 });
  const f = normalizeFilter(body);
  if (!f) return NextResponse.json({ error: 'Too many tags in one filter (30 at most).' }, { status: 400 });
  if (!f.must.length && !f.not.length) return NextResponse.json({ error: 'Choose at least one must-have or can\'t-have tag first.' }, { status: 400 });
  return NextResponse.json({ ok: true, filter: await saveFilter(user.username, { name, ...f }) });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const name = (req.nextUrl.searchParams.get('name') ?? '').trim();
  if (!validFilterName(name)) return NextResponse.json({ error: 'name required' }, { status: 400 });
  return (await deleteFilter(user.username, name))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No filter named "${name}".` }, { status: 404 });
}
