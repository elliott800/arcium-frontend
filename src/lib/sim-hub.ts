// The simulated Data Hub source manager (npm run sim only): answers the commands the site queues in
// wh_process_control the way the real one does, on the simulated warehouse, so the Data Hub page's commands can be
// built and tested without a hub. Real hub behaviour lives in the Data Hub repository (hub_services/source_manager).
//
//   add_connection   a connector type the simulated warehouse already has: the new connection gets that type's keys
//                    ("seed" fails: the simulated warehouse has no seeds)
//   submit_hook      one hook per combination of the grid (or the params), checked against the key's parameters
//   enable_hook / disable_hook / run_hook / remove_hook, inspect_seed (fails: no seeds)
// Anything else is answered as failed, saying the simulation does not cover it.

import type { SimPool } from './sim-db';

type Row = Record<string, unknown>;
const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

function expandGrid(grid: Record<string, unknown>): Row[] {
  let combos: Row[] = [{}];
  for (const [name, val] of Object.entries(grid)) {
    const vals = Array.isArray(val) ? val : [val];
    combos = combos.flatMap(c => vals.map(v => ({ ...c, [name]: v })));
  }
  return combos;
}

const hookId = (connection: string, key: string, params: Row) =>
  [connection, key, ...Object.keys(params).sort().map(k => (Array.isArray(params[k]) ? (params[k] as unknown[]).join('+') : String(params[k])))].join('.');

async function handle(pool: SimPool, command: string, args: Row): Promise<Row> {
  if (command === 'add_connection') {
    const name = String(args.name), type = String(args.type);
    const like = (await pool.query(`SELECT keys FROM wh_connections WHERE connector_type = $1 LIMIT 1`, [type])).rows[0];
    if (!like) throw new Error(type === 'seed' ? 'seed not found (the simulated warehouse has no seeds)' : `unknown connector type '${type}'`);
    await pool.query(`INSERT INTO wh_connections (connection_name, connector_type, credentials_ref, origin, keys)
                      VALUES ($1, $2, $3, 'platform', $4::jsonb)`, [name, type, String(args.credentials ?? ''), JSON.stringify(asJson(like.keys))]);
    return { connection: name, connector_type: type, enabled: true, keys: Object.keys(asJson(like.keys) ?? {}).sort() };
  }
  if (command === 'submit_hook') {
    const connection = String(args.connection), key = String(args.key);
    const conn = (await pool.query(`SELECT keys FROM wh_connections WHERE connection_name = $1`, [connection])).rows[0];
    const spec = (asJson(conn?.keys) ?? {})[key] as { path?: string; params?: Row } | undefined;
    if (!spec) throw new Error(`${connection} has no key '${key}'`);
    const like = (await pool.query(`SELECT output_kind, mode, interval_seconds FROM wh_hooks WHERE connection_name = $1 AND key = $2 LIMIT 1`,
      [connection, key])).rows[0] ?? { output_kind: 'frame', mode: 'update', interval_seconds: 21600 };
    const submitted: string[] = [], unchanged: string[] = [], failed: Row[] = [];
    for (const params of args.grid ? expandGrid(args.grid as Row) : [((args.params as Row) ?? {})]) {
      const id = hookId(connection, key, params);
      const missing = Object.keys(spec.params ?? {}).filter(p => !(p in params));
      const extra = Object.keys(params).filter(p => !(p in (spec.params ?? {})));
      if (missing.length || extra.length) { failed.push({ hook_id: id, reason: [...missing.map(p => `missing param '${p}'`), ...extra.map(p => `unexpected param '${p}'`)].join('; ') }); continue; }
      if ((await pool.query(`SELECT 1 FROM wh_hooks WHERE hook_id = $1`, [id])).rows.length) { unchanged.push(id); continue; }
      const path = String(spec.path ?? '').replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? ''));
      await pool.query(`INSERT INTO wh_hooks (hook_id, connection_name, key, params, output_kind, mode, interval_seconds, enabled, submitted_by, data_path, next_run_at)
                        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, true, $8, $9, now())`,
        [id, connection, key, JSON.stringify(params), like.output_kind, like.mode, like.interval_seconds, String(args.submitted_by ?? 'command'), path]);
      submitted.push(id);
    }
    if (!submitted.length && !unchanged.length && failed.length) throw new Error(`all hooks rejected: ${JSON.stringify(failed)}`);
    return { submitted, unchanged, failed };
  }
  if (['enable_hook', 'disable_hook', 'run_hook', 'remove_hook'].includes(command)) {
    const id = String(args.hook_id);
    if (command === 'remove_hook') await pool.query(`DELETE FROM wh_hooks WHERE hook_id = $1`, [id]);
    else if (command !== 'run_hook') await pool.query(`UPDATE wh_hooks SET enabled = $2 WHERE hook_id = $1`, [id, command === 'enable_hook']);
    return { hook_id: id };
  }
  if (command === 'inspect_seed') throw new Error('seed not found (the simulated warehouse has no seeds)');
  throw new Error(`the simulated source manager does not cover '${command}'`);
}

/** Answers pending source-manager commands every second (one simulated database per process). */
export function startSimHub(pool: SimPool): void {
  const g = globalThis as unknown as { __arciumSimHub?: boolean };
  if (g.__arciumSimHub) return;
  g.__arciumSimHub = true;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const rows = (await pool.query(`SELECT id, command, args FROM wh_process_control
                                      WHERE status = 'pending' AND process_name = 'source_manager' ORDER BY id LIMIT 20`)).rows;
      for (const r of rows) {
        let status = 'done', result: Row;
        try { result = await handle(pool, String(r.command), (asJson(r.args) ?? {}) as Row); }
        catch (e) { status = 'failed'; result = { error: (e as Error).message }; }
        await pool.query(`UPDATE wh_process_control SET status = $2, result = $3::jsonb, claimed_at = now(), completed_at = now() WHERE id = $1`,
          [r.id, status, JSON.stringify(result)]);
      }
    } catch { /* the next tick tries again */ } finally { running = false; }
  }, 1000);
}
