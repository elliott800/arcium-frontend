// The Data Hub's source API keys (admin only). Each entry is an API name with its API key, an optional secret key and
// public key, and up to 100 account IDs. They are kept encrypted in the credentials table (AES-256-GCM,
// ARCIUM_SECRET_KEY, src/lib/secrets.ts); the Data Hub runs on the same server, reads the same database with the same
// key, and uses an entry when a connection's credentials reference is "credential:<id>"
// (hub_services/common/paths.py resolve_ref). Values never go back to the browser: only whether a key is set, and
// the end of each account ID (its last 8 characters, or 4 for a short one).
//
// An entry is stored as kind "datahub:<connector>" with its API name as the label. Besides api_key, secret_key,
// public_key and account_ids, it carries the field names its connector reads (account_id = the first account ID;
// OANDA's base_url and time zone; Webull's app_key and app_secret), so the hub can use it as it is.
// Credentials of other kinds that a Data Hub source already uses (a broker login) are listed read-only, and the
// settings-file references by name.

import { getDb } from '@/lib/db';
import { open as openSealed, seal, type Sealed } from '@/lib/secrets';
import { queue } from '@/lib/datahubSources';

export const MAX_ACCOUNTS = 100;

export interface SourceKey {
  id: string; name: string; connector: string; managed: boolean; used_by: string[]; updated_at: string;
  api_key: boolean; secret_key: boolean; public_key: boolean; accounts: string[];   // accounts: masked, in order
}
export interface KeysView { keys: SourceKey[]; settings_refs: { ref: string; used_by: string[] }[]; connectors: string[]; max_accounts: number }
type Payload = Record<string, unknown> & { api_key?: string; secret_key?: string; public_key?: string; account_ids?: string[] };

const NAME = /^[\w .:@()-]{2,60}$/;
const CONNECTOR = /^[a-z][a-z0-9_]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[\w.:@\-/]{1,80}$/;
const ref = (id: string) => `credential:${id}`;
const mask = (v: string) => (v.length > 10 ? `••••${v.slice(-8)}` : `••••${v.slice(-4)}`);   // enough to tell accounts apart
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

async function usage(): Promise<Map<string, string[]>> {
  const rows = await getDb().prepare(`SELECT credentials_ref AS r, connection_name AS c FROM wh_connections ORDER BY connection_name`).all() as { r: string; c: string }[];
  const m = new Map<string, string[]>();
  for (const x of rows) m.set(x.r, [...(m.get(x.r) ?? []), x.c]);
  return m;
}

/** An entry's parts, whatever field names it was stored with (a broker login uses app_key / app_secret). */
function parts(v: Payload) {
  return {
    api_key: str(v.api_key),
    secret_key: str(v.secret_key) || str(v.app_secret) || str(v.api_secret),
    public_key: str(v.public_key) || str(v.app_key),
    accounts: Array.isArray(v.account_ids) ? v.account_ids.map(str).filter(Boolean) : str(v.account_id) ? [str(v.account_id)] : [],
  };
}

/** The fields the Data Hub's connector reads, written beside the entry's own parts. */
async function forConnector(connector: string, v: Payload): Promise<Payload> {
  const out: Payload = { ...v };
  const accounts = v.account_ids ?? [];
  if (accounts.length) out.account_id = accounts[0]; else delete out.account_id;
  if (connector === 'oanda') {
    out.base_url = str(v.base_url) || 'https://api-fxpractice.oanda.com';   // practice accounts only
    out.timezone = str(v.timezone) || 'America/New_York';
  }
  if (connector === 'webull') {
    if (v.public_key || v.api_key) out.app_key = v.public_key || v.api_key; else delete out.app_key;
    if (v.secret_key) out.app_secret = v.secret_key; else delete out.app_secret;
    if (!out.token_dir) {   // the token folder the hub's Webull login already uses
      const r = await getDb().prepare(`SELECT ciphertext, iv, tag FROM credentials WHERE kind = 'broker' AND label LIKE 'webull:%' LIMIT 1`).get() as Sealed | undefined;
      try { if (r) { const t = str(openSealed<Payload>(r).token_dir); if (t) out.token_dir = t; } } catch { /* none */ }
    }
  }
  return out;
}

