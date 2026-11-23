// GET: this account's saved keys. DELETE { id }: remove one of them.

import { type NextRequest, NextResponse } from 'next/server';
import { accountFromToken, sessionToken } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { passkeysOf, publicKeyInfo } from '@/lib/passkeys';

export async function GET(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  return NextResponse.json({ keys: (await passkeysOf(account.user_id)).map(publicKeyInfo) });
}

export async function DELETE(req: NextRequest) {
  const account = await accountFromToken(sessionToken(req));
  if (!account) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await req.json().catch(() => ({}));
  await passkeysOf(account.user_id);    // makes sure the table exists
  const r = await getDb().prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(String(id ?? ''), account.user_id);
  return NextResponse.json({ ok: r.changes > 0 });
}
