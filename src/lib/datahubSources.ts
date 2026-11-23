// Source APIs: the connectors the Data Hub collects from, each with its map (a drill tree) and the map's markdown.
//
// A source is registered with the hub as a connector: Add source queues the hub's add_connection command with a
// connector type (one of the hub's own, or "seed": a source API class from a seed in the hub's seed warehouse) and the
// name of the credentials it uses (the values stay in the hub's settings). The hub builds the connector, checks the
// keys it declares, and lists the connection in wh_connections with those keys.
//
// A map is the source's drill tree, not a filter form: its keys (what can be collected), each key's parameters, and the
// values those parameters can take: the values its recordings use, plus the data rates a candles key allows. The map
// and its markdown (a dictionary of everything that can be collected) are stored in the site's table dh_source_apis.
//
// The Recorder records from a map: the values ticked in the tree become one submit_hook command per key, with a grid
// of the chosen values (every combination is one recording). The hub checks each and writes the hooks; the site never
// writes the hub's wh_* tables, it only queues commands (wh_process_control) and reads their results.

import { getDb } from '@/lib/db';
import { allowedRates } from '@/lib/datahubMap';
import type { DhNode } from '@/lib/datahubTypes';

export interface SourceKeySpec { key: string; path: string; params: Record<string, string>; description: string }
export interface SourceApi {
  connection: string; connector: string; seed_class: string | null; keys: SourceKeySpec[];
  tree: DhNode[]; markdown: string; mapped: boolean; updated_by: string | null; updated_at: string | null;
}
export interface SourceOptions { types: string[]; credentials: string[]; seeds: { id: string; name: string; version: number; owner: string }[] }
export interface CommandState { id: number; status: string; result: Record<string, unknown> | null }

const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const REF = /^[\w.:-]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASS = /^[A-Za-z_][\w.]{0,80}:[A-Za-z_]\w{0,80}$/;   // module:Class, as the hub lists a seed's source APIs
const MAX_RECORDINGS = 500;   // combinations one Record selected may submit per key
const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready) {
    ready = getDb().prepare(`CREATE TABLE IF NOT EXISTS dh_source_apis (
      connection text PRIMARY KEY, origin text NOT NULL, connector text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
      keys jsonb NOT NULL DEFAULT '[]'::jsonb, tree jsonb, markdown text,
      updated_by text, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`).run()
      .then(() => undefined).catch(e => { ready = null; throw e; });
  }
  return ready;
}

// ---- the hub's connectors ---------------------------------------------------------------------------------------------