/** Every entry (values never included) and the settings-file references in use. */
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
    let v: Payload = {};
    try { v = openSealed<Payload>(r); } catch { /* unreadable: shown with nothing set */ }
    const p = parts(v);
    keys.push({
      id: r.id, name: r.label, connector: managed ? r.kind.slice('datahub:'.length) : (r.label.split(':')[0] || 'other'),
      managed, used_by: usedBy, updated_at: new Date(r.updated_at).toISOString(),
      api_key: !!p.api_key, secret_key: !!p.secret_key, public_key: !!p.public_key, accounts: p.accounts.map(mask),
    });
  }
  const settings_refs = [...used].filter(([r]) => !r.startsWith('credential:')).map(([r, c]) => ({ ref: r, used_by: c }));
  return { keys, settings_refs, connectors: [...new Set([...types.map(t => t.t), 'other'])], max_accounts: MAX_ACCOUNTS };
}

async function load(id: string): Promise<{ kind: string; label: string; v: Payload } | null> {
  if (!UUID.test(id)) return null;
  const r = await getDb().prepare(`SELECT kind, label, ciphertext, iv, tag FROM credentials WHERE id = ?`).get(id) as ({ kind: string; label: string } & Sealed) | undefined;
  return r ? { kind: r.kind, label: r.label, v: openSealed<Payload>(r) } : null;
}

async function store(id: string, connector: string, v: Payload): Promise<void> {
  const s = seal(await forConnector(connector, v));
  await getDb().prepare(`UPDATE credentials SET ciphertext = ?, iv = ?, tag = ?, updated_at = now() WHERE id = ?`).run(s.ciphertext, s.iv, s.tag, id);
}

/** Adds an API, or adds to one with the same name: given keys replace the stored ones, account IDs are appended. */
export async function saveKey(body: Record<string, unknown>, owner: string): Promise<string | { error: string }> {
  const name = str(body.name).trim();
  if (!NAME.test(name)) return { error: 'API name: 2 to 60 letters, digits, spaces or . : @ ( ) _ -' };
  const given = { api_key: str(body.api_key).trim(), secret_key: str(body.secret_key).trim(), public_key: str(body.public_key).trim() };
  if (Object.values(given).some(x => x.length > 2000)) return { error: 'a key is too long' };
  const accounts = (Array.isArray(body.account_ids) ? body.account_ids : str(body.account_ids).split(/[\n,]/)).map(a => str(a).trim()).filter(Boolean);
  const bad = accounts.find(a => !ACCOUNT.test(a));
  if (bad) return { error: `"${bad.slice(0, 30)}" is not an account ID (letters, digits and . : @ - / _)` };

  const db = getDb();
  const existing = await db.prepare(`SELECT id::text AS id, kind FROM credentials WHERE kind LIKE 'datahub:%' AND label = ?`).get(name) as { id: string; kind: string } | undefined;
  if (existing) {
    const cur = await load(existing.id);
    if (!cur) return { error: 'unknown key' };
    const v: Payload = { ...cur.v };
    for (const [k, x] of Object.entries(given)) if (x) v[k] = x;
    const all = [...new Set([...parts(cur.v).accounts, ...accounts])];
    if (all.length > MAX_ACCOUNTS) return { error: `an API can hold at most ${MAX_ACCOUNTS} account IDs (this would make ${all.length})` };
    if (!accounts.length && !Object.values(given).some(Boolean)) return { error: `${name} already exists: give a key or account IDs to add to it` };
    v.account_ids = all;
    await store(existing.id, existing.kind.slice('datahub:'.length), v);
    return existing.id;
  }

  const connector = str(body.connector).trim() || 'other';
  if (!CONNECTOR.test(connector)) return { error: 'choose the connector this API is for' };
  if (!given.api_key && !(given.public_key && given.secret_key)) return { error: 'give the API key (or a public and a secret key)' };
  const unique = [...new Set(accounts)];
  if (unique.length > MAX_ACCOUNTS) return { error: `an API can hold at most ${MAX_ACCOUNTS} account IDs` };
  const v: Payload = Object.fromEntries(Object.entries(given).filter(([, x]) => x));
  v.account_ids = unique;
  const s = seal(await forConnector(connector, v));
  const r = await db.prepare(`INSERT INTO credentials (owner_username, kind, label, ciphertext, iv, tag) VALUES (?, ?, ?, ?, ?, ?) RETURNING id::text AS id`)
    .get(owner, `datahub:${connector}`, name, s.ciphertext, s.iv, s.tag) as { id: string };
  return r.id;
}

