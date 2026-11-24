// Who may read the Data Hub API (arcium_midend/api, the midend data API) and what they may read. The site owns these
// tables; the API only reads them:
//   dh_api_settings   key/value settings: 'guest_enabled' (the Data Hub center's guest switch; on until turned off)
//   dh_api_keys       an Arcium account's Data Hub keys: only the SHA-256 hash and the last 4 characters are kept
//   dh_products       the processed-data products (each a node of the Data Hub center's Subscriptions tree)
//   dh_subscriptions  an account's subscription to a product: requested -> active -> paused / ended
// Raw recorded data needs no subscription (a key reads all of it; guests read the source bundles). Processed data
// needs an active subscription. For now the owner activates subscriptions in the Data Hub center (source 'admin');
// later a Subscribe button will open Stripe Checkout and its webhook will write the same rows (source 'stripe', with
// the Stripe ids, price and period), so nothing here changes shape when payments arrive.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';

export const MAX_KEYS = 5;
export type SubStatus = 'requested' | 'active' | 'paused' | 'ended';
export interface DhProduct { id: string; name: string; description: string; kind: string; visible: boolean;
  price_cents: number | null; currency: string | null; interval: string | null }
export interface DhSub { username: string; product_id: string; status: SubStatus; source: string;
  requested_at: string | null; activated_at: string | null; ended_at: string | null; updated_by: string | null }
export interface DhKey { id: string; label: string; tail: string; created_at: string; last_used_at: string | null }

const DEFAULT_PRODUCTS: Omit<DhProduct, 'visible' | 'price_cents' | 'currency' | 'interval'>[] = [
  { id: 'data-capsules', name: 'Data capsules', kind: 'capsule',
    description: 'Source bundles packaged as point-in-time data capsules, ready for the Arcium engine and optimizer.' },
];

