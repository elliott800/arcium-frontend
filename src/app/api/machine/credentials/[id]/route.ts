// A machine resolves a credential_id from a queued job into the decrypted
// secrets — only for credentials bound to that machine.
// Auth: X-Machine-Name / X-Machine-Key headers.

import { type NextRequest, NextResponse } from 'next/server';
import { getCredentialForMachine } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const machine = await authenticateMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const secrets = await getCredentialForMachine(id, machine);
  if (!secrets) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ secrets }, { headers: { 'Cache-Control': 'no-store' } });
}
