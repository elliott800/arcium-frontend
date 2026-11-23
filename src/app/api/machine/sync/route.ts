// The single sync-proxy push endpoint. Every machine (arcium_controller
// instance) calls this instead of the old MACHINE_API_URL FastAPI server or
// the web_push.py/ingest.php form-POST protocol. Auth is a per-machine API
// key, not a site login — machines push to the site, the site never calls
// into a machine.
//
// POST body:
//   {
//     machine_name: string,
//     api_key: string,
//     heartbeat?: { hostname?, platform?, silo_db_dir?, machine_id? },
//     tables?: { [tableName: string]: Record<string, unknown>[] }
//   }

import { type NextRequest, NextResponse } from 'next/server';
import { verifyMachine, upsertMachineHeartbeat, upsertRows, replaceMachineProcesses } from '@/lib/db';
import type { MachineSyncResponse } from '@/lib/api-types';
import { stripSecretsJson } from '@/lib/secrets';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { machine_name, api_key, heartbeat, tables } = body as {
    machine_name?: string;
    api_key?: string;
    heartbeat?: Record<string, unknown>;
    tables?: Record<string, Record<string, unknown>[]>;
  };

  if (!machine_name || !api_key) {
    return NextResponse.json({ error: 'machine_name and api_key required' }, { status: 400 });
  }

  const authed = await verifyMachine(machine_name, api_key);
  if (!authed) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  await upsertMachineHeartbeat({
    machine_name,
    last_heartbeat: new Date().toISOString(),
    hostname: heartbeat?.hostname as string | undefined,
    platform: heartbeat?.platform as string | undefined,
    silo_db_dir: heartbeat?.silo_db_dir as string | undefined,
    machine_id: heartbeat?.machine_id as number | undefined,
    load_json: heartbeat?.load ? JSON.stringify(heartbeat.load) : null,
  });

  const results: Record<string, number | string> = {};

  // `processes` is a full snapshot each push (see replaceMachineProcesses) —
  // handle it separately so an empty array (all processes stopped) still
  // clears stale rows instead of being skipped like every other table's
  // no-op-on-empty upsert.
  if (tables && 'processes' in tables) {
    try {
      const r = await replaceMachineProcesses(machine_name, tables.processes ?? []);
      results.processes = r.inserted;
    } catch (e) {
      results.processes = `skipped: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  for (const [table, rawRows] of Object.entries(tables ?? {})) {
    if (table === 'processes') continue;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      results[table] = 0;
      continue;
    }
    // Settings read from a machine's files can carry broker credentials —
    // those are stored encrypted (credentials table), never in synced rows.
    const rows = table === 'silo_registry'
      ? rawRows.map(r => ({
          ...r,
          ...('trader_settings' in r ? { trader_settings: stripSecretsJson(r.trader_settings as string | null) } : {}),
          ...('optimizer_settings' in r ? { optimizer_settings: stripSecretsJson(r.optimizer_settings as string | null) } : {}),
        }))
      : rawRows;
    try {
      const r = await upsertRows(table, rows, { machineName: machine_name });
      results[table] = r.inserted;
    } catch (e) {
      results[table] = `skipped: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return NextResponse.json<MachineSyncResponse>({ ok: true, results });
}
