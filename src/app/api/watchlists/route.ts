// API: watchlists (portfolios): read, replace, and add or remove one instrument (Portfolio Maker).

import { type NextRequest, NextResponse } from 'next/server';
import { getWatchlists, upsertWatchlist, addInstrumentToWatchlist, removeInstrumentFromWatchlist } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = user.username;
  return NextResponse.json(await getWatchlists(username));
}

// POST — upsert a full watchlist (replace instrument list)
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const { watchlist_name, instrument_names, catalog_source, data_rate, tags } = body;
  const username = user.username;
  if (!watchlist_name) {
    return NextResponse.json({ error: 'watchlist_name required' }, { status: 400 });
  }
  const names = Array.isArray(instrument_names)
    ? instrument_names.join(',')
    : String(instrument_names ?? '');
  await upsertWatchlist({ username, watchlist_name, instrument_names: names, catalog_source, data_rate, tags });
  return NextResponse.json({ ok: true });
}

// PATCH — add or remove a single instrument from a named watchlist
// body: { username, watchlist_name, instrument_name, action: 'add' | 'remove' }
export async function PATCH(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const { watchlist_name, instrument_name, action } = body;
  const username = user.username;
  if (!watchlist_name || !instrument_name || !action) {
    return NextResponse.json({ error: 'watchlist_name, instrument_name, action required' }, { status: 400 });
  }
  if (action === 'add') {
    await addInstrumentToWatchlist(username, watchlist_name, instrument_name);
  } else if (action === 'remove') {
    await removeInstrumentFromWatchlist(username, watchlist_name, instrument_name);
  } else {
    return NextResponse.json({ error: 'action must be "add" or "remove"' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
