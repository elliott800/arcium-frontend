// Queues a command for the machine to poll and run — replaces the old
// direct call to MACHINE_API_URL/scripts/run. `command` resolves via the
// script_handler table (same as before); `script_path` bypasses that lookup.

import { type NextRequest, NextResponse } from 'next/server';
import { getScriptHandler, queuePendingScript } from '@/lib/db';
import type { DispatchResponse, DispatchErrorResponse } from '@/lib/api-types';
import { requireUser, userFlags } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const { machine_name, command, script_path, flags } = await req.json();
  const username = user.username;

  let resolvedPath: string | undefined;
  if (command) {
    const handler = await getScriptHandler(command as string);
    if (!handler) {
      return NextResponse.json<DispatchErrorResponse>(
        { error: `Unknown command: "${command}". Add it to the script_handler table first.` },
        { status: 404 },
      );
    }
    resolvedPath = handler.script_path;
  } else if (script_path) {
    // A raw script path runs arbitrary code on the machine — admin only.
    if (user.role !== 'admin') {
      return NextResponse.json<DispatchErrorResponse>({ error: 'Raw script_path dispatch is admin-only; use a catalogued command.' }, { status: 403 });
    }
    resolvedPath = script_path as string;
  } else {
    return NextResponse.json<DispatchErrorResponse>({ error: 'command or script_path required' }, { status: 400 });
  }

  const result = await queuePendingScript({
    machine_name: (machine_name as string | undefined) ?? 'arcium_machine',
    username,
    script_path: resolvedPath,
    flags: userFlags(user, typeof flags === 'string' ? JSON.parse(flags) : (flags ?? {})),
  });

  return NextResponse.json<DispatchResponse>({
    ok: true,
    queued: result.changes,
    job_id: result.lastInsertRowid,
    command: command ?? null,
    script_path: resolvedPath,
  });
}
