/**
 * Shared response shapes for the routes rewritten this session (Postgres
 * migration + single sync proxy). Used on both sides of the fetch boundary
 * — as the route handler's return type and as the type argument on the
 * client's `await res.json()` — so a future shape change is a real `tsc`
 * error at every call site instead of a silent runtime mismatch (see
 * `dashboard-functionality-audit.md` regression notes for why this matters:
 * two real bugs this session came from exactly this class of drift).
 *
 * Not a full app-wide typing pass — scoped to the routes this session's
 * backend rewrite touched.
 */

// ── seeds (wh_seeds, managed by hub_services/seed_warehouse) ────────────────

/** Latest version of a seed; `id` identifies that exact version (plant by id). */
export interface SeedRow {
  id: string;
  name: string;
  owner_username: string;
  description: string | null;
  version: string | null;
  bundle_hash: string;
  created_at: string;
  updated_at: string;
  versions?: number;
}

/** Uploads are validated asynchronously by the hub's seed_warehouse. */
export interface SeedUploadResponse {
  ok: true;
  upload_id: string;
  status: 'pending';
}

export interface SeedUploadStatus {
  id: string;
  owner_username: string;
  seed_name: string;
  status: 'pending' | 'processing' | 'ready' | 'rejected';
  reject_reason: string | null;
  seed_id: string | null;
  version: number | null;
}

// ── machines / processes ────────────────────────────────────────────────────

export interface MachineRow {
  machine_id: number | null;
  machine_name: string;
  hostname: string | null;
  platform: string | null;
  silo_db_dir: string | null;
  last_heartbeat: string | null;
  registered_at: string | null;
  dir_tree: string | null;
  api_key: string | null;
}

export interface ProcessRow {
  id: number;
  machine_id: number | null;
  machine_name: string;
  username: string | null;
  process_name: string;
  pid: number | null;
  status: string | null;
  started_at: string | null;
  stopped_at: string | null;
  cmdline_summary: string | null;
}

// ── silo_registry ────────────────────────────────────────────────────────────

export interface SiloRegistryRow {
  username: string;
  silo_key: string;
  person_name: string;
  silo_name: string;
  machine_name: string | null;
  status: string | null;
  has_stacks: number;
  stack_rates: string;   // JSON-encoded string[]
  built_rates: string;   // JSON-encoded string[]
  catalog_db: string | null;
  engine_sim_db: string | null;
  engine_live_db: string | null;
  last_synced: string | null;
  trader_settings: string | null;    // JSON-encoded object
  optimizer_settings: string | null; // JSON-encoded object
}

// ── script dispatch / job tracking (pending_scripts) ────────────────────────

export interface DispatchResponse {
  ok: true;
  queued: number;
  job_id: number | undefined;
  command?: string | null;
  script_path?: string;
}

export interface DispatchErrorResponse {
  error: string;
}

export interface JobStatusRow {
  id: number;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateSiloResponse {
  ok: true;
  silo_key: string;
  queued: number;
  job_id: number | undefined;
}

// ── /api/machine/sync + /api/machine/commands (the sync proxy itself) ──────

export interface MachineSyncResponse {
  ok: true;
  results: Record<string, number | string>;
}

export interface MachineCommandRow {
  id: number;
  machine_name: string;
  username: string | null;
  script_path: string;
  flags: string; // JSON-encoded object
  status: string;
  priority: number | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  pid: number | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
}

export interface MachineCommandsResponse {
  commands: MachineCommandRow[];
}

// ── silo-settings ────────────────────────────────────────────────────────────

export interface SiloSettingsResponse {
  trader: Record<string, unknown>;
  optimizer: Record<string, unknown>;
  synced_at: string | null;
  /** Secret fields stored encrypted for this silo (values are never returned). */
  secrets_set?: string[];
}
