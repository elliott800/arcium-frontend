// GET  /api/machine/commands?machine_name=X&api_key=Y
//   → machine polls for queued commands (pending_scripts rows). This is the
//     ONLY way a command reaches a machine now — the site never calls a
//     machine directly, matching the "machines push/pull, nothing runs a
//     server" decision. Absorbs everything that used to be dispatched via
//     MACHINE_API_URL (script dispatch, process kill, silo settings, seed
//     plant) as just another kind of queued script_path + flags row.

import { type NextRequest, NextResponse } from 'next/server';
import { getPendingScriptsForMachine, queuePendingScript } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';
import { requireAdmin } from '@/lib/auth';
import type { MachineCommandsResponse, MachineCommandRow } from '@/lib/api-types';

export async function GET(req: NextRequest) {
  // Auth via X-Machine-Name / X-Machine-Key headers (query params still accepted for older clients).
  const machineName = await authenticateMachine(req);
  if (!machineName) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const commands = await getPendingScriptsForMachine(machineName) as MachineCommandRow[];
  return NextResponse.json<MachineCommandsResponse>({ commands });
}

// POST — admin-only raw dispatch: queue an arbitrary script_path for a machine
// (arbitrary script paths amount to remote code execution, so regular users
// go through /api/scripts/dispatch, which only allows catalogued commands).
// body: { machine_name, script_path, flags?, priority? }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({}));
  const { machine_name, script_path, flags, priority } = body as {
    machine_name?: string;
    script_path?: string;
    flags?: Record<string, unknown>;
    priority?: number;
  };

  if (!machine_name || !script_path) {
    return NextResponse.json({ error: 'machine_name and script_path required' }, { status: 400 });
  }

  const result = await queuePendingScript({ machine_name, username: admin.username, script_path, flags, priority });
  return NextResponse.json({ ok: true, queued: result.changes, job_id: result.lastInsertRowid });
}
