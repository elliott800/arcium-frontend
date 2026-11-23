// The BrokerHub's broker API registry (brokerhub.arciumsignals.com, admin only). It matches the Data Hub's source
// registry: a broker is registered with a broker API connector (oanda, webull, sim ...), the API key entry it uses
// (src/lib/datahubKeys.ts, scope 'brokerhub': API key, secret and public keys, up to 100 account IDs), and the Arcium
// account it belongs to (the owner's Arcium Signals account or a sub-account). Registrations live in the site's table
// bh_brokers; keys stay encrypted in the credentials table.
//
// A broker's map is its connector's dictionary (contract/brokers.json, generated from the seed library's broker API
// classes by arcium_backend/controller/scripts/broker_dictionary.py): getters read (balance, positions, prices,
// orders) and return a value type; setters change something at the broker (orders, cancels, closes) with typed
// arguments.

import { getDb } from '@/lib/db';
import type { DhNode } from '@/lib/datahubTypes';
import dictionary from '../../contract/brokers.json';

export interface BrokerMethod { kind: 'getter' | 'setter'; args: Record<string, string>; returns: string; description: string }
export interface BrokerConnector { class: string; seed_file: string; description: string; methods: Record<string, BrokerMethod> }
export interface Broker {
  name: string; connector: string; credential_id: string | null; key_name: string | null; accounts: number;
  owner: string; description: string; created_by: string | null; updated_at: string;
}
export interface BrokerHubView {
  brokers: Broker[]; connectors: string[]; owners: { username: string; role: string; label: string }[];
  keys: { id: string; name: string; connector: string }[];
}

const CONNECTORS = (dictionary as { brokers: Record<string, BrokerConnector> }).brokers;
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const brokerConnectors = () => Object.keys(CONNECTORS).sort();
export const connectorOf = (c: string): BrokerConnector | undefined => CONNECTORS[c];

let ready: Promise<void> | null = null;
export function ensureBrokerTable(): Promise<void> {
  if (!ready) {
    ready = getDb().prepare(`CREATE TABLE IF NOT EXISTS bh_brokers (
      name text PRIMARY KEY, connector text NOT NULL, credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
      owner_username text NOT NULL, description text NOT NULL DEFAULT '', created_by text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`).run()
      .then(() => undefined).catch(e => { ready = null; throw e; });
  }
  return ready;
}

/** Arcium accounts a broker can belong to: the owner's (admin) and the sub-accounts; test-session users are left out. */
async function owners(): Promise<BrokerHubView['owners']> {
  const rows = await getDb().prepare(`SELECT username, coalesce(role, 'user') AS role FROM users
    WHERE username IS NOT NULL AND demo_expires_at IS NULL AND username <> 'demo_template' ORDER BY (role = 'admin') DESC, username`).all()
    .catch(() => getDb().prepare(`SELECT username, coalesce(role, 'user') AS role FROM users WHERE username IS NOT NULL ORDER BY username`).all()) as
    { username: string; role: string }[];
  return rows.map(r => ({ ...r, label: r.role === 'admin' ? `${r.username} (Arcium Signals account)` : `${r.username} (sub-account)` }));
}

export async function brokerHub(): Promise<BrokerHubView> {
  await ensureBrokerTable();
  const db = getDb();
  const [brokers, keys, people] = await Promise.all([
    db.prepare(`SELECT b.name, b.connector, b.credential_id::text AS credential_id, c.label AS key_name, b.owner_username AS owner,
                       b.description, b.created_by, b.updated_at
                FROM bh_brokers b LEFT JOIN credentials c ON c.id = b.credential_id ORDER BY b.name`).all() as
      Promise<(Omit<Broker, 'accounts' | 'updated_at'> & { updated_at: string })[]>,
    db.prepare(`SELECT id::text AS id, label AS name, kind FROM credentials WHERE kind LIKE 'brokerhub:%' OR kind = 'broker' ORDER BY label`).all() as
      Promise<{ id: string; name: string; kind: string }[]>,
    owners(),
  ]);
  const { listKeys } = await import('@/lib/datahubKeys');
  const counts = new Map((await listKeys('brokerhub', brokerConnectors())).keys.map(k => [k.id, k.accounts.length]));
  return {
    brokers: brokers.map(b => ({ ...b, accounts: b.credential_id ? counts.get(b.credential_id) ?? 0 : 0, updated_at: new Date(b.updated_at).toISOString() })),
    connectors: brokerConnectors(),
    owners: people,
    keys: keys.map(k => ({ id: k.id, name: k.name, connector: k.kind.startsWith('brokerhub:') ? k.kind.slice('brokerhub:'.length) : (k.name.split(':')[0] || 'broker') })),
  };
}

