// POST /api/machine/commands/:id/ack
// body: { machine_name, api_key, status: 'running'|'completed'|'failed', output?, error?, exit_code?, pid? }

import { type NextRequest, NextResponse } from 'next/server';
import { verifyMachine, ackPendingScript } from '@/lib/db';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) {
    return NextResponse.json({ error: 'invalid command id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const { machine_name, api_key, status, output, error, exit_code, pid } = body as {
    machine_name?: string;
    api_key?: string;
    status?: 'running' | 'completed' | 'failed';
    output?: string;
    error?: string;
    exit_code?: number;
    pid?: number;
  };

  if (!machine_name || !api_key) {
    return NextResponse.json({ error: 'machine_name and api_key required' }, { status: 400 });
  }
  const authed = await verifyMachine(machine_name, api_key);
  if (!authed) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  if (status !== 'running' && status !== 'completed' && status !== 'failed') {
    return NextResponse.json({ error: 'status must be running|completed|failed' }, { status: 400 });
  }

  await ackPendingScript(idNum, { status, output, error, exit_code, pid });
  return NextResponse.json({ ok: true });
}
