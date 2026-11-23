// Machine download of a seed bundle for planting (select_seed.py
// --seed_bundle_url). Auth: X-Machine-Name / X-Machine-Key headers.

import { type NextRequest, NextResponse } from 'next/server';
import { getSeedBundle } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ seedId: string }> }
) {
  if (!(await authenticateMachine(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { seedId } = await params;
  const seed = await getSeedBundle(seedId);
  if (!seed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new Response(new Uint8Array(seed.bundle), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${seed.name}.zip"`,
      'X-Bundle-Hash': seed.bundle_hash,
    },
  });
}
