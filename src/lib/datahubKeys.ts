// The Data Hub's source API keys (admin only): the API keys, account ids and other settings each source connector
// needs, kept encrypted in the credentials table (AES-256-GCM, ARCIUM_SECRET_KEY, src/lib/secrets.ts). The Data Hub
// runs on the same server, reads the same database with the same key, and uses one when a connection's credentials
// reference is "credential:<id>" (hub_services/common/paths.py resolve_ref). Values are written here and never sent
// back to the browser: only which fields are set, and the plain settings (base URL, time zone, folder, user agent).
//
// A key made here is stored as kind "datahub:<connector>" with its API name as the label. Credentials of other kinds
// that a Data Hub source already uses (a broker login) are listed too, and can be updated but not deleted here.
// Credentials kept in the Data Hub's settings file (references "hub.settings:<block>") are listed by name only.

import { getDb } from '@/lib/db';
import { open as openSealed, seal, type Sealed } from '@/lib/secrets';
import { queue } from '@/lib/datahubSources';

export interface KeyField { name: string; label: string; secret: boolean; required: boolean; placeholder?: string }
/** The fields each connector reads from its credentials (the Data Hub's settings blocks have the same shape). */
export const CONNECTOR_FIELDS: Record<string, KeyField[]> = {
  oanda: [
    { name: 'api_key', label: 'API key', secret: true, required: true },
    { name: 'account_id', label: 'Account ID', secret: true, required: true },
    { name: 'base_url', label: 'Base URL', secret: false, required: true, placeholder: 'https://api-fxpractice.oanda.com' },
    { name: 'timezone', label: 'Time zone', secret: false, required: false, placeholder: 'America/New_York' },
  ],
  webull: [
    { name: 'app_key', label: 'App key', secret: true, required: true },
    { name: 'app_secret', label: 'App secret', secret: true, required: true },
    { name: 'token_dir', label: 'Token folder (on the server)', secret: false, required: true, placeholder: '/var/www/datahub.arciumsignals.com/webull_token' },
  ],
  fred: [{ name: 'api_key', label: 'API key', secret: true, required: true }],
  edgar: [{ name: 'user_agent', label: 'User agent (name and contact email the SEC asks for)', secret: false, required: true, placeholder: 'Arcium Hub you@example.com' }],
  other: [
    { name: 'api_key', label: 'API key', secret: true, required: true },
    { name: 'account_id', label: 'Account ID', secret: true, required: false },
    { name: 'api_secret', label: 'API secret', secret: true, required: false },
    { name: 'base_url', label: 'Base URL', secret: false, required: false },
  ],
};
const fieldsFor = (connector: string) => CONNECTOR_FIELDS[connector] ?? CONNECTOR_FIELDS.other;

export interface SourceKey {
  id: string; name: string; connector: string; kind: string; managed: boolean;
  fields: { name: string; label: string; secret: boolean; set: boolean; value?: string }[];
  used_by: string[]; updated_at: string;
}
export interface KeysView { keys: SourceKey[]; settings_refs: { ref: string; used_by: string[] }[]; connectors: string[]; fields: Record<string, KeyField[]> }

const NAME = /^[\w .:@()-]{2,60}$/;
const CONNECTOR = /^[a-z][a-z0-9_]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ref = (id: string) => `credential:${id}`;

async function usage(): Promise<Map<string, string[]>> {
  const rows = await getDb().prepare(`SELECT credentials_ref AS r, connection_name AS c FROM wh_connections ORDER BY connection_name`).all() as { r: string; c: string }[];
  const m = new Map<string, string[]>();
  for (const x of rows) m.set(x.r, [...(m.get(x.r) ?? []), x.c]);
  return m;
}

/** Every Data Hub source key (values never included), and the settings-file references in use. */
export async function listKeys(): Promise<KeysView> {
  const used = await usage();
  const rows = await getDb().prepare(`SELECT id::text AS id, kind, label, ciphertext, iv, tag, updated_at FROM credentials ORDER BY label`).all() as
    ({ id: string; kind: string; label: string; updated_at: string } & Sealed)[];
  const types = await getDb().prepare(`SELECT DISTINCT connector_type AS t FROM wh_connections WHERE connector_type <> 'seed' ORDER BY 1`).all() as { t: string }[];
  const keys: SourceKey[] = [];
  for (const r of rows) {
    const managed = r.kind.startsWith('datahub:');
    const usedBy = used.get(ref(r.id)) ?? [];
    if (!managed && !usedBy.length) continue;   // other site credentials (broker logins for accounts) are not the Data Hub's
    let values: Record<string, unknown> = {};
    try { values = openSealed<Record<string, unknown>>(r); } catch { /* unreadable: shown with nothing set */ }
    const connector = managed ? r.kind.slice('datahub:'.length) : (r.label.split(':')[0] || 'other');
    const known = fieldsFor(connector);
    const names = [...new Set([...known.map(f => f.name), ...Object.keys(values)])];
    keys.push({
      id: r.id, name: r.label, connector, kind: r.kind, managed, used_by: usedBy, updated_at: new Date(r.updated_at).toISOString(),
      fields: names.map(n => {
        const f = known.find(k => k.name === n) ?? { name: n, label: n, secret: true, required: false };
        const v = values[n];
        const set = v !== undefined && v !== null && String(v) !== '';
        return { name: n, label: f.label, secret: f.secret, set, ...(set && !f.secret ? { value: String(v) } : {}) };
      }),
    });
  }
  const settings_refs = [...used].filter(([r]) => !r.startsWith('credential:')).map(([r, c]) => ({ ref: r, used_by: c }));
  return { keys, settings_refs, connectors: [...new Set([...types.map(t => t.t), 'other'])], fields: CONNECTOR_FIELDS };
}

