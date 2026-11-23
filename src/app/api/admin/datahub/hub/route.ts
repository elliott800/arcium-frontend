// The Data Hub page's API (admin). Reads come from the hub's tables in this database; every change to what the hub
// records goes to its source manager as a command (wh_process_control), so the hub stays the only writer of its
// tables. Source maps and Warehouse access are the site's own settings.
//
//   GET ?view=home                                   -> DhHome
//   GET ?view=sources                                -> { sources: DhSource[] }
//   GET ?view=recorder|warehouse&category=&source=   -> { tree: DhNode[] }
//   GET ?view=options&series_id=                     -> { tree: DhNode[] }   (contract months and strikes)
//   GET ?view=registry&order=sources|bundles&category= -> { tree: DhNode[] }   (Recorder Registry)
//   POST { action: 'hooks', op: 'enable'|'disable'|'run', hook_ids }
//   POST { action: 'rates', items: [{ connection, key, param, value }], add: [rate], remove: [rate] }
//   POST { action: 'access', channel: 'recorder'|'warehouse', connections, on }
//   GET ?view=source_apis                            -> { sources: SourceApi[] }   (src/lib/datahubSources.ts)
//   GET ?view=source_markdown&connection=            -> the source map's markdown, as a download
//   GET ?view=source_options                         -> { types, credentials, seeds }   (for Add source)
//   GET ?view=command&id=                            -> { id, status, result }          (a queued hub command)
//   POST { action: 'source_register', connection, type, credentials, seed_id?, seed_class? } -> { control_id }  (add_connection)
//   POST { action: 'source_inspect', seed_id }       -> { control_id }   (inspect_seed: the seed's source API classes)
//   POST { action: 'source_map', connection }        -> { source }       (builds and stores the map and its markdown)
//   POST { action: 'source_record', connection, picks: { key: { param: [values] } } } -> { control_ids: { key: id } }
//   GET ?view=keys                                   -> KeysView: the source API keys, values never included (src/lib/datahubKeys.ts)
//   POST { action: 'key_save', name, connector?, api_key?, secret_key?, public_key?, account_ids? }  (adds, or adds to that API)
//   POST { action: 'key_remove', id, part?: 'api_key'|'secret_key'|'public_key'|'account', index?, masked? }  (no part: the whole API)
//   POST { action: 'key_use', connection, id }       -> { control_id }   (the source uses that key: add_connection again)

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { changeableRates, intervalFor, setWarehouseAccess } from '@/lib/datahubMap';
import { assignKey, deleteKey, listKeys, removePart, saveKey } from '@/lib/datahubKeys';
import { commandState, inspectSeed, mapSource, recordFromMap, registerSource, sourceApis, sourceMarkdown, sourceOptions } from '@/lib/datahubSources';
import { homeSummary, hooksById, hooksOfSources, optionLevels, recorderTree, registryTree, sourcesSummary, warehouseTree, clearTreeCache } from '@/lib/datahubTree';
import type { DhCategory } from '@/lib/datahubTypes';

const MAX_COMMANDS = 3000;
const CATS = new Set(['instrument', 'reference', 'all']);

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const sp = req.nextUrl.searchParams;
  const view = sp.get('view') ?? 'home';
  const cat = (CATS.has(sp.get('category') ?? '') ? sp.get('category') : 'all') as DhCategory | 'all';
  const source = (sp.get('source') ?? 'all').slice(0, 80);
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (view === 'home') return NextResponse.json(await homeSummary(), { headers });
    if (view === 'sources') return NextResponse.json({ sources: await sourcesSummary() }, { headers });
    if (view === 'source_apis') return NextResponse.json({ sources: await sourceApis() }, { headers });
    if (view === 'source_options') return NextResponse.json(await sourceOptions(), { headers });
    if (view === 'keys') return NextResponse.json(await listKeys(), { headers });
    if (view === 'command') {
      const id = Number(sp.get('id'));
      const st = Number.isInteger(id) && id > 0 ? await commandState(id) : null;
      return st ? NextResponse.json(st, { headers }) : NextResponse.json({ error: 'no such command' }, { status: 404 });
    }
    if (view === 'source_markdown') {
      const connection = (sp.get('connection') ?? '').slice(0, 40);
      const md = await sourceMarkdown(connection);
      if (md == null) return NextResponse.json({ error: `${connection} has no map yet: map the source first` }, { status: 404 });
      return new NextResponse(md, { headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${connection.replace(/[^\w-]/g, '_')}-drill-tree.md"` } });
    }
    if (view === 'recorder') return NextResponse.json({ tree: await recorderTree(cat, source) }, { headers });
    if (view === 'warehouse') return NextResponse.json({ tree: await warehouseTree(cat, source) }, { headers });
    if (view === 'registry') return NextResponse.json({ tree: await registryTree(sp.get('order') === 'bundles' ? 'bundles' : 'sources', cat) }, { headers });
    if (view === 'options') {
      const id = Number(sp.get('series_id'));
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'series_id required' }, { status: 400 });
      return NextResponse.json({ tree: await optionLevels(id) }, { headers });
    }
    return NextResponse.json({ error: 'unknown view' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: `The Data Hub tables can't be read here (${(e as Error).message.slice(0, 160)}).` }, { status: 503 });
  }
}

