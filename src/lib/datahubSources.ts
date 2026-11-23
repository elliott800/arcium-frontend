// Source APIs: each source the Data Hub can collect from, with its map and the map's markdown, stored in the site's
// own table dh_source_apis (the hub's wh_* tables are written only by the hub).
//
// A map is the source's drill tree, not a filter form: the source's main keys (what can be collected), each key's
// parameters, and, for a hub source, how many recordings use each key and the values they record. The markdown is
// that tree as a dictionary of everything that can be collected from the source, for download.
//
//   hub sources    the hub's connections (wh_connections): their keys come from the hub's own description of each
//                  connector (wh_connections.keys: path, params, description). "Map source" (re)builds and stores it.
//   added sources  "Add source": a name, a connector, a description and its keys, one per line:
//                      <key> <path with {parameters}> [- description]
//                  The parameters are the {placeholders} in the path. The hub records an added source once it has a
//                  connector for it; until then the source is registered here with its map.

import { getDb } from '@/lib/db';
import type { DhNode } from '@/lib/datahubTypes';

export interface SourceKeySpec { key: string; path: string; params: Record<string, string>; description: string }
export interface SourceApi {
  connection: string; origin: 'hub' | 'added'; connector: string; description: string;
  keys: SourceKeySpec[]; tree: DhNode[]; markdown: string; mapped: boolean;
  updated_by: string | null; updated_at: string | null;
}

const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const KEY = /^[A-Za-z][\w.\-]{0,59}$/;
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

// ---- what a source offers ---------------------------------------------------------------------------------------------

/** The hub's connections and the keys each one's connector describes. */
async function hubSources(): Promise<{ connection: string; connector: string; keys: SourceKeySpec[] }[]> {
  const rows = await getDb().prepare(`SELECT connection_name, connector_type, keys FROM wh_connections ORDER BY connection_name`).all() as
    { connection_name: string; connector_type: string; keys: unknown }[];
  return rows.map(r => {
    const k = (asJson(r.keys) ?? {}) as Record<string, { path?: string; params?: Record<string, unknown>; description?: string }>;
    return {
      connection: r.connection_name, connector: r.connector_type,
      keys: Object.entries(k).map(([key, v]) => ({
        key, path: String(v?.path ?? ''), description: String(v?.description ?? ''),
        params: Object.fromEntries(Object.entries(v?.params ?? {}).map(([p, t]) => [p, String(t)])),
      })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  });
}

/** For a hub source: recordings per key, and the values each parameter records (most used first). */
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

/** A key's parameters in the order its path names them (stored JSON does not keep key order), then any others. */
function paramList(k: SourceKeySpec, rec: Recorded): [string, string][] {
  const named = Object.keys(k.params).length ? Object.entries(k.params)
    : Object.keys(rec.get(k.key)?.values ?? {}).map(p => [p, ''] as [string, string]);
  const at = (p: string) => { const i = k.path.indexOf(`{${p}}`); return i < 0 ? 1e9 : i; };
  return named.sort((a, b) => at(a[0]) - at(b[0]) || a[0].localeCompare(b[0]));
}
const SHOWN = 25;   // recorded values listed per parameter

function buildTree(connection: string, keys: SourceKeySpec[], rec: Recorded): DhNode[] {
  return keys.map(k => {
    const r = rec.get(k.key);
    const params = paramList(k, rec);
    return {
      id: `src/${connection}/${k.key}`, label: k.key, source: connection, tags: [], count: params.length || 1,
      contents: [k.description, k.path && `path ${k.path}`, r ? `${r.hooks.toLocaleString()} recordings` : 'not recorded yet']
        .filter(Boolean).join(' · '),
      children: params.map(([p, type]) => {
        const vals = r?.values[p] ?? [];
        return {
          id: `src/${connection}/${k.key}/${p}`, label: p, source: connection, tags: [], count: vals.length || 1,
          contents: `${type || 'parameter'}${vals.length ? ` · ${vals.length.toLocaleString()} recorded value${vals.length === 1 ? '' : 's'}` : ''}`,
          children: vals.slice(0, SHOWN).map(v => ({
            id: `src/${connection}/${k.key}/${p}/${v.value}`, label: v.value, source: connection, tags: [], count: 1,
            contents: `${v.n.toLocaleString()} recording${v.n === 1 ? '' : 's'}`,
          })),
        };
      }),
    };
  });
}

function buildMarkdown(api: { connection: string; origin: string; connector: string; description: string }, keys: SourceKeySpec[], rec: Recorded, at: string): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    `# ${api.connection}: drill-tree dictionary`,
    '',
    `Everything that can be collected from **${api.connection}**${api.connector ? ` (connector: ${api.connector})` : ''}: its main keys, `
      + 'the parameters each key takes and, for keys the Data Hub records, the values it records.',
    '',
    `- Source: ${api.origin === 'hub' ? 'a Data Hub connection' : 'added on the Data Hub page'}`,
    ...(api.description ? [`- Description: ${api.description}`] : []),
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
      lines.push('| Parameter | Type | Recorded values |', '|---|---|---|');
      for (const [p, t] of params) {
        const vals = r?.values[p] ?? [];
        const shown = vals.slice(0, SHOWN).map(v => esc(v.value)).join(', ');
        lines.push(`| ${esc(p)} | ${esc(t || '—')} | ${shown || '—'}${vals.length > SHOWN ? ` … (${vals.length} in all)` : ''} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---- reading and writing ------------------------------------------------------------------------------------------------

/** Every source API: the hub's connections and the added sources, each with its stored map (if mapped yet). */
export async function sourceApis(): Promise<SourceApi[]> {
  await ensure();
  const [hub, stored] = await Promise.all([
    hubSources().catch(() => []),
    getDb().prepare(`SELECT connection, origin, connector, description, keys, tree, markdown, updated_by, updated_at FROM dh_source_apis`).all() as
      Promise<{ connection: string; origin: 'hub' | 'added'; connector: string; description: string; keys: unknown; tree: unknown; markdown: string | null; updated_by: string | null; updated_at: string | null }[]>,
  ]);
  const byName = new Map(stored.map(s => [s.connection, s]));
  const out: SourceApi[] = hub.map(h => {
    const s = byName.get(h.connection);
    return { connection: h.connection, origin: 'hub', connector: h.connector, description: s?.description ?? '', keys: h.keys,
      tree: (asJson(s?.tree) as DhNode[] | null) ?? [], markdown: s?.markdown ?? '', mapped: !!s?.markdown,
      updated_by: s?.updated_by ?? null, updated_at: s?.updated_at ? new Date(s.updated_at).toISOString() : null };
  });
  for (const s of stored) {
    if (s.origin !== 'added' || hub.some(h => h.connection === s.connection)) continue;
    out.push({ connection: s.connection, origin: 'added', connector: s.connector, description: s.description,
      keys: (asJson(s.keys) as SourceKeySpec[]) ?? [], tree: (asJson(s.tree) as DhNode[] | null) ?? [], markdown: s.markdown ?? '',
      mapped: !!s.markdown, updated_by: s.updated_by, updated_at: s.updated_at ? new Date(s.updated_at).toISOString() : null });
  }
  return out.sort((a, b) => a.connection.localeCompare(b.connection));
}

/** (Re)builds a source's map from what it offers now, and stores the map and its markdown. */
export async function mapSource(connection: string, by: string): Promise<SourceApi | string> {
  const api = (await sourceApis()).find(s => s.connection === connection);
  if (!api) return `no source called ${connection}`;
  const rec = api.origin === 'hub' ? await recorded(connection) : new Map() as Recorded;
  const at = new Date().toISOString();
  const tree = buildTree(connection, api.keys, rec);
  const markdown = buildMarkdown(api, api.keys, rec, at.slice(0, 16).replace('T', ' ') + ' UTC');
  await getDb().prepare(`INSERT INTO dh_source_apis (connection, origin, connector, description, keys, tree, markdown, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)
      ON CONFLICT (connection) DO UPDATE SET origin = EXCLUDED.origin, connector = EXCLUDED.connector, keys = EXCLUDED.keys,
        tree = EXCLUDED.tree, markdown = EXCLUDED.markdown, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(connection, api.origin, api.connector, api.description, JSON.stringify(api.keys), JSON.stringify(tree), markdown, by, at);
  return { ...api, tree, markdown, mapped: true, updated_by: by, updated_at: at };
}

/** One key per line: "<key> <path with {parameters}> [- description]". */
export function parseKeys(text: string): SourceKeySpec[] | string {
  const keys: SourceKeySpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+[-–—]\s*(.*))?$/) ?? line.match(/^(\S+)()$/);
    if (!m) return `can't read "${line.slice(0, 60)}": write <key> <path> - <description>`;
    const [, key, path, description] = m;
    if (!KEY.test(key)) return `"${key}" is not a key name (letters, digits, _ . -)`;
    if (keys.some(k => k.key === key)) return `${key} is listed twice`;
    const params = Object.fromEntries([...(path ?? '').matchAll(/\{([A-Za-z_]\w*)\}/g)].map(p => [p[1], 'str']));
    keys.push({ key, path: path ?? '', params, description: (description ?? '').trim().slice(0, 300) });
  }
  return keys.length ? keys : 'list at least one key';
}

