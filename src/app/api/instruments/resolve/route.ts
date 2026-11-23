// POST { text } -> { found: [{ symbol, sources, rates }], unknown: [symbol], rejected: [piece] }:
// a pasted list read into symbols and checked against what the site knows, before a batch add.

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { parseBatch, resolveSymbols } from '@/lib/watchlists';

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '').slice(0, 20000);
  const { symbols, rejected } = parseBatch(text);
  if (symbols.length > 1000) return NextResponse.json({ error: 'At most 1000 instruments at a time.' }, { status: 400 });
  const { found, unknown } = await resolveSymbols(symbols);
  return NextResponse.json({ found, unknown, rejected });
}