/** The hub's connections and the keys each connector declares. */
async function hubSources(): Promise<{ connection: string; connector: string; seed_class: string | null; keys: SourceKeySpec[] }[]> {
  const rows = await getDb().prepare(`SELECT connection_name, connector_type, seed_class, keys FROM wh_connections ORDER BY connection_name`).all() as
    { connection_name: string; connector_type: string; seed_class: string | null; keys: unknown }[];
  return rows.map(r => {
    const k = (asJson(r.keys) ?? {}) as Record<string, { path?: string; params?: Record<string, unknown>; description?: string }>;
    return {
      connection: r.connection_name, connector: r.connector_type, seed_class: r.seed_class,
      keys: Object.entries(k).map(([key, v]) => ({
        key, path: String(v?.path ?? ''), description: String(v?.description ?? ''),
        params: Object.fromEntries(Object.entries(v?.params ?? {}).map(([p, t]) => [p, String(t)])),
      })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  });
}

/** What Add source can choose from: connector types, credential names (never values), and seeds. */
export async function sourceOptions(): Promise<SourceOptions> {
  const db = getDb();
  const [types, creds, seeds] = await Promise.all([
    db.prepare(`SELECT DISTINCT connector_type AS t FROM wh_connections ORDER BY 1`).all() as Promise<{ t: string }[]>,
    db.prepare(`SELECT DISTINCT credentials_ref AS c FROM wh_connections WHERE credentials_ref <> '' ORDER BY 1`).all() as Promise<{ c: string }[]>,
    (db.prepare(`SELECT id::text AS id, seed_name, version, owner_username FROM wh_seeds WHERE NOT deleted ORDER BY seed_name, version DESC`).all() as
      Promise<{ id: string; seed_name: string; version: number; owner_username: string }[]>).catch(() => []),
  ]);
  return {
    types: [...new Set([...types.map(t => t.t), 'seed'])].sort(),
    credentials: creds.map(c => c.c),
    seeds: seeds.map(s => ({ id: s.id, name: s.seed_name, version: Number(s.version), owner: s.owner_username })),
  };
}

/** For one connection: recordings per key, and the values each parameter records (most used first). */
async function recorded(connection: string): Promise<Map<string, { hooks: number; values: Record<string, { value: string; n: number }[]> }>> {
  const rows = await getDb().prepare(`SELECT key, params FROM wh_hooks WHERE connection_name = ?`).all(connection) as { key: string; params: unknown }[];
  const out = new Map<string, { hooks: number; values: Record<string, Map<string, number>> }>();
  for (const r of rows) {
    const e = out.get(r.key) ?? { hooks: 0, values: {} };
    e.hooks++;
    for (const [p, v] of Object.entries((asJson(r.params) ?? {}) as Record<string, unknown>)) {
      const m = e.values[p] ?? new Map<string, number>();
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      m.set(s, (m.get(s) ?? 0) + 1);
      e.values[p] = m;
    }
    out.set(r.key, e);
  }
  return new Map([...out].map(([k, e]) => [k, {
    hooks: e.hooks,
    values: Object.fromEntries(Object.entries(e.values).map(([p, m]) =>
      [p, [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))])),
  }]));
}

// ---- the map: a drill tree, and its markdown ---------------------------------------------------------------------------

type Recorded = Awaited<ReturnType<typeof recorded>>;
const SHOWN = 200;   // values listed per parameter in the tree (the markdown lists 25)

/** A value leaf's id: src/<connection>/<key>/<param>/<value>, the value URI-encoded. */
export const valueId = (connection: string, key: string, param: string, value: string) =>
  `src/${connection}/${key}/${param}/${encodeURIComponent(value)}`;

/** A key's parameters in the order its path names them (stored JSON does not keep key order), then any others. */
function paramList(k: SourceKeySpec, rec: Recorded): [string, string][] {
  const named = Object.keys(k.params).length ? Object.entries(k.params)
    : Object.keys(rec.get(k.key)?.values ?? {}).map(p => [p, ''] as [string, string]);
  const at = (p: string) => { const i = k.path.indexOf(`{${p}}`); return i < 0 ? 1e9 : i; };
  return named.sort((a, b) => at(a[0]) - at(b[0]) || a[0].localeCompare(b[0]));
}

/** A parameter's values: recorded ones (most used first), then the rates a key allows that nothing records yet. */
function valuesOf(connection: string, k: SourceKeySpec, param: string, rec: Recorded): { value: string; n: number }[] {
  const vals = [...(rec.get(k.key)?.values[param] ?? [])];
  if (param === 'data_rate') {
    for (const r of allowedRates(connection, k.key)) if (!vals.some(v => v.value === r)) vals.push({ value: r, n: 0 });
  }
  return vals;
}

function buildTree(connection: string, keys: SourceKeySpec[], rec: Recorded): DhNode[] {
  return keys.map(k => {
    const r = rec.get(k.key);
    const params = paramList(k, rec);
    return {
      id: `src/${connection}/${k.key}`, label: k.key, source: connection, tags: [], count: params.length || 1,
      contents: [k.description, k.path && `path ${k.path}`, r ? `${r.hooks.toLocaleString()} recordings` : 'not recorded yet']
        .filter(Boolean).join(' · '),
      children: params.map(([p, type]) => {
        const vals = valuesOf(connection, k, p, rec);
        return {
          id: `src/${connection}/${k.key}/${p}`, label: p, source: connection, tags: [], count: vals.length || 1,
          contents: `${type || 'parameter'}${vals.length ? ` · ${vals.length.toLocaleString()} value${vals.length === 1 ? '' : 's'}` : ' · add values in the Recorder'}`,
          children: vals.slice(0, SHOWN).map(v => ({
            id: valueId(connection, k.key, p, v.value), label: v.value, source: connection, tags: [], count: 1,
            contents: v.n ? `${v.n.toLocaleString()} recording${v.n === 1 ? '' : 's'}` : 'available, not recorded',
          })),
        };
      }),
    };
  });
}

function buildMarkdown(api: { connection: string; connector: string; seed_class: string | null }, keys: SourceKeySpec[], rec: Recorded, at: string): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    `# ${api.connection}: drill-tree dictionary`,
    '',
    `Everything that can be collected from **${api.connection}**: its keys, the parameters each key takes, and the values `
      + 'its recordings use (with the data rates a candles key allows).',
    '',
    `- Connector: ${api.connector}${api.seed_class ? ` (source API class ${api.seed_class})` : ''}`,
    `- Keys: ${keys.length}`,
    `- Mapped: ${at}`,
    '',
  ];
  for (const k of keys) {
    const r = rec.get(k.key);
    lines.push(`## ${k.key}`, '');
    if (k.description) lines.push(k.description, '');
    if (k.path) lines.push(`- Path: \`${k.path}\``);
    lines.push(`- Recordings: ${r ? r.hooks.toLocaleString() : 'none yet'}`, '');
    const params = paramList(k, rec);
    if (params.length) {
      lines.push('| Parameter | Type | Values |', '|---|---|---|');
      for (const [p, t] of params) {
        const vals = valuesOf(api.connection, k, p, rec);
        const shown = vals.slice(0, 25).map(v => esc(v.value) + (v.n ? '' : ' (available)')).join(', ');
        lines.push(`| ${esc(p)} | ${esc(t || '—')} | ${shown || '—'}${vals.length > 25 ? ` … (${vals.length} in all)` : ''} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---- reading and writing ------------------------------------------------------------------------------------------------

/** Every source the hub has, each with its stored map (if mapped yet). */
export async function sourceApis(): Promise<SourceApi[]> {
  await ensure();
  const [hub, stored] = await Promise.all([
    hubSources(),
    getDb().prepare(`SELECT connection, tree, markdown, updated_by, updated_at FROM dh_source_apis`).all() as
      Promise<{ connection: string; tree: unknown; markdown: string | null; updated_by: string | null; updated_at: string | null }[]>,
  ]);
  const byName = new Map(stored.map(s => [s.connection, s]));
  return hub.map(h => {
    const s = byName.get(h.connection);
    return { ...h, tree: (asJson(s?.tree) as DhNode[] | null) ?? [], markdown: s?.markdown ?? '', mapped: !!s?.markdown,
      updated_by: s?.updated_by ?? null, updated_at: s?.updated_at ? new Date(s.updated_at).toISOString() : null };
  });
}

/** (Re)builds a source's map from its connector's keys and its recordings, and stores the map and its markdown. */
export async function mapSource(connection: string, by: string): Promise<SourceApi | string> {
  const api = (await sourceApis()).find(s => s.connection === connection);
  if (!api) return `the hub has no source called ${connection} (yet)`;
  const rec = await recorded(connection);
  const at = new Date().toISOString();
  const tree = buildTree(connection, api.keys, rec);
  const markdown = buildMarkdown(api, api.keys, rec, at.slice(0, 16).replace('T', ' ') + ' UTC');
  await getDb().prepare(`INSERT INTO dh_source_apis (connection, origin, connector, keys, tree, markdown, updated_by, updated_at)
      VALUES (?, 'hub', ?, ?::jsonb, ?::jsonb, ?, ?, ?)
      ON CONFLICT (connection) DO UPDATE SET origin = 'hub', connector = EXCLUDED.connector, keys = EXCLUDED.keys,
        tree = EXCLUDED.tree, markdown = EXCLUDED.markdown, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(connection, api.connector, JSON.stringify(api.keys), JSON.stringify(tree), markdown, by, at);
  return { ...api, tree, markdown, mapped: true, updated_by: by, updated_at: at };
}

/** The stored markdown of a source's map, or null when it hasn't been mapped. */
export async function sourceMarkdown(connection: string): Promise<string | null> {
  await ensure();
  const r = await getDb().prepare(`SELECT markdown FROM dh_source_apis WHERE connection = ?`).get(connection) as { markdown: string | null } | undefined;
  return r?.markdown ?? null;
}

// ---- commands to the hub ------------------------------------------------------------------------------------------------

async function queue(command: string, args: Record<string, unknown>, by: string): Promise<number | string> {
  const db = getDb();
  const proc = await db.prepare(`SELECT machine_name FROM wh_process_state WHERE process_name = 'source_manager'
                                 ORDER BY last_tick_at DESC NULLS LAST LIMIT 1`).get() as { machine_name: string } | undefined;
  if (!proc) return 'The Data Hub source manager is not running.';
  const row = await db.prepare(`INSERT INTO wh_process_control (machine_name, process_name, command, args, requested_by)
                                VALUES (?, 'source_manager', ?, ?::jsonb, ?) RETURNING id`)
    .get(proc.machine_name, command, JSON.stringify(args), by) as { id: number | string };
  return Number(row.id);
}

/** A queued command's state: pending, claimed, done or failed, with the hub's result. */
export async function commandState(id: number): Promise<CommandState | null> {
  const r = await getDb().prepare(`SELECT id, status, result FROM wh_process_control WHERE id = ? AND process_name = 'source_manager'`)
    .get(id) as { id: number | string; status: string; result: unknown } | undefined;
  return r ? { id: Number(r.id), status: r.status, result: (asJson(r.result) as Record<string, unknown>) ?? null } : null;
}

/** Add source: asks the hub to register a connector (add_connection). Returns the command id to wait on. */
export async function registerSource(body: Record<string, unknown>, by: string): Promise<number | string> {
  const name = String(body.connection ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return 'name: 2 to 40 lower-case letters, digits or _, starting with a letter';
  const type = String(body.type ?? '').trim();
  const opts = await sourceOptions();
  if (!opts.types.includes(type)) return `connector must be one of ${opts.types.join(', ')}`;
  const credentials = String(body.credentials ?? '').trim();
  if (!REF.test(credentials)) return 'credentials: the name of the credentials in the Data Hub settings (letters, digits, _ . : -)';
  if ((await hubSources()).some(s => s.connection === name)) return `${name} is already a source`;
  const args: Record<string, unknown> = { name, type, credentials, enabled: true };
  if (type === 'seed') {
    const seed = String(body.seed_id ?? ''), cls = String(body.seed_class ?? '');
    if (!UUID.test(seed) || !opts.seeds.some(s => s.id === seed)) return 'choose a seed';
    if (!CLASS.test(cls)) return 'choose the seed\'s source API class (module:Class)';
    Object.assign(args, { seed_id: seed, seed_class: cls });
  }
  return queue('add_connection', args, by);
}

/** The source API classes in a seed (the hub's inspect_seed). Returns the command id to wait on. */
export async function inspectSeed(seedId: string, by: string): Promise<number | string> {
  if (!UUID.test(seedId)) return 'choose a seed';
  return queue('inspect_seed', { seed_id: seedId }, by);
}

/** Record selected: one submit_hook per key, the chosen values as a grid. Returns { key: command id } or an error. */
export async function recordFromMap(body: Record<string, unknown>, by: string): Promise<Record<string, number> | string> {
  const connection = String(body.connection ?? '');
  const api = (await hubSources()).find(s => s.connection === connection);
  if (!api) return `the hub has no source called ${connection}`;
  const picks = (body.picks ?? {}) as Record<string, Record<string, unknown>>;
  const grids: [string, Record<string, unknown[]>][] = [];
  for (const [key, params] of Object.entries(picks)) {
    const k = api.keys.find(x => x.key === key);
    if (!k) return `${connection} has no key ${key}`;
    const grid: Record<string, unknown[]> = {};
    let combos = 1;
    for (const [p, type] of Object.entries(k.params)) {
      const raw = Array.isArray(params?.[p]) ? (params[p] as unknown[]).map(v => String(v).trim()).filter(Boolean) : [];
      if (!raw.length) return `${key}: choose at least one ${p}`;
      const vals = raw.slice(0, MAX_RECORDINGS).map(v => (type === 'int' ? Number.parseInt(v, 10) : type === 'float' ? Number(v)
        : type === 'list' ? v.split(',').map(x => x.trim()).filter(Boolean) : type === 'bool' ? v === 'true' : v));
      if (vals.some(v => typeof v === 'number' && !Number.isFinite(v))) return `${key}: ${p} must be a number`;
      grid[p] = vals;
      combos *= vals.length;
    }
    for (const p of Object.keys(params ?? {})) if (!(p in k.params)) return `${key} takes no parameter ${p}`;
    if (combos > MAX_RECORDINGS) return `${key}: ${combos.toLocaleString()} recordings at once is too many (at most ${MAX_RECORDINGS})`;
    grids.push([key, grid]);
  }
  if (!grids.length) return 'tick the values to record';
  const ids: Record<string, number> = {};
  for (const [key, grid] of grids) {
    const id = await queue('submit_hook', { connection, key, grid, submitted_by: 'recorder' }, by);
    if (typeof id === 'string') return id;
    ids[key] = id;
  }
  return ids;
}
