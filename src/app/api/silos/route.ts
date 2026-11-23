// API: this user's silos: list, create (planting a seed from the hub), delete.

import { type NextRequest, NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/public-origin';
import { createSeedUpload, getSeedBundle, getSilos, queuePendingScript, waitForSeedUpload } from '@/lib/db';
import type { SiloRegistryRow, CreateSiloResponse } from '@/lib/api-types';
import { requireUser, scopedUsername } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = scopedUsername(user, req.nextUrl.searchParams.get('username'));
  return NextResponse.json<SiloRegistryRow[]>(await getSilos(username) as SiloRegistryRow[]);
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json();
  const { siloName, personName, seedType, seedData, seedFilename, seedId, machine_name } = body;
  const username = user.username;

  if (!siloName) {
    return NextResponse.json({ error: 'siloName required' }, { status: 400 });
  }

  // Non-admins always create silos in their own workspace.
  const person_name = (user.role === 'admin' && personName?.trim()) || user.username;
  const silo_key = `${person_name.replace(/\s+/g, '_')}/${siloName.trim().replace(/\s+/g, '_')}`;
  const flags: Record<string, unknown> = { silo_name: siloName, person_name };

  // Seeds are planted from the hub's seed store by id (select_seed.py
  // downloads the bundle with its machine key).
  let plantSeedId: string | null = null;
  if (seedType === 'upload' && seedData && seedFilename) {
    const bundle = Buffer.from(String(seedData), 'base64');
    if (!bundle.length) return NextResponse.json({ error: 'empty seed upload' }, { status: 400 });
    const uploadId = await createSeedUpload({
      owner_username: person_name, seed_name: String(seedFilename).replace(/\.(zip|db|sqlite)$/i, '').slice(0, 80),
      bundle, submitted_by: user.email,
    });
    const up = await waitForSeedUpload(uploadId);
    if (up?.status === 'rejected') {
      return NextResponse.json({ error: `Seed rejected: ${up.reject_reason}`, upload_id: uploadId }, { status: 400 });
    }
    if (up?.status !== 'ready' || !up.seed_id) {
      return NextResponse.json({ error: 'Seed is still being validated — try again shortly.', upload_id: uploadId }, { status: 202 });
    }
    plantSeedId = up.seed_id;
  } else if (seedType === 'manager' && seedId) {
    const seed = await getSeedBundle(String(seedId));
    if (!seed || (user.role !== 'admin' && seed.owner_username !== user.username)) {
      return NextResponse.json({ error: 'seed not found' }, { status: 404 });
    }
    plantSeedId = String(seedId);
  }
  if (plantSeedId) {
    flags.seed_bundle_url = `${publicOrigin(req)}/api/machine/seeds/${encodeURIComponent(plantSeedId)}`;
  }

  const result = await queuePendingScript({
    machine_name: machine_name ?? 'arcium_machine',
    username,
    script_path: 'manager/primary/create_silo.py',
    flags,
  });

  return NextResponse.json<CreateSiloResponse>({ ok: true, silo_key, queued: result.changes, job_id: result.lastInsertRowid });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const username = user.username;
  const siloKey = req.nextUrl.searchParams.get('siloKey');
  const machineName = req.nextUrl.searchParams.get('machine') ?? 'arcium_machine';

  if (!siloKey) {
    return NextResponse.json({ error: 'siloKey required' }, { status: 400 });
  }

  const [person_name, silo_name] = siloKey.split('/');
  if (user.role !== 'admin' && person_name !== user.username) {
    return NextResponse.json({ error: 'You can only remove your own silos.' }, { status: 403 });
  }
  const result = await queuePendingScript({
    machine_name: machineName,
    username,
    script_path: 'manager/primary/remove_silo.py',
    flags: { silo_key: siloKey, person_name, silo_name },
  });

  return NextResponse.json({ ok: true, queued: result.changes, job_id: result.lastInsertRowid });
}
