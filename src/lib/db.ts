// ── Postgres connection + better-sqlite3-shaped compat shim ────────────────
//
// db.ts used to be a synchronous better-sqlite3 client. To keep the diff to
// callers minimal, `prepare(sql).run/get/all(...)` keeps the same calling
// convention (positional `?` args, or a single object for `@name` args) but
// is now async — every call site needs `await` on the terminal
// `.run()/.get()/.all()`, not on `getDb()` itself.

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { hasSecretKey, open as openSecret, seal, splitSecrets, type Sealed } from './secrets';
import { createSimPool, isSimUrl, seedSimulatedSystems, type SimPool } from './sim-db';

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function getPool(): Pool {
  const sim = isSimUrl(process.env.DATABASE_URL);
  if (!pool) {
    // sim:<folder> is the simulated backend (src/lib/sim-db.ts): same calls, an in-process database.
    pool = sim
      ? createSimPool(process.env.DATABASE_URL as string) as unknown as Pool
      : new Pool({ connectionString: process.env.DATABASE_URL });
  }
  if (!schemaReady) {
    // Capture the pool locally and pass it through explicitly — initSchema/
    // seedAdmin must NOT call getPool() themselves, since that would re-enter
    // this function before `schemaReady` is assigned (it's still being
    // computed on the right-hand side below) and recurse without end.
    const readyPool = pool;
    // A failed init must not be cached forever (every later query would
    // reject) — clear it so the next request retries.
    schemaReady = initSchema(readyPool).then(() => seedAdmin(readyPool))
      .then(() => sim ? seedSimulatedSystems(readyPool as unknown as SimPool) : undefined).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return pool;
}

export async function ensureReady(): Promise<void> {
  getPool();
  await schemaReady;
}

// Postgres expression that renders exactly like JS's `Date.prototype.toISOString()`
// (e.g. 2026-08-12T10:30:00.123Z), so timestamps stay comparable/sortable as
// plain TEXT whether they were written by SQL DEFAULT or by JS `new Date().toISOString()`.
const NOW_ISO = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function compile(sqlText: string, args: unknown[]): { text: string; values: unknown[] } {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const obj = args[0] as Record<string, unknown>;
    const values: unknown[] = [];
    const seen = new Map<string, number>();
    const text = sqlText.replace(/@(\w+)/g, (_, name: string) => {
      const existing = seen.get(name);
      if (existing) return `$${existing}`;
      values.push(obj[name]);
      const idx = values.length;
      seen.set(name, idx);
      return `$${idx}`;
    });
    return { text, values };
  }
  let i = 0;
  const text = sqlText.replace(/\?/g, () => `$${++i}`);
  return { text, values: args };
}

function prepare(sqlText: string) {
  return {
    async run(...args: unknown[]) {
      await ensureReady();
      const { text, values } = compile(sqlText, args);
      const res = await getPool().query(text, values);
      // better-sqlite3 always handed back the autoincrement id as
      // lastInsertRowid; Postgres only does with an explicit RETURNING
      // clause. Callers that need the new row's id add `RETURNING id` to
      // their SQL (see queuePendingScript) — harmless no-op otherwise.
      return { changes: res.rowCount ?? 0, lastInsertRowid: res.rows[0]?.id };
    },
    async get(...args: unknown[]) {
      await ensureReady();
      const { text, values } = compile(sqlText, args);
      const res = await getPool().query(text, values);
      return res.rows[0];
    },
    async all(...args: unknown[]) {
      await ensureReady();
      const { text, values } = compile(sqlText, args);
      const res = await getPool().query(text, values);
      return res.rows;
    },
  };
}

export function getDb() {
  getPool();
  return {
    prepare,
    async exec(sqlText: string) {
      await getPool().query(sqlText);
    },
  };
}

// ── Schema ───────────────────────────────────────────────────────────────

// Postgres' "CREATE EXTENSION/TABLE IF NOT EXISTS" isn't safe under true
// concurrency (the existence check and the insert aren't atomic), which bites
// in Next.js dev mode where Turbopack HMR module-reloads reset this module's
// `schemaReady` tracking on every edit, so overlapping requests can race two
// initSchema() runs against each other. Both attempts are trying to reach the
// same idempotent end state, so a duplicate-key/already-exists error here
// just means another run already did the work — safe to ignore.
function isBenignRaceError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  // 23505 duplicate key, 42710 duplicate object, 42P07 duplicate table,
  // 42704 undefined object (e.g. a concurrent DROP CONSTRAINT IF EXISTS
  // racing another connection's drop of the same constraint).
  return code === '23505' || code === '42710' || code === '42P07' || code === '42704';
}

// Serialized across every process/connection with an advisory lock: dev-mode
// module reloads and multiple server instances otherwise run overlapping
// migrations against each other.
async function initSchema(p: Pool): Promise<void> {
  const client = await p.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('arciumsignals:schema'))`);
    try {
      await runInitSchemaDDL(client as unknown as Pool);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('arciumsignals:schema'))`);
    }
  } finally {
    client.release();
  }
}

// Multiple machines can genuinely run the same-named silo independently
// (explicit product decision — see the multi-machine plan) — several sync
// tables originally keyed rows without `machine_name`, so a second machine
// pushing a same-named silo would silently overwrite the first machine's
// row instead of coexisting. `CREATE TABLE IF NOT EXISTS` above only
// applies to brand-new databases; this migrates a database that already has
// these tables from the old single-machine-implicit key to the new one.
// Safe to re-run every startup (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT
// IF EXISTS are both idempotent).
const MULTI_MACHINE_TABLES: Record<string, string[]> = {
  silo_registry: ['username', 'silo_key', 'machine_name'],
  folder_tree: ['username', 'node_id', 'machine_name'],
  catalog_models: ['username', 'catalog_source', 'model_name', 'model_type', 'machine_name'],
  catalog_signals: ['username', 'catalog_source', 'signal_name', 'data_rate', 'machine_name'],
  catalog_signal_stats: ['username', 'catalog_source', 'signal_name', 'instrument_name', 'data_rate', 'machine_name'],
  nav_blob: ['username', 'trader_name', 'silo_name', 'engine_kind', 'machine_name'],
  portfolio_blob: ['username', 'trader_name', 'silo_name', 'engine_kind', 'machine_name'],
  web_equity_curve: ['username', 'trader_name', 'silo_name', 'engine_kind', 'cycle_time', 'machine_name'],
  web_portfolio_allocs: ['username', 'trader_name', 'silo_name', 'engine_kind', 'instrument_name', 'machine_name'],
  web_balance_allocs: ['username', 'trader_name', 'silo_name', 'engine_kind', 'machine_name'],
};

