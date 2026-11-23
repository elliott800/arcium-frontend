// The owner's test-session controls (Control panel > Users): the sign-in page's User button copies a template of
// simulated systems (the demo_template user and the simulated machine demo_machine) into a throwaway account.
// GET  -> { template_silos, template_models, active_sessions }
// POST { action: 'seed' } -> builds (or rebuilds) the template with scripts/demo-seed.mjs in this database

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb, getPool } from '@/lib/db';
import { DEMO_TEMPLATE_USER } from '@/lib/demo';

async function count(sql: string, ...args: unknown[]): Promise<number> {
  try { return Number(((await getDb().prepare(sql).get(...args)) as { n: number | string }).n); } catch { return 0; }
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({
    template_silos: await count(`SELECT count(*) AS n FROM silo_registry WHERE username = ?`, DEMO_TEMPLATE_USER),
    template_models: await count(`SELECT count(*) AS n FROM catalog_models WHERE username = ?`, DEMO_TEMPLATE_USER),
    active_sessions: await count(`SELECT count(*) AS n FROM users WHERE demo_expires_at > now()`),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { action } = await req.json().catch(() => ({}));
  if (action !== 'seed') return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  const { seedDemo } = await import('../../../../../scripts/demo-seed.mjs');
  const client = await getPool().connect();
  try {
    await seedDemo(client, { label: 'the test-session template', systems: 48 });
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}
