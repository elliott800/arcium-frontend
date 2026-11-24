// The signed-in account's Data Hub API access (src/lib/datahubAccess.ts). Open to every Arcium account, portal or not.
//   GET                                     -> { keys, max_keys, products: [{ ..., access: viewable | restricted, status }] }
//   POST { action: 'key_create', label }    -> { key }   the new key, shown this once (only its hash is stored)
//   POST { action: 'key_revoke', id }
//   POST { action: 'subscribe', product }   the Subscribe button: asks the owner to activate (Stripe Checkout later)

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { accountView, createKey, requestSubscription, revokeKey } from '@/lib/datahubAccess';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json(await accountView(user.username), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const fail = (error: string) => NextResponse.json({ error }, { status: 400 });
  switch (body.action) {
    case 'key_create': {
      const r = await createKey(user.username, String(body.label ?? ''));
      return typeof r === 'string' ? fail(r) : NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
    }
    case 'key_revoke':
      return (await revokeKey(user.username, String(body.id ?? ''))) ? NextResponse.json({ ok: true }) : fail('No such key.');
    case 'subscribe': {
      const r = await requestSubscription(user.username, String(body.product ?? ''));
      return r === true ? NextResponse.json({ ok: true }) : fail(r);
    }
    default:
      return fail('Unknown action.');
  }
}
