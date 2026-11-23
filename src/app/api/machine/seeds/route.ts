// A machine uploads a seed collected from one of its silos (collect_seed.py).
// Queued as a pending upload for the hub's seed_warehouse to validate.
// Auth: X-Machine-Name / X-Machine-Key headers.
// body: { name, owner_username, description?, bundleBase64 }

import { type NextRequest, NextResponse } from 'next/server';
import { createSeedUpload } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';

export async function POST(req: NextRequest) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { name, owner_username, description, bundleBase64 } = await req.json().catch(() => ({}));
  if (!name || !owner_username || !bundleBase64) {
    return NextResponse.json({ error: 'name, owner_username and bundleBase64 required' }, { status: 400 });
  }
  const bundle = Buffer.from(String(bundleBase64), 'base64');
  if (bundle.length === 0) return NextResponse.json({ error: 'empty bundle' }, { status: 400 });
  if (bundle.length > 50 * 1024 * 1024) return NextResponse.json({ error: 'bundle larger than 50 MB' }, { status: 413 });

  const uploadId = await createSeedUpload({
    owner_username: String(owner_username), seed_name: String(name), description,
    bundle, submitted_by: `machine:${machine}`,
  });
  return NextResponse.json({ ok: true, upload_id: uploadId, status: 'pending' }, { status: 202 });
}
