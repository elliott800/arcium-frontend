// API: the signed-in user's preferences (the workspace arrangement lives here).

import { type NextRequest, NextResponse } from 'next/server';
import { getUserPreferences, setUserPreferences } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = user.username;
  return NextResponse.json(await getUserPreferences(username));
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = user.username;
  const body = await req.json();
  const existing = await getUserPreferences(username);
  await setUserPreferences(username, { ...existing, ...body });
  return NextResponse.json({ ok: true });
}
