// GET -> { bundles: [{ id, name, source, kind, hooks: [hook_id, ...] }] }
// The Data Hub's source bundles for the midend data API (arcium_midend/api): which recordings each bundle groups,
// computed by the same code as the Data Hub page (registryTree), so the API never keeps its own copy of the rules.
// kind: system (built in), other (a source's recordings outside its bundles) or saved (Source Bundle Maker).
// Server to server only: header X-Midend-Key must equal MIDEND_SECRET; no secret set means the route is closed.

import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { registryTree } from '@/lib/datahubTree';

function allowed(req: NextRequest): boolean {
  const want = process.env.MIDEND_SECRET ?? '';
  const got = req.headers.get('x-midend-key') ?? '';
  return !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const nodes = await registryTree('bundles');
  const bundles = nodes.map(n => ({
    id: slug(String(n.label)),
    name: String(n.label),
    source: n.source ?? '',
    kind: n.tags.includes('saved') ? 'saved' : n.tags.includes('other') ? 'other' : 'system',
    hooks: ((n as { data?: { hooks?: string[] } }).data?.hooks ?? []).map(String),
  }));
  return NextResponse.json({ bundles }, { headers: { 'Cache-Control': 'no-store' } });
}