/** Registers a broker (or changes one with the same name): its connector, the API key entry it uses, and its account. */
export async function registerBroker(body: Record<string, unknown>, by: string): Promise<true | string> {
  await ensureBrokerTable();
  const name = String(body.name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return 'name: 2 to 40 lower-case letters, digits or _, starting with a letter';
  const connector = String(body.connector ?? '');
  if (!CONNECTORS[connector]) return `connector must be one of ${brokerConnectors().join(', ')}`;
  const credential = String(body.credential_id ?? '') || null;
  const db = getDb();
  if (credential && (!UUID.test(credential) || !(await db.prepare(`SELECT 1 FROM credentials WHERE id = ? AND (kind LIKE 'brokerhub:%' OR kind = 'broker')`).get(credential))))
    return 'choose one of the BrokerHub\'s API keys';
  const owner = String(body.owner ?? '');
  if (!(await owners()).some(o => o.username === owner)) return 'choose the Arcium account this broker belongs to';
  await db.prepare(`INSERT INTO bh_brokers (name, connector, credential_id, owner_username, description, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET connector = EXCLUDED.connector, credential_id = EXCLUDED.credential_id,
        owner_username = EXCLUDED.owner_username, description = EXCLUDED.description, updated_at = now()`)
    .run(name, connector, credential, owner, String(body.description ?? '').trim().slice(0, 300), by);
  return true;
}

export async function removeBroker(name: string): Promise<boolean> {
  await ensureBrokerTable();
  return (await getDb().prepare(`DELETE FROM bh_brokers WHERE name = ?`).run(name)).changes > 0;
}

const sig = (n: string, m: BrokerMethod) =>
  `${n}(${Object.entries(m.args).map(([a, t]) => `${a}: ${t}`).join(', ')})${m.kind === 'getter' ? ` -> ${m.returns}` : ''}`;

/** A connector's map as a drill tree: Getters and Setters, each method with its signature. */
export function brokerMapTree(prefix: string, connector: string): DhNode[] {
  const c = CONNECTORS[connector];
  if (!c) return [];
  return (['getter', 'setter'] as const).map(kind => {
    const ms = Object.entries(c.methods).filter(([, m]) => m.kind === kind).sort((a, b) => a[0].localeCompare(b[0]));
    return {
      id: `${prefix}/${kind}s`, label: kind === 'getter' ? 'Getters' : 'Setters', source: connector, tags: [], count: ms.length,
      contents: kind === 'getter' ? 'read from the broker; each returns the type after the arrow' : 'change something at the broker; arguments with their types',
      children: ms.map(([n, m]) => ({
        id: `${prefix}/${kind}s/${n}`, label: n, source: connector, tags: [], count: 1,
        format: kind === 'getter' ? `→ ${m.returns}` : 'setter', contents: [sig(n, m), m.description].filter(Boolean).join(' · '),
      })),
    };
  });
}

/** The broker map's markdown: the dictionary of its connector's getters and setters. */
export function brokerMarkdown(b: { name: string; connector: string; owner: string; key_name: string | null }): string {
  const c = CONNECTORS[b.connector];
  const lines = [`# ${b.name}: broker map`, '', `- Connector: ${b.connector}${c ? ` (${c.class}, ${c.seed_file})` : ''}`,
    `- Account: ${b.owner}`, `- API key: ${b.key_name ?? 'none yet'}`, `- Written: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  for (const kind of ['getter', 'setter'] as const) {
    lines.push(`## ${kind === 'getter' ? 'Getters' : 'Setters'}`, '', '```');
    for (const [n, m] of Object.entries(c?.methods ?? {}).filter(([, m]) => m.kind === kind).sort((a, b) => a[0].localeCompare(b[0])))
      lines.push(`${kind === 'getter' ? 'get' : 'set'} ${sig(n, m)}`);
    lines.push('```', '');
  }
  return lines.join('\n');
}