/** Queues commands for the hub's source manager; refuses when it isn't running. */
async function queue(commands: { command: string; args: Record<string, unknown> }[], by: string): Promise<{ queued: number } | NextResponse> {
  const db = getDb();
  const proc = await db.prepare(`SELECT machine_name FROM wh_process_state WHERE process_name = 'source_manager'
                                 ORDER BY last_tick_at DESC NULLS LAST LIMIT 1`).get() as { machine_name: string } | undefined;
  if (!proc) return NextResponse.json({ error: 'The Data Hub source manager is not running.' }, { status: 503 });
  for (const c of commands) {
    await db.prepare(`INSERT INTO wh_process_control (machine_name, process_name, command, args, requested_by)
                      VALUES (?, 'source_manager', ?, ?::jsonb, ?)`).run(proc.machine_name, c.command, JSON.stringify(c.args), by);
  }
  return { queued: commands.length };
}

const ITEM = /^[\w .:\-/^=@,]{1,80}$/;

export async function POST(req: NextRequest) {
  clearTreeCache();   // anything changed shows on the next load
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const by = admin.email ?? admin.username;

  if (body.action === 'hooks') {
    const op = String(body.op ?? '');
    if (!['enable', 'disable', 'run'].includes(op)) return NextResponse.json({ error: 'op must be enable, disable or run' }, { status: 400 });
    const ids = [...new Set((Array.isArray(body.hook_ids) ? body.hook_ids : []).map(String))].slice(0, MAX_COMMANDS + 1);
    if (!ids.length) return NextResponse.json({ error: 'nothing selected' }, { status: 400 });
    if (ids.length > MAX_COMMANDS) return NextResponse.json({ error: `At most ${MAX_COMMANDS} recordings at once; narrow the selection.` }, { status: 400 });
    const known = await hooksById(ids);
    // enabling leaves alone what the hub switched off for a reason (e.g. unsupported sub-minute rates)
    const target = [...known.values()].filter(h => op === 'run' ? h.enabled
      : op === 'enable' ? !h.enabled && !h.disabled_by : h.enabled);
    const kept = op === 'enable' ? [...known.values()].filter(h => !h.enabled && h.disabled_by).length : 0;
    const r = await queue(target.map(h => ({ command: `${op}_hook`, args: { hook_id: h.hook_id } })), by);
    if (r instanceof NextResponse) return r;
    return NextResponse.json({ ok: true, queued: r.queued, unknown: ids.length - known.size, kept_off: kept });
  }

  if (body.action === 'rates') {
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 2000) as Record<string, unknown>[];
    const add = (Array.isArray(body.add) ? body.add : []).map(String);
    const remove = (Array.isArray(body.remove) ? body.remove : []).map(String);
    if (!items.length || (!add.length && !remove.length)) return NextResponse.json({ error: 'choose items and rates' }, { status: 400 });
    const commands: { command: string; args: Record<string, unknown> }[] = [];
    const skipped: string[] = [];
    const db = getDb();
    for (const it of items) {
      const connection = String(it.connection ?? ''), key = String(it.key ?? ''), param = String(it.param ?? ''), value = String(it.value ?? '');
      if (!/^[\w.-]{1,80}$/.test(connection) || !/^[\w.-]{1,80}$/.test(key) || !/^\w{1,40}$/.test(param) || !ITEM.test(value)) { skipped.push(value); continue; }
      const allowed = changeableRates(connection, key);
      if (!allowed.length) { skipped.push(value); continue; }
      const existing = await db.prepare(`SELECT hook_id, enabled, disabled_by, params->>'data_rate' AS rate FROM wh_hooks
        WHERE connection_name = ? AND key = ? AND params->>? = ?`).all(connection, key, param, value) as
        { hook_id: string; enabled: boolean; disabled_by: string | null; rate: string | null }[];
      for (const rate of add) {
        if (!allowed.includes(rate)) continue;
        const h = existing.find(e => e.rate === rate);
        if (h) { if (!h.enabled && !h.disabled_by) commands.push({ command: 'enable_hook', args: { hook_id: h.hook_id } }); continue; }
        commands.push({ command: 'submit_hook', args: { connection, key, params: { [param]: value, data_rate: rate },
          every: intervalFor(connection, rate), submitted_by: `site:${admin.username}` } });
      }
      for (const rate of remove) {
        const h = existing.find(e => e.rate === rate && e.enabled);
        if (h) commands.push({ command: 'disable_hook', args: { hook_id: h.hook_id } });
      }
    }
    if (commands.length > MAX_COMMANDS) return NextResponse.json({ error: `That is ${commands.length} changes; at most ${MAX_COMMANDS} at once.` }, { status: 400 });
    if (!commands.length) return NextResponse.json({ ok: true, queued: 0, skipped: skipped.length, note: 'Nothing to change.' });
    const r = await queue(commands, by);
    if (r instanceof NextResponse) return r;
    return NextResponse.json({ ok: true, queued: r.queued, skipped: skipped.length });
  }

  if (body.action === 'access') {
    const channel = String(body.channel ?? '');
    const on = body.on === true;
    const connections = [...new Set((Array.isArray(body.connections) ? body.connections : []).map(String))].filter(c => /^[\w.-]{1,80}$/.test(c));
    if (!connections.length) return NextResponse.json({ error: 'choose sources' }, { status: 400 });
    if (channel === 'warehouse') {
      await setWarehouseAccess(connections, on, admin.username);
      return NextResponse.json({ ok: true, channel, on, sources: connections.length });
    }
    if (channel !== 'recorder') return NextResponse.json({ error: 'channel must be recorder or warehouse' }, { status: 400 });
    const hooks = await hooksOfSources(connections);
    const target = hooks.filter(h => (on ? !h.enabled && !h.disabled_by : h.enabled));
    if (target.length > MAX_COMMANDS * 3) return NextResponse.json({ error: `That would change ${target.length} recordings; switch sources one at a time.` }, { status: 400 });
    const r = await queue(target.map(h => ({ command: on ? 'enable_hook' : 'disable_hook', args: { hook_id: h.hook_id } })), by);
    if (r instanceof NextResponse) return r;
    return NextResponse.json({ ok: true, channel, on, queued: r.queued, kept_off: on ? hooks.filter(h => !h.enabled && h.disabled_by).length : 0 });
  }

  if (body.action === 'source_register' || body.action === 'source_inspect') {
    const r = body.action === 'source_register' ? await registerSource(body, by) : await inspectSeed(String(body.seed_id ?? ''), by);
    return typeof r === 'string' ? NextResponse.json({ error: r }, { status: 400 }) : NextResponse.json({ ok: true, control_id: r });
  }

  if (body.action === 'key_save') {
    const r = await saveKey(body, admin.username);
    return typeof r === 'string' ? NextResponse.json({ ok: true, id: r }) : NextResponse.json({ error: r.error }, { status: 400 });
  }

  if (body.action === 'key_remove') {
    const r = body.part ? await removePart(body) : await deleteKey(String(body.id ?? ''));
    return r === true ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r }, { status: 400 });
  }

  if (body.action === 'key_use') {
    const r = await assignKey(String(body.connection ?? '').slice(0, 40), String(body.id ?? ''), by);
    return typeof r === 'string' ? NextResponse.json({ error: r }, { status: 400 }) : NextResponse.json({ ok: true, control_id: r });
  }

  if (body.action === 'source_record') {
    const r = await recordFromMap(body, by);
    return typeof r === 'string' ? NextResponse.json({ error: r }, { status: 400 }) : NextResponse.json({ ok: true, control_ids: r });
  }

  if (body.action === 'source_map') {
    const r = await mapSource(String(body.connection ?? '').slice(0, 40), by);
    return typeof r === 'string' ? NextResponse.json({ error: r }, { status: 404 }) : NextResponse.json({ ok: true, source: r });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