// Server-side sessions, invites, encrypted credentials, and hashed machine
// keys — the portal used to trust a client-sent username and stored machine
// keys / broker credentials in plaintext.
async function migrateAuthSchema(p: Pool): Promise<void> {
  const statements = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS sessions (
       token_hash   text PRIMARY KEY,
       user_id      text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
       created_at   timestamptz NOT NULL DEFAULT now(),
       expires_at   timestamptz NOT NULL,
       last_seen_at timestamptz NOT NULL DEFAULT now(),
       user_agent   text
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
    `CREATE TABLE IF NOT EXISTS invites (
       token_hash text PRIMARY KEY,
       email      text NOT NULL,
       role       text NOT NULL DEFAULT 'user',
       created_by text,
       created_at timestamptz NOT NULL DEFAULT now(),
       expires_at timestamptz NOT NULL,
       used_at    timestamptz
     )`,
    `CREATE TABLE IF NOT EXISTS credentials (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_username text NOT NULL,
       kind           text NOT NULL,
       label          text NOT NULL,
       machine_name   text,
       ciphertext     text NOT NULL,
       iv             text NOT NULL,
       tag            text NOT NULL,
       created_at     timestamptz NOT NULL DEFAULT now(),
       updated_at     timestamptz NOT NULL DEFAULT now(),
       UNIQUE (owner_username, kind, label)
     )`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS api_key_hash text`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS registered_by text`,
    // Existing plaintext machine keys become hashes; the machine keeps using
    // the same key, the site just stops storing it readable.
    `UPDATE machines SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex'), api_key = NULL
       WHERE api_key IS NOT NULL AND api_key <> ''`,
  ];
  for (const sql of statements) {
    try {
      await p.query(sql);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

// Accounts: a user's trading account (broker + credentials + seed + data
// source) assigned to an optimization machine by load. The machine's
// heartbeat pulls its assignments and provisions silos/stacks for them.
async function migrateAccountsSchema(p: Pool): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS accounts (
       id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_username       text NOT NULL,
       name                 text NOT NULL,
       broker               text NOT NULL,
       broker_credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
       seed_id              uuid,
       data_connection      text,
       stack_rates          jsonb NOT NULL DEFAULT '[]',
       silo_name            text NOT NULL,
       machine_name         text,
       status               text NOT NULL DEFAULT 'pending',
       status_detail        text,
       paused               boolean NOT NULL DEFAULT false,
       removed              boolean NOT NULL DEFAULT false,
       created_at           timestamptz NOT NULL DEFAULT now(),
       updated_at           timestamptz NOT NULL DEFAULT now(),
       UNIQUE (owner_username, name)
     )`,
    `CREATE INDEX IF NOT EXISTS accounts_machine_idx ON accounts (machine_name)`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 4`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS accepts_accounts boolean NOT NULL DEFAULT true`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS load_json jsonb`,
    // the live controller's own status (launcher on the machine, every minute): commit, training, paused, processes
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS live_status jsonb`,
    `ALTER TABLE machines ADD COLUMN IF NOT EXISTS live_status_at timestamptz`,
  ];
  for (const sql of statements) {
    try {
      await p.query(sql);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

// ArciumAlarm phone app (see src/lib/alarm.ts): one row per signed-in phone. Like sessions,
// only the token's sha256 is stored; deleting the row signs that phone out.
async function migrateAlarmSchema(p: Pool): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS alarm_devices (
       token_hash   text PRIMARY KEY,
       user_id      text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
       label        text,
       created_at   timestamptz NOT NULL DEFAULT now(),
       last_used_at timestamptz NOT NULL DEFAULT now(),
       expires_at   timestamptz NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS alarm_devices_user_idx ON alarm_devices (user_id)`,
  ];
  for (const sql of statements) {
    try {
      await p.query(sql);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

// The owner's project schedule (/control/schedule): which tasks of src/lib/schedule-release1.json are
// done, and when. Tasks live in the JSON; only the ticks live here.
async function migrateScheduleSchema(p: Pool): Promise<void> {
  try {
    await p.query(`CREATE TABLE IF NOT EXISTS schedule_ticks (
       task_id    text PRIMARY KEY,
       done_on    date,          -- null: unticked (overrides a doneOn in the JSON)
       ticked_by  text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`);
  } catch (err) {
    if (!isBenignRaceError(err)) throw err;
  }
}

// Hub repositories (Data, Broker and Seed hubs; see src/lib/hubs.ts): git-like repos with
// immutable numbered versions. File contents are stored once per sha256 in hub_blobs.
async function migrateHubSchema(p: Pool): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS hub_repos (
       id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       hub               text NOT NULL CHECK (hub IN ('data', 'broker', 'seed')),
       owner_username    text NOT NULL,
       name              text NOT NULL,
       description       text NOT NULL DEFAULT '',
       visibility        text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
       code_visible      boolean NOT NULL DEFAULT true,
       published_version integer,
       created_at        text NOT NULL DEFAULT ${NOW_ISO},
       updated_at        text NOT NULL DEFAULT ${NOW_ISO},
       UNIQUE (hub, owner_username, name)
     )`,
    `CREATE TABLE IF NOT EXISTS hub_versions (
       repo_id      uuid NOT NULL REFERENCES hub_repos(id) ON DELETE CASCADE,
       number       integer NOT NULL,
       message      text NOT NULL DEFAULT '',
       author       text NOT NULL,
       created_at   text NOT NULL DEFAULT ${NOW_ISO},
       file_count   integer NOT NULL,
       total_bytes  bigint NOT NULL,
       review       text NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'pending', 'approved', 'rejected')),
       review_note  text,
       reviewed_by  text,
       reviewed_at  text,
       PRIMARY KEY (repo_id, number)
     )`,
    `CREATE TABLE IF NOT EXISTS hub_blobs (
       sha256  text PRIMARY KEY,
       size    integer NOT NULL,
       content bytea NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS hub_files (
       repo_id uuid NOT NULL,
       number  integer NOT NULL,
       path    text NOT NULL,
       sha256  text NOT NULL REFERENCES hub_blobs(sha256),
       size    integer NOT NULL,
       PRIMARY KEY (repo_id, number, path),
       FOREIGN KEY (repo_id, number) REFERENCES hub_versions(repo_id, number) ON DELETE CASCADE
     )`,
    `CREATE INDEX IF NOT EXISTS hub_versions_review_idx ON hub_versions (review) WHERE review = 'pending'`,
    `CREATE INDEX IF NOT EXISTS hub_files_sha_idx ON hub_files (sha256)`,
  ];
  for (const sql of statements) {
    try {
      await p.query(sql);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

// Usernames: people sign up with a chosen username (signing in with it or
// their email). It is the key every user-scoped table and machine workspace
// uses, so it is lowercase and identifier-safe (USERNAME_PATTERN). Existing
// accounts keep the part of their email before the @, which is what those
// tables already hold. Sign-up adds email verification and admin approval;
// accounts that predate them count as verified and approved.
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

async function migrateUsernameSchema(p: Pool): Promise<void> {
  const statements = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username text`,
    `UPDATE users SET username = lower(split_part(username_email, '@', 1)) WHERE username IS NULL`,
    `ALTER TABLE users ALTER COLUMN username SET NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval text`,
    `UPDATE users SET approval = 'approved', email_verified_at = COALESCE(email_verified_at, now())
       WHERE approval IS NULL`,
    `ALTER TABLE users ALTER COLUMN approval SET DEFAULT 'pending'`,
    `ALTER TABLE users ALTER COLUMN approval SET NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz`,
    // Demo test sessions: throwaway users deleted (with their rows) at this time.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_expires_at timestamptz`,
    // Single sign-on: an account is one person across the Arcium sites, matched by email or phone.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone) WHERE phone IS NOT NULL`,
    // One-time links: verify an email address, or reset a password.
    `CREATE TABLE IF NOT EXISTS auth_tokens (
       token_hash text PRIMARY KEY,
       user_id    text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
       purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
       created_at timestamptz NOT NULL DEFAULT now(),
       expires_at timestamptz NOT NULL,
       used_at    timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose)`,
    // Rows written while the key was the full email move to the username.
    `DELETE FROM user_preferences e USING user_preferences s
       WHERE e.username LIKE '%@%' AND s.username = split_part(e.username, '@', 1)`,
    `UPDATE user_preferences SET username = split_part(username, '@', 1) WHERE username LIKE '%@%'`,
    `UPDATE pending_scripts SET username = split_part(username, '@', 1) WHERE username LIKE '%@%'`,
  ];
  for (const sql of statements) {
    try {
      await p.query(sql);
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

const SECRET_PATTERN =`"(api_key|api_secret|api_token|access_token|account_id|password|secret|token)"\\s*:\\s*"[^"]+`;

// Broker credentials used to be stored in plaintext inside silo_registry
// settings JSON and pending_scripts flags. Move any still there into the
// encrypted credentials table and blank them. Idempotent; skipped (with a
// warning) until ARCIUM_SECRET_KEY is configured.
async function migratePlaintextSecrets(p: Pool): Promise<void> {
  if (!hasSecretKey()) {
    console.warn('[db] ARCIUM_SECRET_KEY not set — plaintext credential migration skipped');
    return;
  }
  const silos = await p.query(
    `SELECT username, silo_key, machine_name, person_name, silo_name, trader_settings, optimizer_settings
     FROM silo_registry WHERE trader_settings ~ $1 OR optimizer_settings ~ $1`, [SECRET_PATTERN]);
  for (const row of silos.rows) {
    const parsed = (t: string | null) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
    const trader = splitSecrets(parsed(row.trader_settings));
    const optimizer = splitSecrets(parsed(row.optimizer_settings));
    const secrets = { ...optimizer.secrets, ...trader.secrets };
    if (Object.keys(secrets).length) {
      await saveCredentialWith(p, row.person_name || stripEmail(row.username), 'broker',
        siloCredentialLabel(row.person_name, row.silo_name), row.machine_name, secrets);
    }
    await p.query(
      `UPDATE silo_registry SET trader_settings = $1, optimizer_settings = $2
       WHERE username = $3 AND silo_key = $4 AND machine_name = $5`,
      [row.trader_settings ? JSON.stringify(trader.clean) : row.trader_settings,
       row.optimizer_settings ? JSON.stringify(optimizer.clean) : row.optimizer_settings,
       row.username, row.silo_key, row.machine_name]);
  }
  const jobs = await p.query(`SELECT id, flags FROM pending_scripts WHERE flags::text ~ $1`,
    [SECRET_PATTERN.replace(/"/g, '\\\\?"')]);
  for (const job of jobs.rows) {
    // pending_scripts.flags is a TEXT column holding JSON.
    let parsedFlags: unknown;
    try { parsedFlags = typeof job.flags === 'string' ? JSON.parse(job.flags) : job.flags; } catch { continue; }
    const flags = splitSecrets(parsedFlags).clean;
    if (typeof flags.settings_json === 'string') {
      try { flags.settings_json = JSON.stringify(splitSecrets(JSON.parse(flags.settings_json)).clean); } catch {}
    }
    await p.query('UPDATE pending_scripts SET flags = $1 WHERE id = $2', [JSON.stringify(flags), job.id]);
  }
  if (silos.rows.length || jobs.rows.length) {
    console.info(`[db] moved plaintext credentials: ${silos.rows.length} silo rows, ${jobs.rows.length} queued jobs`);
  }
}

export function siloCredentialLabel(personName: string, siloName: string): string {
  return `silo:${personName}/${String(siloName).replace(/ /g, '_')}`;
}

type Queryable = { query: Pool['query'] };

async function saveCredentialWith(q: Queryable, owner: string, kind: string, label: string,
                                  machineName: string | null, secrets: Record<string, string>): Promise<string> {
  const existing = await q.query(
    'SELECT id, ciphertext, iv, tag FROM credentials WHERE owner_username = $1 AND kind = $2 AND label = $3',
    [owner, kind, label]);
  const merged = { ...(existing.rows[0] ? openSecret<Record<string, string>>(existing.rows[0] as Sealed) : {}), ...secrets };
  const s = seal(merged);
  const res = await q.query(`
    INSERT INTO credentials (owner_username, kind, label, machine_name, ciphertext, iv, tag)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (owner_username, kind, label) DO UPDATE SET
      machine_name = COALESCE(EXCLUDED.machine_name, credentials.machine_name),
      ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()
    RETURNING id`, [owner, kind, label, machineName, s.ciphertext, s.iv, s.tag]);
  return res.rows[0].id;
}

/** Store (merging into any existing) secrets for owner/kind/label; returns the credential id. */
export async function saveCredential(owner: string, kind: string, label: string,
                                     machineName: string | null, secrets: Record<string, string>): Promise<string> {
  await ensureReady();
  return saveCredentialWith(getPool(), owner, kind, label, machineName, secrets);
}

export async function getCredentialMeta(owner: string, kind: string, label: string):
    Promise<{ id: string; fields: string[] } | null> {
  await ensureReady();
  const r = await getPool().query(
    'SELECT id, ciphertext, iv, tag FROM credentials WHERE owner_username = $1 AND kind = $2 AND label = $3',
    [owner, kind, label]);
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, fields: Object.keys(openSecret<Record<string, string>>(r.rows[0] as Sealed)) };
}

/** Decrypted secrets for a machine — only when the credential is bound to that machine. */
export async function getCredentialForMachine(id: string, machineName: string): Promise<Record<string, string> | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  await ensureReady();
  const r = await getPool().query(
    'SELECT ciphertext, iv, tag FROM credentials WHERE id = $1 AND machine_name = $2', [id, machineName]);
  return r.rows[0] ? openSecret<Record<string, string>>(r.rows[0] as Sealed) : null;
}

async function migrateMultiMachineKeys(p: Pool): Promise<void> {
  for (const [table, pkCols] of Object.entries(MULTI_MACHINE_TABLES)) {
    try {
      await p.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS machine_name text`);
      await p.query(`UPDATE ${table} SET machine_name = 'arcium_machine' WHERE machine_name IS NULL`);
      await p.query(`ALTER TABLE ${table} ALTER COLUMN machine_name SET NOT NULL`);
      await p.query(`ALTER TABLE ${table} ALTER COLUMN machine_name SET DEFAULT 'arcium_machine'`);
      // Rebuild the primary key only when it differs from the target.
      const cur = await p.query(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`, [table]);
      const have = ((cur.rows[0]?.cols as string[] | null) ?? []).join(',');
      if (have !== [...pkCols].sort().join(',')) {
        await p.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
        await p.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${pkCols.join(', ')})`);
      }
    } catch (err) {
      if (!isBenignRaceError(err)) throw err;
    }
  }
}

async function runInitSchemaDDL(p: Pool): Promise<void> {
  await p.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      table_id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id            text    NOT NULL UNIQUE,
      username_email     text    NOT NULL UNIQUE,
      created_at          text    NOT NULL DEFAULT (${NOW_ISO}),
      last_login          text,
      active              integer NOT NULL DEFAULT 1,
      type_of_subscriber  text    NOT NULL DEFAULT 'free',
      role                text    NOT NULL DEFAULT 'user',
      password_hash       text,
      model_favorites_json text
    );

    CREATE TABLE IF NOT EXISTS payments (
      payment_id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id              text    NOT NULL,
      stripe_payment_id    text    UNIQUE,
      stripe_customer_id   text,
      amount               integer NOT NULL,
      currency             text    NOT NULL DEFAULT 'usd',
      status                text    NOT NULL DEFAULT 'pending',
      product_id            text,
      plan_label            text,
      description            text,
      days_paid              integer,
      day_paid                text,
      scheduled                integer NOT NULL DEFAULT 0,
      calendly_event_id        text,
      created_at                text    NOT NULL DEFAULT (${NOW_ISO}),
      updated_at                text    NOT NULL DEFAULT (${NOW_ISO}),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS machines (
      machine_id     integer UNIQUE,
      machine_name   text PRIMARY KEY,
      hostname       text,
      platform       text,
      silo_db_dir    text,
      last_heartbeat text,
      registered_at  text,
      dir_tree       text,
      api_key        text
    );

    CREATE TABLE IF NOT EXISTS silo_registry (
      username           text NOT NULL,
      silo_key            text NOT NULL,
      person_name          text NOT NULL,
      silo_name             text NOT NULL,
      machine_name           text NOT NULL DEFAULT 'arcium_machine',
      status                  text DEFAULT 'active',
      has_stacks               integer DEFAULT 0,
      stack_rates               text DEFAULT '[]',
      built_rates                 text DEFAULT '[]',
      catalog_db                   text,
      engine_sim_db                  text,
      engine_live_db                   text,
      last_synced                       text,
      trader_settings                     text,
      optimizer_settings                    text,
      PRIMARY KEY (username, silo_key, machine_name)
    );

    CREATE TABLE IF NOT EXISTS folder_tree (
      username       text NOT NULL,
      node_id        text NOT NULL,
      parent_id      text,
      node_type      text NOT NULL,
      rel_path       text NOT NULL,
      label          text NOT NULL,
      person_name    text,
      silo_name      text,
      data_rate      text,
      exists_on_disk integer DEFAULT 1,
      machine_name   text NOT NULL DEFAULT 'arcium_machine',
      synced_at      text,
      PRIMARY KEY (username, node_id, machine_name)
    );

    CREATE TABLE IF NOT EXISTS catalog_models (
      username        text NOT NULL,
      machine_name    text NOT NULL DEFAULT 'arcium_machine',
      catalog_source  text NOT NULL,
      model_name      text NOT NULL,
      model_type      text NOT NULL,
      data_rate       text,
      instrument_name text,
      oos_sr          double precision,
      oos_accuracy    double precision,
      use_flag        integer,
      off_flag        integer,
      synced_at       text,
      PRIMARY KEY (username, catalog_source, model_name, model_type, machine_name)
    );

    CREATE TABLE IF NOT EXISTS catalog_signals (
      username             text NOT NULL,
      machine_name         text NOT NULL DEFAULT 'arcium_machine',
      catalog_source       text NOT NULL,
      signal_name          text NOT NULL,
      data_rate            text NOT NULL,
      type                 text,
      instruments_json     text,
      oos_sr               double precision,
      ins_sr               double precision,
      oos_n_trades         integer,
      ins_n_trades         integer,
      oos_confidence_level double precision,
      ins_confidence_level double precision,
      tuw                  double precision,
      max_dd               double precision,
      use_flag             integer,
      off_flag             integer,
      blob_hash            text,
      current_sharpe       double precision,
      constructor_ref      text,
      synced_at            text,
      PRIMARY KEY (username, catalog_source, signal_name, data_rate, machine_name)
    );

    CREATE TABLE IF NOT EXISTS catalog_signal_stats (
      username              text NOT NULL,
      machine_name          text NOT NULL DEFAULT 'arcium_machine',
      machine_id            integer,
      catalog_source        text NOT NULL,
      signal_name           text NOT NULL,
      instrument_name       text NOT NULL,
      instruments           text,
      data_rate             text,
      type                  text,
      created_at            text,
      run_time              double precision,
      deg_free_ratio        double precision,
      ins_sr                double precision,
      oos_sr                double precision,
      current_sharpe        double precision,
      min_sharpe            double precision,
      oos_sharpe_history    text,
      ins_accuracy          double precision,
      oos_accuracy          double precision,
      ins_profit_factor     double precision,
      oos_profit_factor     double precision,
      tuw                   double precision,
      max_dd                double precision,
      ins_n_trades          integer,
      oos_n_trades          integer,
      ins_trades_per_day    double precision,
      oos_trades_per_day    double precision,
      ins_mean_trade_pnl    double precision,
      oos_mean_trade_pnl    double precision,
      ins_start             text,
      ins_end               text,
      last_scored           text,
      ga_build_counter      integer,
      ins_confidence_level  double precision,
      oos_confidence_level  double precision,
      use_flag              integer,
      off_flag              integer,
      tags                  text,
      blob_hash             text,
      constructor_ref       text,
      synced_at             text,
      PRIMARY KEY (username, catalog_source, signal_name, instrument_name, data_rate, machine_name)
    );

    CREATE TABLE IF NOT EXISTS nav_blob (
      username       text NOT NULL,
      trader_name    text NOT NULL,
      silo_name      text NOT NULL,
      engine_kind    text NOT NULL,
      machine_name   text NOT NULL DEFAULT 'arcium_machine',
      machine_id     integer,
      synced_at      text NOT NULL,
      first_cycle    text,
      last_cycle     text,
      n_rows         integer,
      nav_data       text NOT NULL,
      PRIMARY KEY (username, trader_name, silo_name, engine_kind, machine_name)
    );

    CREATE TABLE IF NOT EXISTS portfolio_blob (
      username       text NOT NULL,
      trader_name    text NOT NULL,
      silo_name      text NOT NULL,
      engine_kind    text NOT NULL,
      machine_name   text NOT NULL DEFAULT 'arcium_machine',
      machine_id     integer,
      synced_at      text NOT NULL,
      last_cycle     text,
      n_instruments  integer,
      portfolio_data text NOT NULL,
      PRIMARY KEY (username, trader_name, silo_name, engine_kind, machine_name)
    );

    CREATE TABLE IF NOT EXISTS workspace_folders (
      username            text NOT NULL,
      machine_name        text NOT NULL,
      silo_manager_folder text NOT NULL,
      synced_at           text NOT NULL,
      PRIMARY KEY (username, machine_name)
    );

    CREATE TABLE IF NOT EXISTS silo_managers (
      folder_name  text NOT NULL,
      machine_name text NOT NULL,
      folder_json  text NOT NULL,
      synced_at    text NOT NULL,
      PRIMARY KEY (folder_name, machine_name)
    );

    CREATE TABLE IF NOT EXISTS pending_scripts (
      id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      machine_name text    NOT NULL,
      username     text,
      script_path  text    NOT NULL,
      flags        text    DEFAULT '{}',
      status       text    DEFAULT 'pending',
      priority     integer DEFAULT 0,
      created_at   text    NOT NULL,
      claimed_at   text,
      started_at   text,
      completed_at text,
      pid          integer,
      exit_code    integer,
      output       text,
      error        text
    );

    CREATE TABLE IF NOT EXISTS script_catalog (
      script_id    text NOT NULL,
      username     text NOT NULL,
      script_path  text NOT NULL,
      label        text NOT NULL,
      description  text,
      category     text NOT NULL,
      flags_schema text DEFAULT '{}',
      PRIMARY KEY (script_id, username)
    );

    CREATE TABLE IF NOT EXISTS processes (
      id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      machine_id       integer,
      machine_name     text NOT NULL,
      username         text,
      process_name     text NOT NULL,
      pid              integer,
      status           text,
      started_at       text,
      stopped_at       text,
      cmdline_summary  text
    );

    CREATE TABLE IF NOT EXISTS script_handler (
      command     text PRIMARY KEY,
      script_path text NOT NULL,
      description text,
      created_at  text NOT NULL DEFAULT (${NOW_ISO}),
      updated_at  text NOT NULL DEFAULT (${NOW_ISO})
    );

    CREATE TABLE IF NOT EXISTS watchlists (
      username         text NOT NULL,
      watchlist_name   text NOT NULL,
      instrument_names text NOT NULL,
      catalog_source   text,
      data_rate        text,
      tags             text,
      created_at       text NOT NULL DEFAULT (${NOW_ISO}),
      PRIMARY KEY (username, watchlist_name)
    );

    CREATE TABLE IF NOT EXISTS user_model_catalog (
      username        text NOT NULL,
      model_hash      text NOT NULL,
      catalog_source  text,
      model_name      text,
      model_type      text,
      instrument_name text NOT NULL DEFAULT '',
      instruments     text,
      data_rate       text NOT NULL DEFAULT '',
      stats_json      text NOT NULL,
      source_table    text,
      synced_at       text,
      created_at      text NOT NULL DEFAULT (${NOW_ISO}),
      updated_at      text NOT NULL DEFAULT (${NOW_ISO}),
      PRIMARY KEY (username, model_hash, instrument_name, data_rate)
    );

    CREATE TABLE IF NOT EXISTS web_equity_curve (
      username          text NOT NULL,
      machine_name      text NOT NULL DEFAULT 'arcium_machine',
      trader_name       text NOT NULL,
      silo_name         text NOT NULL,
      engine_kind       text NOT NULL,
      cycle_time        text NOT NULL,
      balance           double precision,
      equity            double precision,
      unrealised_pnl    double precision,
      margin_used       double precision,
      pnl               double precision,
      ingest_ts         text,
      PRIMARY KEY (username, trader_name, silo_name, engine_kind, cycle_time, machine_name)
    );

    CREATE TABLE IF NOT EXISTS web_portfolio_allocs (
      username          text NOT NULL,
      machine_name      text NOT NULL DEFAULT 'arcium_machine',
      trader_name       text NOT NULL,
      silo_name         text NOT NULL,
      engine_kind       text NOT NULL,
      instrument_name   text NOT NULL,
      last_close_price  double precision,
      vol_weight        double precision,
      fitness_weight    double precision,
      tot_weight        double precision,
      inventory         double precision,
      ingest_ts         text,
      PRIMARY KEY (username, trader_name, silo_name, engine_kind, instrument_name, machine_name)
    );

    CREATE TABLE IF NOT EXISTS web_balance_allocs (
      username                     text NOT NULL,
      machine_name                 text NOT NULL DEFAULT 'arcium_machine',
      trader_name                  text NOT NULL,
      silo_name                    text NOT NULL,
      engine_kind                  text NOT NULL,
      weight                       double precision,
      max_allocation               double precision,
      base_currency_allocation     double precision,
      leveraged_base_currency      double precision,
      margin_used                  double precision,
      max_leverage                 double precision,
      ingest_ts                    text,
      PRIMARY KEY (username, trader_name, silo_name, engine_kind, machine_name)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      username         text PRIMARY KEY,
      preferences_json text NOT NULL DEFAULT '{}'
    );

    -- Seeds live in wh_seeds / wh_seed_uploads (hub_services/common/schema.sql).
  `);

  await migrateMultiMachineKeys(p);
  await migrateAuthSchema(p);
  await migrateUsernameSchema(p);
  await migrateAccountsSchema(p);
  await migrateHubSchema(p);
  await migrateAlarmSchema(p);
  await migrateScheduleSchema(p);
  try {
    await migratePlaintextSecrets(p);
  } catch (err) {
    console.error('[db] plaintext credential migration failed (site continues):', err);
  }

  // Seed script_handler with default command → script_path mappings
  // (ON CONFLICT DO NOTHING preserves any hand-edited rows)
  const handlers: [string, string, string][] = [
    ['make_empty_silo',      'manager/primary/make_empty_silo.py',      'Create bare silo from frozen zip'],
    ['create_silo',          'manager/primary/create_silo.py',           'Create silo with optional seed'],
    ['create_user_folder',   'manager/primary/create_user_folder.py',    'Create a user workspace folder'],
    ['collect_seed',         'manager/primary/collect_seed.py',          'Collect a silo into a reusable seed'],
    ['select_seed',          'manager/primary/select_seed.py',           'Plant a seed into a silo'],
    ['remove_silo',          'manager/primary/remove_silo.py',           'Delete silo folder and registry entry'],
    ['delete_silo',          'manager/primary/delete_silo.py',           'Delete a silo via manager script'],
    ['add_stack',            'manager/primary/add_stack.py',             'Add a data-rate stack to a silo'],
    ['create_stack',         'manager/primary/create_stack.py',          'Add a stack rate period to a silo'],
    ['remove_stack',         'manager/primary/remove_stack.py',          'Remove a stack rate period'],
    ['start_engine',         'manager/primary/start_engine.py',          'Start trade engine for a silo'],
    ['run_simulation',       'controller/scripts/run_simulation.py',     'Run finite simulation and sync engine results'],
    ['stop_engine',          'manager/primary/stop_engine.py',           'Stop trade engine for a silo'],
    ['link_silos',           'manager/primary/link_silos.py',            'Start engines (all or single silo)'],
    ['silo_manager',         'manager/primary/silo_manager.py',          'Silo manager daemon'],
    ['full_optimizer',       'manager/primary/full_optimizer.py',        'Run full signal search and catalog build'],
    ['full_optimizer_reg',   'manager/primary/full_optimizer_reg.py',    'Full optimizer regression run'],
    ['kill_switch',          'manager/primary/kill_switch.py',           'Emergency stop all live engines'],
    ['kill_processes',       'controller/scripts/kill_processes.py',     'Kill processes by name or PID'],
    ['promote_models',       'controller/scripts/promote_models.py',      'Promote selected catalog models into sim/live engine tables'],
    ['add_model_to_silo',   'controller/scripts/add_model_to_silo.py',   'Add a model hash to a silo engine model table'],
    ['remove_model_from_silo', 'controller/scripts/remove_model_from_silo.py', 'Remove a model hash from a silo engine model table'],
    ['update_theta_settings', 'controller/scripts/update_theta_settings.py', 'Sync theta across all trader settings'],
    ['update_silo_settings', 'controller/scripts/update_silo_settings.py', 'Write a silo trader/optimizer settings file and propagate to stacks'],
    ['update_seed_content', 'controller/scripts/update_seed_content.py', 'Upload files into a silo seed subfolder'],
    ['apply_watchlist',     'controller/scripts/apply_watchlist.py',      'Apply a watchlist of instruments as the engine portfolio'],
    ['build_silo',           'manager/utlities/build_silo.py',           'Build silos from seed folders'],
    ['sync_silo',            'manager/utlities/sync_silo.py',            'Sync seed/silo files and analyze results'],
    ['reset_catalogs',       'manager/utlities/reset_catalogs.py',       'Reset or inspect silo catalogs'],
    ['update_all_models',    'manager/utlities/update_all_models.py',    'Update model tables across silos'],
    ['start_link_silos',     'controller/scripts/start_link_silos.py',   'Start link_silos service'],
    ['start_optimizer',      'controller/scripts/start_optimizer.py',    'Start full optimizer process'],
    ['machine_agent',        'manager/primary/machine_agent.py',         'Machine agent daemon'],
    ['plant_all',            'manager/primary/plant_all.py',             'Plant all seeds into silos'],
    ['pull_workbooks',       'manager/primary/pull_workbooks.py',        'Pull workbooks from remote'],
    ['push_workbooks',       'manager/primary/push_workbooks.py',        'Push workbooks to remote'],
    ['migrate_db',           'manager/primary/migrate_db.py',            'Run DB migrations'],
    ['suite_regression_test','manager/primary/suite_regression_test.py', 'Run full regression suite'],
  ];
  for (const [command, script_path, description] of handlers) {
    await p.query(
      `INSERT INTO script_handler (command, script_path, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (command) DO NOTHING`,
      [command, script_path, description]
    );
  }
}

// The owner's admin account. Created on a fresh database only when
// ARCIUM_ADMIN_PASSWORD is set (first boot of a new server or the demo
// database) — never with a default password, since the site is public.
// An existing account is left alone apart from keeping its admin role.
// The owner's address comes from ARCIUM_ADMIN_EMAIL only (the server's env), never from this code.
const OWNER_EMAIL = (process.env.ARCIUM_ADMIN_EMAIL ?? '').trim();

async function seedAdmin(p: Pool): Promise<void> {
  if (!OWNER_EMAIL) {
    console.warn('[db] ARCIUM_ADMIN_EMAIL is not set: the owner account is not created or checked');
    return;
  }
  const existing = await p.query('SELECT password_hash FROM users WHERE username_email = $1', [OWNER_EMAIL]);
  if (existing.rows.length === 0) {
    const pw = process.env.ARCIUM_ADMIN_PASSWORD;
    if (!pw) {
      console.warn(`[db] no admin account (${OWNER_EMAIL}); set ARCIUM_ADMIN_PASSWORD once to create it`);
      return;
    }
    await p.query(
      `INSERT INTO users (user_id, username, username_email, created_at, last_login, active, type_of_subscriber, role,
                          password_hash, email_verified_at, approval, approved_at)
       VALUES ($1, $2, $3, ${NOW_ISO}, ${NOW_ISO}, 1, 'admin', 'admin', $4, now(), 'approved', now())
       ON CONFLICT DO NOTHING`,
      ['admin-001', OWNER_EMAIL.split('@')[0].toLowerCase(), OWNER_EMAIL, bcrypt.hashSync(pw, 10)]
    );
    return;
  }
  await p.query(`UPDATE users SET role = 'admin' WHERE username_email = $1 AND (role IS NULL OR role = 'user')`, [OWNER_EMAIL]);
  // An account still on the old public bootstrap password must change it.
  const hash = existing.rows[0]?.password_hash;
  if (!hash || bcrypt.compareSync('admin', hash)) {
    await p.query('UPDATE users SET must_reset_password = true WHERE username_email = $1', [OWNER_EMAIL]);
  }
}

export function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, 10);
}

export function verifyPassword(plaintext: string, hash: string): boolean {
  return bcrypt.compareSync(plaintext, hash);
}

export async function getUserByEmail(email: string) {
  return getDb().prepare('SELECT * FROM users WHERE username_email = ?').get(email);
}

export async function getAllUsersWithRecentPayment() {
  return getDb().prepare(`
    SELECT
      u.user_id,
      u.username_email,
      u.type_of_subscriber,
      u.role,
      p.product_id   AS recent_product_id,
      p.plan_label   AS recent_plan_label,
      p.amount       AS recent_amount,
      p.currency     AS recent_currency,
      p.created_at   AS recent_payment_date
    FROM users u
    LEFT JOIN payments p ON p.payment_id = (
      SELECT payment_id FROM payments
      WHERE user_id = u.user_id
      ORDER BY created_at DESC
      LIMIT 1
    )
    ORDER BY u.username_email ASC
  `).all();
}

export async function getPaymentsByUserId(userId: string) {
  return getDb().prepare(`
    SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

export async function getSchedulablePayment(userId: string, productId: string) {
  return getDb().prepare(`
    SELECT * FROM payments
    WHERE user_id = ? AND product_id = ? AND status = 'completed' AND scheduled = 0
    LIMIT 1
  `).get(userId, productId);
}

export async function markPaymentScheduled(paymentId: number, calendlyEventId?: string) {
  return getDb().prepare(`
    UPDATE payments
    SET scheduled = 1, calendly_event_id = ?, updated_at = ?
    WHERE payment_id = ?
  `).run(calendlyEventId ?? null, new Date().toISOString(), paymentId);
}

// ── Controller sync ──────────────────────────────────────────────────────────

export async function upsertMachineHeartbeat(data: {
  machine_name: string;
  machine_id?: number;
  hostname?: string;
  platform?: string;
  silo_db_dir?: string;
  last_heartbeat: string;
  registered_at?: string;
  load_json?: string | null;
}) {
  await getDb().prepare(`
    INSERT INTO machines (machine_name, machine_id, hostname, platform, silo_db_dir, last_heartbeat, registered_at, load_json)
    VALUES (@machine_name, @machine_id, @hostname, @platform, @silo_db_dir, @last_heartbeat, @registered_at, @load_json)
    ON CONFLICT(machine_name) DO UPDATE SET
      machine_id     = excluded.machine_id,
      hostname       = excluded.hostname,
      platform       = excluded.platform,
      silo_db_dir    = excluded.silo_db_dir,
      last_heartbeat = excluded.last_heartbeat,
      load_json      = COALESCE(excluded.load_json, machines.load_json)
  `).run({
    machine_id: null, hostname: null, platform: null,
    silo_db_dir: null, registered_at: null, load_json: null,
    ...data,
  });
}

export async function getMachines() {
  return getDb().prepare(`
    SELECT machine_id, machine_name, hostname, platform, silo_db_dir, last_heartbeat,
           registered_at, registered_by, dir_tree, (api_key_hash IS NOT NULL) AS registered,
           capacity, accepts_accounts, load_json, live_status, live_status_at,
           (SELECT count(*)::int FROM accounts a WHERE a.machine_name = machines.machine_name AND NOT a.removed) AS account_count
    FROM machines ORDER BY machine_name
  `).all();
}

export async function setMachineCapacity(machineName: string, capacity: number, acceptsAccounts: boolean): Promise<boolean> {
  const r = await getDb().prepare(
    'UPDATE machines SET capacity = ?, accepts_accounts = ? WHERE machine_name = ? RETURNING machine_name'
  ).get(capacity, acceptsAccounts, machineName);
  return Boolean(r);
}

// ── Machine auth + command queue (single Next.js sync proxy) ──────────────────
//
// Replaces the old MACHINE_API_URL/FastAPI control server and the crusty
// web_push/web_pull/ingest.php protocol: machines authenticate with a per-
// machine API key and push data / poll for queued commands, they are never
// called into directly.

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Machines are registered by an admin (registerMachine issues the key once);
// only a sha256 of the key is stored. Unknown machines are rejected — no
// trust-on-first-use.
export async function verifyMachine(machineName: string, apiKey: string): Promise<boolean> {
  if (!machineName || !apiKey) return false;
  const row = await getDb().prepare('SELECT api_key_hash FROM machines WHERE machine_name = ?')
    .get(machineName) as { api_key_hash: string | null } | undefined;
  if (!row?.api_key_hash) return false;
  const a = Buffer.from(row.api_key_hash, 'hex');
  const b = Buffer.from(sha256Hex(apiKey), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Create (or re-key) a machine. Returns the plaintext key — shown once. */
export async function registerMachine(machineName: string, registeredBy: string): Promise<string> {
  const apiKey = randomBytes(32).toString('hex');
  await getDb().prepare(`
    INSERT INTO machines (machine_name, api_key_hash, registered_at, registered_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (machine_name) DO UPDATE SET
      api_key_hash = excluded.api_key_hash, registered_by = excluded.registered_by, api_key = NULL
  `).run(machineName, sha256Hex(apiKey), new Date().toISOString(), registeredBy);
  return apiKey;
}

export async function queuePendingScript(data: {
  machine_name: string;
  username?: string | null;
  script_path: string;
  flags?: Record<string, unknown>;
  priority?: number;
}) {
  const now = new Date().toISOString();
  return getDb().prepare(`
    INSERT INTO pending_scripts (machine_name, username, script_path, flags, status, priority, created_at)
    VALUES (@machine_name, @username, @script_path, @flags, 'pending', @priority, @now)
    RETURNING id
  `).run({
    ...data,
    username: data.username ?? null,
    priority: data.priority ?? 0,
    flags: JSON.stringify(data.flags ?? {}),
    now,
  });
}

export async function getPendingScriptsForMachine(machineName: string) {
  return getDb().prepare(
    `SELECT * FROM pending_scripts WHERE machine_name = ? AND status = 'pending' ORDER BY priority DESC, id ASC`
  ).all(machineName);
}

export async function ackPendingScript(id: number, data: {
  status: 'completed' | 'failed' | 'running';
  output?: string | null;
  error?: string | null;
  exit_code?: number | null;
  pid?: number | null;
}) {
  const now = new Date().toISOString();
  const isTerminal = data.status === 'completed' || data.status === 'failed';
  return getDb().prepare(`
    UPDATE pending_scripts
    SET status = @status,
        output = @output,
        error = @error,
        exit_code = @exit_code,
        pid = @pid,
        started_at = COALESCE(started_at, CASE WHEN @status = 'running' THEN @now ELSE started_at END),
        completed_at = CASE WHEN @isTerminal THEN @now ELSE completed_at END
    WHERE id = @id
  `).run({
    output: null, error: null, exit_code: null, pid: null,
    ...data,
    id,
    isTerminal,
    now,
  });
}

export async function getScriptPath(scriptId: string, username: string): Promise<string | null> {
  const row = await getDb().prepare(
    'SELECT script_path FROM script_catalog WHERE script_id = ? AND username = ? LIMIT 1'
  ).get(scriptId, username) as { script_path: string } | undefined;
  return row?.script_path ?? null;
}

export async function getSiloManagers(machineName: string) {
  return getDb().prepare(
    'SELECT folder_name, machine_name, folder_json, synced_at FROM silo_managers WHERE machine_name = ? ORDER BY folder_name'
  ).all(machineName) as Promise<{ folder_name: string; machine_name: string; folder_json: string; synced_at: string }[]>;
}

const ALLOWED_SYNC_TABLES = new Set([
  'machines', 'silo_registry', 'folder_tree', 'workspace_folders', 'silo_managers',
  'catalog_models', 'catalog_signals', 'catalog_signal_stats',
  'nav_blob', 'portfolio_blob',
  'web_equity_curve', 'web_portfolio_allocs', 'web_balance_allocs',
  'pending_scripts', 'script_catalog', 'processes', 'watchlists',
]);

// Primary-key columns per syncable table — needed to build a correct
// ON CONFLICT target for the generic upsertRows() below (Postgres, unlike
// SQLite's INSERT OR REPLACE, requires an explicit conflict target).
const SYNC_TABLE_PK: Record<string, string[]> = {
  machines: ['machine_name'],
  workspace_folders: ['username', 'machine_name'],
  silo_managers: ['folder_name', 'machine_name'],
  pending_scripts: ['id'],
  script_catalog: ['script_id', 'username'],
  watchlists: ['username', 'watchlist_name'],
  processes: ['id'],
  // silo_registry, folder_tree, catalog_models, catalog_signals,
  // catalog_signal_stats, nav_blob, portfolio_blob,
  // web_equity_curve, web_portfolio_allocs, web_balance_allocs — same
  // multi-machine-aware keys as the schema migration, single source of
  // truth so they can't drift apart.
  ...MULTI_MACHINE_TABLES,
};

export async function getSilos(username: string, machineName?: string) {
  const stripped = username.includes('@') ? username.split('@')[0] : username;
  // Partitioned by (silo_name, machine_name) — not silo_name alone — so two
  // machines' independent copies of a same-named silo both survive (see the
  // multi-machine plan). Previously this collapsed them down to one.
  return getDb().prepare(`
    WITH ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY silo_name, machine_name
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
        ) AS rn
      FROM silo_registry
      WHERE (username = ? OR username = ?) ${machineName ? 'AND machine_name = ?' : ''}
    )
    SELECT username, silo_key, person_name, silo_name, machine_name, status,
           has_stacks, stack_rates, built_rates, catalog_db, engine_sim_db, engine_live_db,
           last_synced, trader_settings, optimizer_settings
    FROM ranked WHERE rn = 1
    ORDER BY silo_name
  `).all(...(machineName ? [username, stripped, machineName] : [username, stripped]));
}

export async function createSilo(data: {
  username: string;
  silo_key: string;
  person_name: string;
  silo_name: string;
  machine_name: string;
}) {
  const now = new Date().toISOString();
  const username = data.username.includes('@') ? data.username.split('@')[0] : data.username;
  await getDb().prepare(`
    INSERT INTO silo_registry
      (username, silo_key, person_name, silo_name, machine_name, status, last_synced)
    VALUES (@username, @silo_key, @person_name, @silo_name, @machine_name, 'pending', @last_synced)
    ON CONFLICT (username, silo_key, machine_name) DO NOTHING
  `).run({ ...data, username, last_synced: now });
}

export async function getSiloNavData(username: string, siloName: string, engineKind: string) {
  const stripped = stripEmail(username);
  const aliases = engineKind === 'simulated' ? ['simulated', 'sim'] : [engineKind];
  return (await getDb().prepare(
    `SELECT * FROM nav_blob
     WHERE (username = ? OR username = ?) AND silo_name = ? AND engine_kind IN (${aliases.map(() => '?').join(',')})
     ORDER BY synced_at DESC
     LIMIT 1`
  ).get(username, stripped, siloName, ...aliases)) ?? null;
}

export async function getEquityCurve(username: string, siloName: string, engineKind: string) {
  const stripped = stripEmail(username);
  const aliases = engineKind === 'simulated' ? ['simulated', 'sim'] : [engineKind];
  return getDb().prepare(
    `SELECT cycle_time, balance, equity, unrealised_pnl, margin_used, pnl
     FROM web_equity_curve
     WHERE (username = ? OR username = ?) AND silo_name = ? AND engine_kind IN (${aliases.map(() => '?').join(',')})
     ORDER BY cycle_time ASC`
  ).all(username, stripped, siloName, ...aliases);
}

export async function getPortfolioAllocs(username: string, siloName: string, engineKind: string) {
  const stripped = stripEmail(username);
  const aliases = engineKind === 'simulated' ? ['simulated', 'sim'] : [engineKind];
  return getDb().prepare(
    `SELECT instrument_name, last_close_price, vol_weight, fitness_weight, tot_weight, inventory
     FROM web_portfolio_allocs
     WHERE (username = ? OR username = ?) AND silo_name = ? AND engine_kind IN (${aliases.map(() => '?').join(',')})
     ORDER BY tot_weight DESC`
  ).all(username, stripped, siloName, ...aliases);
}

export async function getSiloPortfolioData(username: string, siloName: string, engineKind: string) {
  const stripped = stripEmail(username);
  const aliases = engineKind === 'simulated' ? ['simulated', 'sim'] : [engineKind];
  return (await getDb().prepare(
    `SELECT * FROM portfolio_blob
     WHERE (username = ? OR username = ?) AND silo_name = ? AND engine_kind IN (${aliases.map(() => '?').join(',')})
     ORDER BY synced_at DESC
     LIMIT 1`
  ).get(username, stripped, siloName, ...aliases)) ?? null;
}

export function stripEmail(username: string): string {
  return username.includes('@') ? username.split('@')[0] : username;
}

export async function getCatalogSources(username: string, isAdmin = false): Promise<string[]> {
  const stripped = stripEmail(username);
  const uc = isAdmin ? '1=1' : '(username = ? OR username = ?)';
  const rows = await getDb().prepare(`
    SELECT DISTINCT catalog_source FROM (
      SELECT catalog_source FROM catalog_signals
      WHERE ${uc}
        AND lower(catalog_source) NOT LIKE 'engine/%'
        AND lower(catalog_source) NOT LIKE '%demo%'
        AND lower(catalog_source) NOT LIKE '%mock%'
        AND lower(catalog_source) NOT LIKE '%fake%'
      UNION
      SELECT catalog_source FROM catalog_signal_stats
      WHERE ${uc}
        AND blob_hash IS NOT NULL
        AND (oos_sr IS NOT NULL OR current_sharpe IS NOT NULL OR oos_accuracy IS NOT NULL OR oos_profit_factor IS NOT NULL)
        AND lower(catalog_source) NOT LIKE 'engine/%'
        AND lower(catalog_source) NOT LIKE '%demo%'
        AND lower(catalog_source) NOT LIKE '%mock%'
        AND lower(catalog_source) NOT LIKE '%fake%'
      UNION
      SELECT catalog_source FROM catalog_models
      WHERE ${uc}
        AND (oos_sr IS NOT NULL OR oos_accuracy IS NOT NULL)
        AND lower(catalog_source) NOT LIKE 'engine/%'
        AND lower(catalog_source) NOT LIKE '%demo%'
        AND lower(catalog_source) NOT LIKE '%mock%'
        AND lower(catalog_source) NOT LIKE '%fake%'
    ) t
    ORDER BY catalog_source
  `).all(...(isAdmin ? [] : [username, stripped, username, stripped, username, stripped])) as { catalog_source: string }[];
  return rows.map(r => r.catalog_source);
}

export async function getCatalogTableRows(username: string, tableKind: string, source?: string | null, isAdmin = false) {
  const stripped = stripEmail(username);
  const table =
    tableKind === 'models' ? 'catalog_models' :
    tableKind === 'stats' ? 'catalog_signal_stats' :
    'catalog_signals';
  const params: unknown[] = isAdmin ? [] : [username, stripped];
  let where = isAdmin ? 'WHERE 1=1' : 'WHERE username IN (?, ?)';
  if (source && source !== '__all__') {
    if (source === '__manager__') {
      where += ` AND catalog_source NOT LIKE 'stack/%'`;
    } else {
      where += ' AND catalog_source = ?';
      params.push(source);
    }
  }
  where += `
    AND lower(catalog_source) NOT LIKE 'engine/%'
    AND lower(catalog_source) NOT LIKE '%demo%'
    AND lower(catalog_source) NOT LIKE '%mock%'
    AND lower(catalog_source) NOT LIKE '%fake%'
  `;
  if (table === 'catalog_signals') {
    const signalWhere = where.replace(/\busername\b/g, 'c.username').replace(/\bcatalog_source\b/g, 'c.catalog_source');
    return getDb().prepare(`
      SELECT c.*
      FROM catalog_signals c
      ${signalWhere}
        AND (c.oos_sr IS NOT NULL OR c.blob_hash IS NOT NULL)
      ORDER BY c.catalog_source, CASE WHEN c.blob_hash IS NULL THEN 1 ELSE 0 END, CASE WHEN c.oos_sr IS NULL THEN 1 ELSE 0 END, c.oos_sr DESC, c.signal_name
    `).all(...params);
  }
  const order =
    table === 'catalog_models'
      ? 'ORDER BY catalog_source, CASE WHEN oos_sr IS NULL THEN 1 ELSE 0 END, oos_sr DESC, model_type, model_name'
      : table === 'catalog_signal_stats'
        ? 'ORDER BY catalog_source, CASE WHEN current_sharpe IS NULL THEN 1 ELSE 0 END, current_sharpe DESC, signal_name, instrument_name'
        : 'ORDER BY catalog_source, CASE WHEN oos_sr IS NULL THEN 1 ELSE 0 END, oos_sr DESC, signal_name';
  if (table === 'catalog_signal_stats') {
    where += `
      AND blob_hash IS NOT NULL
      AND (oos_sr IS NOT NULL OR current_sharpe IS NOT NULL OR oos_accuracy IS NOT NULL OR oos_profit_factor IS NOT NULL)
    `;
  } else if (table === 'catalog_models') {
    where += ` AND (oos_sr IS NOT NULL OR oos_accuracy IS NOT NULL)`;
  }
  return getDb().prepare(`SELECT * FROM ${table} ${where} ${order}`).all(...params);
}

export async function getUserModelCatalog(username: string) {
  const stripped = stripEmail(username);
  return getDb().prepare(`
    SELECT * FROM user_model_catalog
    WHERE username = ? OR username = ?
    ORDER BY updated_at DESC, catalog_source, model_name, instrument_name, data_rate
  `).all(username, stripped);
}

export async function saveUserModelCatalogRecord(data: {
  username: string;
  model_hash: string;
  catalog_source?: string | null;
  model_name?: string | null;
  model_type?: string | null;
  instrument_name?: string | null;
  instruments?: string | null;
  data_rate?: string | null;
  stats_json: string;
  source_table?: string | null;
  synced_at?: string | null;
}) {
  const username = stripEmail(data.username);
  const now = new Date().toISOString();
  return getDb().prepare(`
    INSERT INTO user_model_catalog (
      username, model_hash, catalog_source, model_name, model_type,
      instrument_name, instruments, data_rate, stats_json, source_table,
      synced_at, created_at, updated_at
    ) VALUES (
      @username, @model_hash, @catalog_source, @model_name, @model_type,
      @instrument_name, @instruments, @data_rate, @stats_json, @source_table,
      @synced_at, @now, @now
    )
    ON CONFLICT(username, model_hash, instrument_name, data_rate) DO UPDATE SET
      catalog_source = excluded.catalog_source,
      model_name     = excluded.model_name,
      model_type     = excluded.model_type,
      instruments    = excluded.instruments,
      stats_json     = excluded.stats_json,
      source_table   = excluded.source_table,
      synced_at      = excluded.synced_at,
      updated_at     = excluded.updated_at
  `).run({
    ...data,
    username,
    catalog_source: data.catalog_source ?? null,
    model_name: data.model_name ?? null,
    model_type: data.model_type ?? null,
    instrument_name: data.instrument_name ?? '',
    instruments: data.instruments ?? null,
    data_rate: data.data_rate ?? '',
    source_table: data.source_table ?? null,
    synced_at: data.synced_at ?? null,
    now,
  });
}

export async function deleteUserModelCatalogRecord(username: string, modelHash: string, instrumentName = '', dataRate = '') {
  const stripped = stripEmail(username);
  return getDb().prepare(`
    DELETE FROM user_model_catalog
    WHERE (username = ? OR username = ?)
      AND model_hash = ?
      AND instrument_name = ?
      AND data_rate = ?
  `).run(username, stripped, modelHash, instrumentName, dataRate);
}

export async function getUserModelFavorites(username: string) {
  const stripped = stripEmail(username);
  const row = await getDb().prepare(`
    SELECT model_favorites_json
    FROM users
    WHERE username = ? OR username = ? OR username_email = ? OR username_email = ? OR user_id = ? OR user_id = ?
    LIMIT 1
  `).get(username, stripped, username, stripped, username, stripped) as any;
  try {
    const parsed = JSON.parse(row?.model_favorites_json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveUserModelFavorites(username: string, favorites: Record<string, any[]>) {
  const stripped = stripEmail(username);
  const json = JSON.stringify(favorites ?? {});
  return getDb().prepare(`
    UPDATE users
    SET model_favorites_json = ?
    WHERE username = ? OR username = ? OR username_email = ? OR username_email = ? OR user_id = ? OR user_id = ?
  `).run(json, username, stripped, username, stripped, username, stripped);
}

export async function updateUserModelFavoriteList(username: string, listName: string, modelRow: any, action: 'add' | 'remove') {
  const name = (listName || 'favorites').trim() || 'favorites';
  const favorites = await getUserModelFavorites(username) as Record<string, any[]>;
  const rows = Array.isArray(favorites[name]) ? favorites[name] : [];
  const modelHash = modelRow?.model_hash ?? modelRow?.blob_hash ?? modelRow?.hash ?? modelRow?.constructor_ref ?? '';
  const rowKey = [
    modelHash,
    modelRow?.catalog_source ?? '',
    modelRow?.signal_name ?? modelRow?.model_name ?? '',
    modelRow?.instrument_name ?? '',
    modelRow?.data_rate ?? '',
  ].join('|');
  const keyOf = (row: any) => [
    row?.model_hash ?? row?.blob_hash ?? row?.hash ?? row?.constructor_ref ?? '',
    row?.catalog_source ?? '',
    row?.signal_name ?? row?.model_name ?? '',
    row?.instrument_name ?? '',
    row?.data_rate ?? '',
  ].join('|');

  favorites[name] = action === 'remove'
    ? rows.filter(row => keyOf(row) !== rowKey)
    : [...rows.filter(row => keyOf(row) !== rowKey), modelRow];

  await saveUserModelFavorites(username, favorites);
  return favorites;
}

export async function getCatalogSignals(username: string, source: string) {
  const stripped = stripEmail(username);
  return getDb().prepare(`
    SELECT c.*
    FROM catalog_signals c
    WHERE (c.username = ? OR c.username = ?) AND c.catalog_source = ?
      AND (c.oos_sr IS NOT NULL OR c.blob_hash IS NOT NULL)
    ORDER BY CASE WHEN c.blob_hash IS NULL THEN 1 ELSE 0 END, CASE WHEN c.oos_sr IS NULL THEN 1 ELSE 0 END, c.oos_sr DESC
  `).all(username, stripped, source);
}

export async function getAllCatalogSignals(username: string) {
  const stripped = stripEmail(username);
  return getDb().prepare(`
    SELECT c.*
    FROM catalog_signals c
    WHERE (c.username = ? OR c.username = ?)
      AND (c.oos_sr IS NOT NULL OR c.blob_hash IS NOT NULL)
    ORDER BY c.data_rate, c.signal_name
  `).all(username, stripped);
}

export async function getCatalogMissingStatsCount(username: string, source?: string) {
  const stripped = stripEmail(username);
  const sourceClause = source ? 'AND c.catalog_source = ?' : '';
  const params: any[] = [username, stripped];
  if (source) params.push(source);
  const row = await getDb().prepare(`
    SELECT COUNT(*) as count FROM catalog_signals c
    WHERE (c.username = ? OR c.username = ?)
      ${sourceClause}
      AND c.oos_sr IS NULL AND c.blob_hash IS NULL
  `).get(...params) as any;
  return Number(row?.count ?? 0);
}

export async function getUserPreferences(username: string): Promise<Record<string, any>> {
  const row = await getDb().prepare(
    `SELECT preferences_json FROM user_preferences WHERE username = ?`
  ).get(username) as any;
  if (!row) return {};
  try { return JSON.parse(row.preferences_json); } catch { return {}; }
}

export async function setUserPreferences(username: string, prefs: Record<string, any>) {
  await getDb().prepare(`
    INSERT INTO user_preferences (username, preferences_json)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET preferences_json = excluded.preferences_json
  `).run(username, JSON.stringify(prefs));
}

export async function getSiloModels(username: string, siloName: string) {
  const stripped = stripEmail(username);
  return getDb().prepare(`
    SELECT m.model_name, m.model_type, m.data_rate, m.instrument_name,
           m.oos_sr, m.oos_accuracy, m.use_flag, m.off_flag,
           (
             SELECT s.blob_hash
             FROM catalog_signal_stats s
             WHERE (s.username = m.username OR s.username = ?)
               AND s.catalog_source = m.catalog_source
               AND (s.data_rate = m.data_rate OR m.data_rate IS NULL)
               AND (s.instrument_name = m.instrument_name OR m.instrument_name IS NULL)
               AND (s.signal_name = m.model_name OR s.type = m.model_type)
               AND s.blob_hash IS NOT NULL
             ORDER BY s.synced_at DESC
             LIMIT 1
           ) AS blob_hash,
           (
             SELECT s.constructor_ref
             FROM catalog_signal_stats s
             WHERE (s.username = m.username OR s.username = ?)
               AND s.catalog_source = m.catalog_source
               AND (s.data_rate = m.data_rate OR m.data_rate IS NULL)
               AND (s.instrument_name = m.instrument_name OR m.instrument_name IS NULL)
               AND (s.signal_name = m.model_name OR s.type = m.model_type)
             ORDER BY s.synced_at DESC
             LIMIT 1
           ) AS constructor_ref
    FROM catalog_models m
    WHERE (m.username = ? OR m.username = ?) AND m.catalog_source LIKE ?
    ORDER BY model_type, model_name
  `).all(stripped, stripped, username, stripped, `%${siloName.replace(/ /g, '_')}%`) as Promise<{
    model_name: string; model_type: string; data_rate: string | null;
    instrument_name: string | null; oos_sr: number | null; oos_accuracy: number | null;
    use_flag: number | null; off_flag: number | null; blob_hash: string | null; constructor_ref: string | null;
  }[]>;
}

export async function getSeedOptions(machineName: string, username?: string | null) {
  const stripped = username ? stripEmail(username) : null;
  const rows = await getDb().prepare(`
    SELECT script_id, label, description, script_path, flags_schema, username
    FROM script_catalog
    WHERE category = 'seed'
      ${stripped ? `AND (username = ? OR username = ? OR username IS NULL OR username = 'admin' OR username = 'arcium')` : ''}
    GROUP BY script_id, label, description, script_path, flags_schema, username
    ORDER BY label
  `).all(...(stripped ? [username, stripped] : [])) as { script_id: string; label: string; description: string; script_path: string; flags_schema: string; username: string }[];

  return rows.map(r => {
    let person: string | null = null;
    let account: string | null = null;
    let seed_name: string | null = null;
    try {
      const meta = JSON.parse(r.flags_schema ?? '{}');
      person  = meta.person  ?? null;
      account = meta.account ?? null;
      seed_name = meta.seed_name ?? null;
    } catch { /* legacy row without meta */ }
    return { ...r, person, account, seed_name };
  });
}

export async function registerSeed(data: {
  script_id: string;
  username: string;
  script_path: string;
  label: string;
  description?: string | null;
}) {
  await getDb().prepare(`
    INSERT INTO script_catalog
      (script_id, username, script_path, label, description, category, flags_schema)
    VALUES (@script_id, @username, @script_path, @label, @description, 'seed', '{}')
    ON CONFLICT (script_id, username) DO UPDATE SET
      script_path  = excluded.script_path,
      label        = excluded.label,
      description  = excluded.description,
      category     = excluded.category,
      flags_schema = excluded.flags_schema
  `).run({ description: null, ...data });
}

export async function getSeedById(scriptId: string) {
  return getDb().prepare(
    `SELECT * FROM script_catalog WHERE script_id = ? AND category = 'seed'`
  ).get(scriptId) as Promise<{ script_path: string; label: string } | undefined>;
}

export async function deleteSilo(username: string, siloKey: string) {
  const stripped = username.includes('@') ? username.split('@')[0] : username;
  await getDb().prepare(
    'DELETE FROM silo_registry WHERE (username = ? OR username = ?) AND silo_key = ?'
  ).run(username, stripped, siloKey);
}

export async function getSiloByKey(username: string, siloKey: string) {
  const stripped = username.includes('@') ? username.split('@')[0] : username;
  return getDb().prepare(`
    SELECT username, silo_key, person_name, silo_name, machine_name, status
    FROM silo_registry
    WHERE (username = ? OR username = ?) AND silo_key = ?
    LIMIT 1
  `).get(username, stripped, siloKey) as Promise<{
    username: string;
    silo_key: string;
    person_name: string;
    silo_name: string;
    machine_name: string | null;
    status: string | null;
  } | undefined>;
}

export async function getWorkspaceFolder(username: string, machineName: string) {
  return getDb().prepare(
    'SELECT * FROM workspace_folders WHERE username = ? AND machine_name = ?'
  ).get(username, machineName) as Promise<{ silo_manager_folder: string; synced_at: string } | undefined>;
}

// ── script_handler ────────────────────────────────────────────────────────────

export async function getScriptHandler(command: string): Promise<{ script_path: string; description: string | null } | undefined> {
  return getDb().prepare(
    'SELECT script_path, description FROM script_handler WHERE command = ?'
  ).get(command) as Promise<{ script_path: string; description: string | null } | undefined>;
}

export async function getAllScriptHandlers(): Promise<{ command: string; script_path: string; description: string | null }[]> {
  return getDb().prepare(
    'SELECT command, script_path, description FROM script_handler ORDER BY command'
  ).all() as Promise<{ command: string; script_path: string; description: string | null }[]>;
}

export async function upsertScriptHandler(command: string, script_path: string, description?: string) {
  await getDb().prepare(`
    INSERT INTO script_handler (command, script_path, description, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(command) DO UPDATE SET
      script_path = excluded.script_path,
      description = excluded.description,
      updated_at  = excluded.updated_at
  `).run(command, script_path, description ?? null, new Date().toISOString());
}

export async function deleteScriptHandler(command: string) {
  await getDb().prepare('DELETE FROM script_handler WHERE command = ?').run(command);
}

export async function addInstrumentToWatchlist(username: string, watchlistName: string, instrumentName: string) {
  const stripped = stripEmail(username);
  const row = await getDb().prepare(
    `SELECT instrument_names FROM watchlists WHERE (username = ? OR username = ?) AND watchlist_name = ?`
  ).get(username, stripped, watchlistName) as any;
  if (!row) {
    await upsertWatchlist({ username, watchlist_name: watchlistName, instrument_names: instrumentName });
    return;
  }
  const names = (row.instrument_names as string).split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!names.includes(instrumentName)) {
    names.push(instrumentName);
    await upsertWatchlist({ username, watchlist_name: watchlistName, instrument_names: names.join(',') });
  }
}

export async function removeInstrumentFromWatchlist(username: string, watchlistName: string, instrumentName: string) {
  const stripped = stripEmail(username);
  const row = await getDb().prepare(
    `SELECT instrument_names FROM watchlists WHERE (username = ? OR username = ?) AND watchlist_name = ?`
  ).get(username, stripped, watchlistName) as any;
  if (!row) return;
  const names = (row.instrument_names as string).split(',').map((s: string) => s.trim()).filter((n: string) => n && n !== instrumentName);
  await upsertWatchlist({ username, watchlist_name: watchlistName, instrument_names: names.join(',') });
}

// ── watchlists ────────────────────────────────────────────────────────────────

export async function upsertWatchlist(data: {
  username: string; watchlist_name: string; instrument_names: string;
  catalog_source?: string; data_rate?: string; tags?: string;
}) {
  const stripped = stripEmail(data.username);
  const now = new Date().toISOString();
  await getDb().prepare(`
    INSERT INTO watchlists
      (username, watchlist_name, instrument_names, catalog_source, data_rate, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (username, watchlist_name) DO UPDATE SET
      instrument_names = excluded.instrument_names,
      catalog_source    = excluded.catalog_source,
      data_rate          = excluded.data_rate,
      tags                 = excluded.tags,
      created_at             = excluded.created_at
  `).run(stripped, data.watchlist_name, data.instrument_names,
         data.catalog_source ?? null, data.data_rate ?? null, data.tags ?? null, now);
}

export async function getWatchlists(username: string) {
  const stripped = stripEmail(username);
  return getDb().prepare(
    `SELECT * FROM watchlists WHERE username = ? OR username = ? ORDER BY created_at DESC`
  ).all(username, stripped);
}

// ── seeds (wh_seeds / wh_seed_uploads — owned by hub_services/seed_warehouse) ─
//
// The site never writes wh_seeds directly: uploads go into wh_seed_uploads
// as pending and the hub's seed_warehouse validates/canonicalizes each one
// into an immutable seed version (or rejects it with a reason).

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Latest version of each seed. owner = null lists every owner (admin). */
export async function listSeeds(owner: string | null) {
  const stripped = owner ? stripEmail(owner) : null;
  return getDb().prepare(`
    SELECT DISTINCT ON (owner_username, seed_name)
           id, seed_name AS name, owner_username, description, version::text AS version,
           bundle_hash, created_at, created_at AS updated_at,
           (SELECT count(*) FROM wh_seeds v
             WHERE v.owner_username = s.owner_username AND v.seed_name = s.seed_name)::int AS versions
    FROM wh_seeds s
    WHERE NOT deleted ${stripped ? 'AND owner_username = ?' : ''}
    ORDER BY owner_username, seed_name, version DESC
  `).all(...(stripped ? [stripped] : []));
}

export async function getSeedBundle(id: string) {
  if (!UUID_RE.test(id)) return undefined;
  return getDb().prepare(
    `SELECT seed_name AS name, owner_username, bundle, bundle_hash FROM wh_seeds WHERE id = ? AND NOT deleted`
  ).get(id) as Promise<{ name: string; owner_username: string; bundle: Buffer; bundle_hash: string } | undefined>;
}

export async function createSeedUpload(data: {
  owner_username: string; seed_name: string; description?: string | null; bundle: Buffer; submitted_by: string;
}): Promise<string> {
  const row = await getDb().prepare(`
    INSERT INTO wh_seed_uploads (owner_username, seed_name, description, bundle, submitted_by)
    VALUES (?, ?, ?, ?, ?) RETURNING id
  `).get(stripEmail(data.owner_username), data.seed_name, data.description ?? null, data.bundle, data.submitted_by) as { id: string };
  return row.id;
}

export async function getSeedUpload(id: string) {
  if (!UUID_RE.test(id)) return undefined;
  return getDb().prepare(`
    SELECT u.id, u.owner_username, u.seed_name, u.status, u.reject_reason, u.seed_id,
           u.created_at, u.processed_at, s.version
    FROM wh_seed_uploads u LEFT JOIN wh_seeds s ON s.id = u.seed_id
    WHERE u.id = ?
  `).get(id) as Promise<{ id: string; owner_username: string; seed_name: string; status: string;
    reject_reason: string | null; seed_id: string | null; version: number | null } | undefined>;
}

/** Recent uploads that are not (yet) seeds: pending, processing, or rejected. */
export async function listOpenSeedUploads(owner: string) {
  return getDb().prepare(`
    SELECT id, seed_name, status, reject_reason, created_at, processed_at
    FROM wh_seed_uploads
    WHERE owner_username = ? AND status <> 'ready' AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC LIMIT 20
  `).all(stripEmail(owner));
}

/** Wait briefly for seed_warehouse to process an upload (it polls every few seconds). */
export async function waitForSeedUpload(id: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await getSeedUpload(id);
    if (!up || up.status === 'ready' || up.status === 'rejected' || Date.now() > deadline) return up;
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── table sync ────────────────────────────────────────────────────────────────

// `processes` has a surrogate autoincrement PK, not a natural key, and each
// push is a full snapshot of a machine's currently-running processes — so it
// needs replace (delete-then-insert), and critically must still clear stale
// rows when the new snapshot is empty (all processes stopped), which the
// generic upsertRows() can't do since it short-circuits on an empty array.
export async function replaceMachineProcesses(machineName: string, rows: Record<string, unknown>[]) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM processes WHERE machine_name = $1', [machineName]);
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(`INSERT INTO processes (${cols.join(', ')}) VALUES (${placeholders})`, cols.map(c => row[c]));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted: rows.length };
}

// Tables a machine may write through /api/machine/sync. machines,
// pending_scripts and script_catalog are site-owned: a worker must never be
// able to re-key machines, queue commands, or rewrite the command catalogue.
export const MACHINE_PUSH_TABLES = new Set(
  [...ALLOWED_SYNC_TABLES].filter(t => !['machines', 'pending_scripts', 'script_catalog'].includes(t)),
);

const tableColumnsCache = new Map<string, Set<string>>();

async function tableColumns(table: string): Promise<Set<string>> {
  let cols = tableColumnsCache.get(table);
  if (!cols) {
    const res = await getPool().query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
    cols = new Set(res.rows.map((r: { column_name: string }) => r.column_name));
    tableColumnsCache.set(table, cols);
  }
  return cols;
}

export async function upsertRows(table: string, rows: Record<string, unknown>[],
                                 opts: { machineName?: string } = {}) {
  if (!ALLOWED_SYNC_TABLES.has(table)) throw new Error(`Sync not allowed for table: ${table}`);
  if (opts.machineName && !MACHINE_PUSH_TABLES.has(table)) throw new Error(`Machines may not write table: ${table}`);
  if (!rows.length) return { inserted: 0 };
  await ensureReady();
  const pk = SYNC_TABLE_PK[table];
  if (!pk) throw new Error(`No primary key mapping for sync table: ${table}`);
  // Column names come from the request body — only real columns of this
  // table may appear in the SQL text.
  const known = await tableColumns(table);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const raw of rows) {
      const row: Record<string, unknown> = { ...raw };
      if (opts.machineName && known.has('machine_name')) row.machine_name = opts.machineName;
      const bad = Object.keys(row).filter(c => !known.has(c));
      if (bad.length) throw new Error(`unknown column(s) for ${table}: ${bad.join(', ')}`);
      const cols = Object.keys(row);
      const nonPkCols = cols.filter(c => !pk.includes(c));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const conflictTarget = pk.join(', ');
      const setClause = nonPkCols.length
        ? nonPkCols.map(c => `${c} = excluded.${c}`).join(', ')
        : null;
      const text = setClause
        ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause}`
        : `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${conflictTarget}) DO NOTHING`;
      await client.query(text, cols.map(c => row[c]));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted: rows.length };
}