/** Adds a key, or updates one (by id): fields left blank keep their stored value. Returns the credential id. */
export async function saveKey(body: Record<string, unknown>, owner: string): Promise<string | { error: string }> {
  const input = (body.fields ?? {}) as Record<string, unknown>;
  const clean: Record<string, string> = Object.fromEntries(Object.entries(input)
    .map(([k, v]): [string, string] => [k, String(v ?? '').trim()]).filter(([k, v]) => /^\w{1,40}$/.test(k) && v !== ''));
  if (Object.values(clean).some(v => v.length > 2000)) return { error: 'a value is too long' };
  const db = getDb();

  if (body.id) {
    const id = String(body.id);
    if (!UUID.test(id)) return { error: 'unknown key' };
    const row = await db.prepare(`SELECT kind, ciphertext, iv, tag FROM credentials WHERE id = ?`).get(id) as ({ kind: string } & Sealed) | undefined;
    if (!row) return { error: 'unknown key' };
    if (!row.kind.startsWith('datahub:') && !(await usage()).get(ref(id))?.length) return { error: 'that credential is not a Data Hub key' };
    const merged = { ...openSealed<Record<string, string>>(row), ...clean };
    const s = seal(merged);
    const name = body.name ? String(body.name).trim() : '';
    if (name && !NAME.test(name)) return { error: 'API name: 2 to 60 letters, digits, spaces or . : @ ( ) _ -' };
    await db.prepare(`UPDATE credentials SET ciphertext = ?, iv = ?, tag = ?, label = COALESCE(NULLIF(?, ''), label), updated_at = now() WHERE id = ?`)
      .run(s.ciphertext, s.iv, s.tag, row.kind.startsWith('datahub:') ? name : '', id);
    return id;
  }

  const name = String(body.name ?? '').trim();
  const connector = String(body.connector ?? '').trim();
  if (!NAME.test(name)) return { error: 'API name: 2 to 60 letters, digits, spaces or . : @ ( ) _ -' };
  if (!CONNECTOR.test(connector)) return { error: 'choose the connector this key is for' };
  const missing = fieldsFor(connector).filter(f => f.required && !clean[f.name]).map(f => f.label);
  if (missing.length) return { error: `fill in ${missing.join(', ')}` };
  const exists = await db.prepare(`SELECT 1 FROM credentials WHERE kind = ? AND label = ?`).get(`datahub:${connector}`, name);
  if (exists) return { error: `there is already a ${connector} key called ${name}` };
  const s = seal(clean);
  const r = await db.prepare(`INSERT INTO credentials (owner_username, kind, label, ciphertext, iv, tag) VALUES (?, ?, ?, ?, ?, ?) RETURNING id::text AS id`)
    .get(owner, `datahub:${connector}`, name, s.ciphertext, s.iv, s.tag) as { id: string };
  return r.id;
}

/** Deletes a key made here, when no Data Hub source uses it. */
export async function deleteKey(id: string): Promise<true | string> {
  if (!UUID.test(id)) return 'unknown key';
  const used = (await usage()).get(ref(id)) ?? [];
  if (used.length) return `in use by ${used.join(', ')}: give those sources another key first`;
  const r = await getDb().prepare(`DELETE FROM credentials WHERE id = ? AND kind LIKE 'datahub:%'`).run(id);
  return r.changes ? true : 'only keys made on this page can be deleted here';
}

/** Points a source at a key: the hub's add_connection again with the same connector and the new reference. */
export async function assignKey(connection: string, id: string, by: string): Promise<number | string> {
  if (!UUID.test(id)) return 'unknown key';
  const db = getDb();
  const key = await db.prepare(`SELECT 1 FROM credentials WHERE id = ?`).get(id);
  if (!key) return 'unknown key';
  const conn = await db.prepare(`SELECT connector_type, seed_id::text AS seed_id, seed_class, path_prefix, enabled FROM wh_connections WHERE connection_name = ?`)
    .get(connection) as { connector_type: string; seed_id: string | null; seed_class: string | null; path_prefix: string | null; enabled: boolean } | undefined;
  if (!conn) return `the hub has no source called ${connection}`;
  return queue('add_connection', {
    name: connection, type: conn.connector_type, credentials: ref(id), enabled: conn.enabled,
    ...(conn.seed_id ? { seed_id: conn.seed_id, seed_class: conn.seed_class } : {}),
    ...(conn.path_prefix ? { path_prefix: conn.path_prefix } : {}),
  }, by);
}