let ready: Promise<void> | null = null;
export function ensureAccessTables(): Promise<void> {
  if (!ready) {
    const db = getDb();
    ready = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_api_settings (key text PRIMARY KEY, value jsonb NOT NULL,
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_api_keys (id uuid PRIMARY KEY, username text NOT NULL,
        key_hash text NOT NULL UNIQUE, key_tail text NOT NULL, label text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz)`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_products (id text PRIMARY KEY, name text NOT NULL,
        description text NOT NULL DEFAULT '', kind text NOT NULL DEFAULT 'processed', visible boolean NOT NULL DEFAULT true,
        price_cents integer, currency text, interval text, sort integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now())`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS dh_subscriptions (username text NOT NULL, product_id text NOT NULL
        REFERENCES dh_products(id) ON DELETE CASCADE, status text NOT NULL, source text NOT NULL DEFAULT 'admin',
        stripe_subscription_id text, stripe_customer_id text, current_period_end timestamptz,
        requested_at timestamptz, activated_at timestamptz, ended_at timestamptz,
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (username, product_id))`).run();
      for (const p of DEFAULT_PRODUCTS) {
        await db.prepare(`INSERT INTO dh_products (id, name, description, kind) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
          .run(p.id, p.name, p.description, p.kind);
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

const iso = (t: unknown) => (t ? new Date(t as string).toISOString() : null);

// ── guest switch ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function guestEnabled(): Promise<boolean> {
  await ensureAccessTables();
  const row = await getDb().prepare(`SELECT value FROM dh_api_settings WHERE key = 'guest_enabled'`).get() as { value: unknown } | undefined;
  return row ? row.value === true || row.value === 'true' : true;
}

export async function setGuest(on: boolean, by: string): Promise<void> {
  await ensureAccessTables();
  await getDb().prepare(`INSERT INTO dh_api_settings (key, value, updated_by) VALUES ('guest_enabled', ?::jsonb, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`)
    .run(JSON.stringify(on), by);
}

/** A test session (the sign-in page's User button) or an unknown account: no keys or subscriptions, they would read
 *  or request real data. */
async function simulated(username: string): Promise<boolean> {
  const u = await getDb().prepare(`SELECT demo_expires_at FROM users WHERE username = ?`).get(username) as { demo_expires_at: string | null } | undefined;
  return !u || !!u.demo_expires_at;
}

// ── an account's keys ────────────────────────────────────────────────────────────────────────────────────────────────

export async function listKeys(username: string): Promise<DhKey[]> {
  await ensureAccessTables();
  const rows = await getDb().prepare(`SELECT id::text AS id, label, key_tail, created_at, last_used_at FROM dh_api_keys
    WHERE username = ? AND revoked_at IS NULL ORDER BY created_at`).all(username) as
    { id: string; label: string; key_tail: string; created_at: string; last_used_at: string | null }[];
  return rows.map(r => ({ id: r.id, label: r.label, tail: r.key_tail, created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at) }));
}

/** A new key for the account, returned once (only its hash is stored). Test sessions get none: keys read real data. */
export async function createKey(username: string, label: string): Promise<{ key: string } | string> {
  await ensureAccessTables();
  const db = getDb();
  if (await simulated(username)) return 'A simulated session cannot register a Data Hub key. Sign in with an Arcium account.';
  if ((await listKeys(username)).length >= MAX_KEYS) return `An account can hold ${MAX_KEYS} keys. Revoke one first.`;
  const key = `dhk_${randomBytes(32).toString('base64url')}`;
  await db.prepare(`INSERT INTO dh_api_keys (id, username, key_hash, key_tail, label) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), username, createHash('sha256').update(key).digest('hex'), key.slice(-4), label.trim().slice(0, 60));
  return { key };
}

export async function revokeKey(username: string, id: string): Promise<boolean> {
  await ensureAccessTables();
  return (await getDb().prepare(`UPDATE dh_api_keys SET revoked_at = now() WHERE id::text = ? AND username = ? AND revoked_at IS NULL`)
    .run(id, username)).changes > 0;
}

// ── products and subscriptions ───────────────────────────────────────────────────────────────────────────────────────

async function products(all: boolean): Promise<DhProduct[]> {
  await ensureAccessTables();
  return await getDb().prepare(`SELECT id, name, description, kind, visible, price_cents, currency, interval FROM dh_products
    ${all ? '' : 'WHERE visible'} ORDER BY sort, name`).all() as DhProduct[];
}

async function subs(where = '', ...args: unknown[]): Promise<DhSub[]> {
  const rows = await getDb().prepare(`SELECT username, product_id, status, source, requested_at, activated_at, ended_at, updated_by
    FROM dh_subscriptions ${where} ORDER BY product_id, username`).all(...args) as DhSub[];
  return rows.map(r => ({ ...r, requested_at: iso(r.requested_at), activated_at: iso(r.activated_at), ended_at: iso(r.ended_at) }));
}

/** The account's view: its keys, and each visible product as viewable (active) or restricted (with its request state). */
export async function accountView(username: string) {
  const [keys, prods] = await Promise.all([listKeys(username), products(false)]);
  const mine = new Map((await subs('WHERE username = ?', username)).map(s => [s.product_id, s]));
  return {
    keys, max_keys: MAX_KEYS,
    products: prods.map(p => {
      const s = mine.get(p.id);
      return { ...p, access: s?.status === 'active' ? 'viewable' : 'restricted', status: s?.status ?? null };
    }),
  };
}

/** Subscribe button (for now): asks the owner to activate. Later: opens Stripe Checkout for priced products. */
export async function requestSubscription(username: string, productId: string): Promise<true | string> {
  await ensureAccessTables();
  const p = (await products(false)).find(x => x.id === productId);
  if (!p) return 'No such product.';
  if (await simulated(username)) return 'A simulated session cannot subscribe. Sign in with an Arcium account.';
  const res = await getDb().prepare(`INSERT INTO dh_subscriptions (username, product_id, status, source, requested_at, updated_by)
    VALUES (?, ?, 'requested', 'admin', now(), ?)
    ON CONFLICT (username, product_id) DO UPDATE SET status = 'requested', requested_at = now(), updated_by = EXCLUDED.updated_by,
      updated_at = now() WHERE dh_subscriptions.status = 'ended'`).run(username, productId, username);
  return res.changes > 0 ? true : 'You already have this subscription or a request for it.';
}

export async function adminView() {
  const [guest, prods, all] = await Promise.all([guestEnabled(), products(true), subs()]);
  const accounts = await getDb().prepare(`SELECT username FROM users WHERE username IS NOT NULL AND demo_expires_at IS NULL
    AND username <> 'demo_template' ORDER BY username`).all() as { username: string }[];
  return { guest_enabled: guest, products: prods, subscriptions: all, accounts: accounts.map(a => a.username) };
}

/** The owner activates, pauses or ends an account's subscription (or starts one directly with 'active'). */
export async function setSubscription(username: string, productId: string, status: SubStatus, by: string): Promise<true | string> {
  await ensureAccessTables();
  if (!['active', 'paused', 'ended'].includes(status)) return 'status: active, paused or ended';
  if (!(await products(true)).some(p => p.id === productId)) return 'No such product.';
  if (!(await getDb().prepare(`SELECT 1 FROM users WHERE username = ?`).get(username))) return 'No such account.';
  await getDb().prepare(`INSERT INTO dh_subscriptions (username, product_id, status, source, activated_at, ended_at, updated_by)
    VALUES (?, ?, ?, 'admin', CASE WHEN ? = 'active' THEN now() END, CASE WHEN ? = 'ended' THEN now() END, ?)
    ON CONFLICT (username, product_id) DO UPDATE SET status = EXCLUDED.status,
      activated_at = CASE WHEN EXCLUDED.status = 'active' THEN now() ELSE dh_subscriptions.activated_at END,
      ended_at = CASE WHEN EXCLUDED.status = 'ended' THEN now() ELSE NULL END,
      updated_by = EXCLUDED.updated_by, updated_at = now()`).run(username, productId, status, status, status, by);
  return true;
}

const PRODUCT_ID = /^[a-z][a-z0-9-]{1,39}$/;
export async function saveProduct(body: Record<string, unknown>): Promise<true | string> {
  await ensureAccessTables();
  const id = String(body.id ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  if (!PRODUCT_ID.test(id)) return 'id: 2 to 40 lower-case letters, digits or -, starting with a letter';
  if (!name) return 'name is required';
  await getDb().prepare(`INSERT INTO dh_products (id, name, description, kind, visible) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, kind = EXCLUDED.kind,
      visible = EXCLUDED.visible`)
    .run(id, name.slice(0, 80), String(body.description ?? '').trim().slice(0, 300), String(body.kind ?? 'processed').trim().slice(0, 30) || 'processed',
      body.visible !== false);
  return true;
}

export async function removeProduct(id: string): Promise<true | string> {
  await ensureAccessTables();
  const active = await getDb().prepare(`SELECT count(*)::int AS n FROM dh_subscriptions WHERE product_id = ? AND status = 'active'`)
    .get(id) as { n: number };
  if (active.n) return `${active.n} active subscription(s): end them first.`;
  return (await getDb().prepare(`DELETE FROM dh_products WHERE id = ?`).run(id)).changes > 0 ? true : 'No such product.';
}
