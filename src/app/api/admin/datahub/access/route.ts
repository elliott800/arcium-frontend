// The Data Hub center's API access section (admin): the guest switch, the processed-data products and every account's
// subscriptions (src/lib/datahubAccess.ts; the midend data API reads the same tables).
//   GET                                                        -> { guest_enabled, products, subscriptions, accounts }
//   POST { action: 'guest', on }
//   POST { action: 'sub_set', username, product, status }     status: active | paused | ended (active also starts one)
//   POST { action: 'product_save', id, name, description, kind, visible }
//   POST { action: 'product_remove', id }                     refused while a subscription is active

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { adminView, removeProduct, saveProduct, setGuest, setSubscription, type SubStatus } from '@/lib/datahubAccess';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json(await adminView(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const done = (r: true | string) => (r === true ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r }, { status: 400 }));
  switch (body.action) {
    case 'guest':
      await setGuest(body.on === true, admin.username);
      return NextResponse.json({ ok: true });
    case 'sub_set':
      return done(await setSubscription(String(body.username ?? ''), String(body.product ?? ''), String(body.status ?? '') as SubStatus, admin.username));
    case 'product_save':
      return done(await saveProduct(body));
    case 'product_remove':
      return done(await removeProduct(String(body.id ?? '')));
    default:
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  }
}
