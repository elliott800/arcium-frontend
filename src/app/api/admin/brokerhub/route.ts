// The BrokerHub's API (admin only; brokerhub.arciumsignals.com and the app): the broker API registry and its keys.
//
//   GET ?view=home                         -> BrokerHubView: brokers, connectors, accounts, keys (src/lib/brokerhub.ts)
//   GET ?view=keys                         -> KeysView: the broker API keys, values never included (src/lib/datahubKeys.ts)
//   GET ?view=map&broker=                  -> { tree }: the broker's map (its connector's getters and setters)
//   GET ?view=markdown&broker=             -> the broker map's markdown, as a download
//   GET ?view=dictionary&connector=        -> the connector's getter/setter dictionary, JSON
//   POST { action: 'broker_register', name, connector, credential_id?, owner, description? }  |  { action: 'broker_remove', name }
//   POST { action: 'key_save', ... }  |  { action: 'key_remove', id, part?, index?, masked? }   (as on the Data Hub, scope brokerhub)

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { brokerConnectors, brokerHub, brokerMapTree, brokerMarkdown, connectorOf, registerBroker, removeBroker } from '@/lib/brokerhub';
import { deleteKey, listKeys, removePart, saveKey } from '@/lib/datahubKeys';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const sp = req.nextUrl.searchParams;
  const view = sp.get('view') ?? 'home';
  try {
    if (view === 'home') {
      const v = await brokerHub();
      return NextResponse.json({ ...v, trees: Object.fromEntries(v.brokers.map(b => [b.name, brokerMapTree(`broker/${b.name}`, b.connector)])) }, { headers });
    }
    if (view === 'keys') return NextResponse.json(await listKeys('brokerhub', brokerConnectors()), { headers });
    if (view === 'map' || view === 'markdown') {
      const b = (await brokerHub()).brokers.find(x => x.name === sp.get('broker'));
      if (!b) return NextResponse.json({ error: 'no such broker' }, { status: 404 });
      if (view === 'map') return NextResponse.json({ tree: brokerMapTree(`broker/${b.name}`, b.connector) }, { headers });
      return new NextResponse(brokerMarkdown(b), { headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${b.name}-broker-map.md"` } });
    }
    if (view === 'dictionary') {
      const c = connectorOf(sp.get('connector') ?? '');
      if (!c) return NextResponse.json({ error: 'no such connector' }, { status: 404 });
      return new NextResponse(JSON.stringify({ connector: sp.get('connector'), ...c }, null, 2), { headers: { ...headers,
        'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${sp.get('connector')}-broker-dictionary.json"` } });
    }
    return NextResponse.json({ error: 'unknown view' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: `The BrokerHub could not be read (${(e as Error).message.slice(0, 160)}).` }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const by = admin.email ?? admin.username;
  const fail = (e: string, status = 400) => NextResponse.json({ error: e }, { status });

  if (body.action === 'broker_register') {
    const r = await registerBroker(body, by);
    return r === true ? NextResponse.json({ ok: true }) : fail(r);
  }
  if (body.action === 'broker_remove') {
    return NextResponse.json({ ok: true, removed: await removeBroker(String(body.name ?? '')) });
  }
  if (body.action === 'key_save') {
    const r = await saveKey(body, admin.username, 'brokerhub');
    return typeof r === 'string' ? NextResponse.json({ ok: true, id: r }) : fail(r.error);
  }
  if (body.action === 'key_remove') {
    const r = body.part ? await removePart(body, 'brokerhub') : await deleteKey(String(body.id ?? ''), 'brokerhub');
    return r === true ? NextResponse.json({ ok: true }) : fail(r);
  }
  return fail('unknown action');
}