/** Removes one part of an entry: its API key, secret key, public key, or one account ID (by position and its masked end). */
export async function removePart(body: Record<string, unknown>): Promise<true | string> {
  const id = str(body.id);
  const cur = await load(id);
  if (!cur || !cur.kind.startsWith('datahub:')) return 'only keys made on this page can be changed here';
  const usedBy = (await usage()).get(ref(id)) ?? [];
  const part = str(body.part);
  const v: Payload = { ...cur.v };
  if (part === 'api_key' || part === 'secret_key' || part === 'public_key') {
    const left = { ...parts(v), [part]: '' };
    if (usedBy.length && !left.api_key && !(left.public_key && left.secret_key))
      return `${usedBy.join(', ')} use${usedBy.length === 1 ? 's' : ''} this API: it needs an API key (or a public and a secret key)`;
    delete v[part];
    if (part === 'secret_key') delete v.app_secret;
    if (part === 'public_key') delete v.app_key;
  } else if (part === 'account') {
    const list = parts(v).accounts;
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length || mask(list[i]) !== str(body.masked)) return 'that account ID has changed: reload the page';
    list.splice(i, 1);
    v.account_ids = list;
  } else return 'unknown part';
  await store(id, cur.kind.slice('datahub:'.length), v);
  return true;
}

/** Deletes an entry made here, when no Data Hub source uses it. */
export async function deleteKey(id: string): Promise<true | string> {
  if (!UUID.test(id)) return 'unknown key';
  const used = (await usage()).get(ref(id)) ?? [];
  if (used.length) return `in use by ${used.join(', ')}: give those sources another key first`;
  const r = await getDb().prepare(`DELETE FROM credentials WHERE id = ? AND kind LIKE 'datahub:%'`).run(id);
  return r.changes ? true : 'only keys made on this page can be removed here';
}

/** Points a source at an entry: the hub's add_connection again with the same connector and the new reference. */
export async function assignKey(connection: string, id: string, by: string): Promise<number | string> {
  if (!UUID.test(id)) return 'unknown key';
  const db = getDb();
  if (!(await db.prepare(`SELECT 1 FROM credentials WHERE id = ?`).get(id))) return 'unknown key';
  const conn = await db.prepare(`SELECT connector_type, seed_id::text AS seed_id, seed_class, path_prefix, enabled FROM wh_connections WHERE connection_name = ?`)
    .get(connection) as { connector_type: string; seed_id: string | null; seed_class: string | null; path_prefix: string | null; enabled: boolean } | undefined;
  if (!conn) return `the hub has no source called ${connection}`;
  return queue('add_connection', {
    name: connection, type: conn.connector_type, credentials: ref(id), enabled: conn.enabled,
    ...(conn.seed_id ? { seed_id: conn.seed_id, seed_class: conn.seed_class } : {}),
    ...(conn.path_prefix ? { path_prefix: conn.path_prefix } : {}),
  }, by);
}