/** Add source: registers a source API with its keys, then maps it (the map and its markdown are stored). */
export async function addSource(body: Record<string, unknown>, by: string): Promise<SourceApi | string> {
  const connection = String(body.connection ?? '').trim().toLowerCase();
  if (!NAME.test(connection)) return 'name: 2 to 40 lower-case letters, digits or _, starting with a letter';
  const keys = parseKeys(String(body.keys ?? ''));
  if (typeof keys === 'string') return keys;
  if ((await sourceApis()).some(s => s.connection === connection)) return `${connection} is already a source`;
  await getDb().prepare(`INSERT INTO dh_source_apis (connection, origin, connector, description, keys) VALUES (?, 'added', ?, ?, ?::jsonb)`)
    .run(connection, String(body.connector ?? '').trim().slice(0, 60), String(body.description ?? '').trim().slice(0, 300), JSON.stringify(keys));
  return mapSource(connection, by);
}

/** Removes an added source (hub sources stay: the hub owns them). */
export async function removeSource(connection: string): Promise<boolean> {
  await ensure();
  const r = await getDb().prepare(`DELETE FROM dh_source_apis WHERE connection = ? AND origin = 'added'`).run(connection);
  return r.changes > 0;
}

/** The stored markdown of a source's map, or null when it hasn't been mapped. */
export async function sourceMarkdown(connection: string): Promise<string | null> {
  await ensure();
  const r = await getDb().prepare(`SELECT markdown FROM dh_source_apis WHERE connection = ?`).get(connection) as { markdown: string | null } | undefined;
  return r?.markdown ?? null;
}
