// The hub registry: one core for the Data, Broker and Seed hubs.
//
// A repo belongs to one person on one hub and holds immutable, numbered versions (like
// commits: a message, an author and a full set of files). Repos are private or public.
//   private  only the owner (and the admin) see it.
//   public   everyone sees it once the admin has approved a version, and then only approved
//            versions: making a repo public, and every new version of a public repo, waits
//            for the admin's review (the control panel's Hubs section).
// A public repo may hide its code (code_visible = false): people see the file list, the
// README and docs, and can use the module through the hub, but not read its source.
//
// Uploaded files are untrusted: they are stored and shown (escaped) and never run.

import { createHash } from 'crypto';
import { getDb, getPool } from './db';
import { HUBS, type HubId } from './hub-origins';

export interface Viewer { username: string; admin: boolean }
export interface Repo {
  id: string; hub: HubId; owner_username: string; name: string; description: string;
  visibility: 'private' | 'public'; code_visible: boolean; published_version: number | null;
  created_at: string; updated_at: string;
}
export interface Version {
  number: number; message: string; author: string; created_at: string; file_count: number;
  total_bytes: number; review: 'none' | 'pending' | 'approved' | 'rejected'; review_note: string | null;
  reviewed_by: string | null; reviewed_at: string | null;
}
export interface FileEntry { path: string; size: number; sha256: string }
export class HubError extends Error { constructor(message: string, public status = 400) { super(message); } }

export const LIMITS = { fileBytes: 1_000_000, versionBytes: 8_000_000, files: 500, reposPerOwner: 50, pathLength: 300 };
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SKIP_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.vscode']);
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|token\.txt)$/i;
const DOC_FILE = /^(readme|license|changelog)(\.[a-z]+)?$|\.md$/i;

const db = () => getDb();
const now = () => new Date().toISOString();

// ── who sees what ──────────────────────────────────────────────────────────
const isOwner = (r: Repo, v: Viewer | null) => !!v && (v.admin || v.username === r.owner_username);
export const canManage = isOwner;
export const canSeeRepo = (r: Repo, v: Viewer | null) => isOwner(r, v) || (r.visibility === 'public' && r.published_version != null);
export const canSeeVersion = (r: Repo, ver: Version, v: Viewer | null) => isOwner(r, v) || (canSeeRepo(r, v) && ver.review === 'approved');
/** Docs (README, LICENSE, *.md, docs/) are always readable where the repo is; other files need code_visible. */
export const isDoc = (path: string) => path.startsWith('docs/') || DOC_FILE.test(path.split('/').pop() ?? '');
export const canReadFile = (r: Repo, path: string, v: Viewer | null) => isOwner(r, v) || r.code_visible || isDoc(path);

// ── repos ──────────────────────────────────────────────────────────────────
export async function getRepo(hub: HubId, owner: string, name: string): Promise<Repo | null> {
  return (await db().prepare(`SELECT * FROM hub_repos WHERE hub = ? AND owner_username = ? AND name = ?`)
    .get(hub, owner, name) as Repo | undefined) ?? null;
}

/** Public repos (with an approved version) plus the viewer's own; ?q matches name/description. */
export async function listRepos(hub: HubId, v: Viewer | null, q = '') {
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`;
  return await db().prepare(`
    SELECT r.hub, r.owner_username, r.name, r.description, r.visibility, r.code_visible, r.published_version, r.updated_at,
           (SELECT max(number) FROM hub_versions x WHERE x.repo_id = r.id) AS latest_version,
           EXISTS (SELECT 1 FROM hub_versions x WHERE x.repo_id = r.id AND x.review = 'pending') AS pending
    FROM hub_repos r
    WHERE r.hub = ? AND ((r.visibility = 'public' AND r.published_version IS NOT NULL) OR r.owner_username = ?)
      AND (? = '%%' OR lower(r.name) LIKE ? OR lower(r.description) LIKE ?)
    ORDER BY (r.owner_username = ?) DESC, r.updated_at DESC
    LIMIT 200
  `).all(hub, v?.username ?? '', like, like, like, v?.username ?? '') as Record<string, unknown>[];
}

export async function createRepo(hub: HubId, owner: string, name: string, description: string): Promise<Repo> {
  name = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) throw new HubError('Use 1–64 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.');
  const n = (await db().prepare(`SELECT count(*)::int AS n FROM hub_repos WHERE owner_username = ?`).get(owner) as { n: number }).n;
  if (n >= LIMITS.reposPerOwner) throw new HubError(`You have ${n} repos; the limit is ${LIMITS.reposPerOwner}.`);
  if (await getRepo(hub, owner, name)) throw new HubError('You already have a repo with that name here.', 409);
  await db().prepare(`INSERT INTO hub_repos (hub, owner_username, name, description) VALUES (?, ?, ?, ?)`)
    .run(hub, owner, name, description.trim().slice(0, 500));
  return (await getRepo(hub, owner, name))!;
}

/** Settings: description, visibility, code_visible. Going public sends the latest version to review. */
export async function updateRepo(r: Repo, patch: { description?: unknown; visibility?: unknown; code_visible?: unknown }): Promise<Repo> {
  const description = typeof patch.description === 'string' ? patch.description.trim().slice(0, 500) : r.description;
  const visibility = patch.visibility === 'public' || patch.visibility === 'private' ? patch.visibility : r.visibility;
  const code_visible = typeof patch.code_visible === 'boolean' ? patch.code_visible : r.code_visible;
  await db().prepare(`UPDATE hub_repos SET description = ?, visibility = ?, code_visible = ?, updated_at = ? WHERE id = ?`)
    .run(description, visibility, code_visible, now(), r.id);
  if (visibility === 'public') {
    // The newest version goes to review unless it is already approved or waiting.
    await db().prepare(`
      UPDATE hub_versions SET review = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL
      WHERE repo_id = ? AND number = (SELECT max(number) FROM hub_versions WHERE repo_id = ?) AND review IN ('none', 'rejected')
    `).run(r.id, r.id);
  }
  return (await getRepo(r.hub, r.owner_username, r.name))!;
}

export async function deleteRepo(r: Repo): Promise<void> {
  await db().prepare(`DELETE FROM hub_repos WHERE id = ?`).run(r.id);
  await db().prepare(`DELETE FROM hub_blobs b WHERE NOT EXISTS (SELECT 1 FROM hub_files f WHERE f.sha256 = b.sha256)`).run();
}

// ── versions ───────────────────────────────────────────────────────────────
export async function listVersions(r: Repo): Promise<Version[]> {
  return await db().prepare(`
    SELECT number, message, author, created_at, file_count, total_bytes::float8 AS total_bytes, review, review_note, reviewed_by, reviewed_at
    FROM hub_versions WHERE repo_id = ? ORDER BY number DESC
  `).all(r.id) as Version[];
}

/** A clean relative path ("pkg/source_api.py"), null to skip the file silently, or an error. */
export function cleanPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, '/').split('/').filter(p => p !== '' && p !== '.');
  if (!parts.length) throw new HubError('A file has no name.');
  if (parts.some(p => p === '..' || /[\u0000-\u001f]/.test(p))) throw new HubError(`Bad file path: ${raw.slice(0, 80)}`);
  if (parts.slice(0, -1).some(p => SKIP_DIRS.has(p)) || parts[parts.length - 1] === '.DS_Store') return null;
  const path = parts.join('/');
  if (path.length > LIMITS.pathLength) throw new HubError(`Path too long: ${path.slice(0, 80)}…`);
  if (SECRET_FILE.test(path)) throw new HubError(`${path} looks like a secret (keys, tokens, .env). Leave it out of the upload.`);
  return path;
}

/** A new version from uploaded files. A single top folder shared by every file is dropped. */
export async function addVersion(r: Repo, author: string, message: string, uploads: { path: string; data: Buffer }[]): Promise<number> {
  const files = new Map<string, Buffer>();
  for (const u of uploads) {
    const p = cleanPath(u.path);
    if (p == null) continue;
    if (u.data.length > LIMITS.fileBytes) throw new HubError(`${p} is over ${LIMITS.fileBytes / 1e6} MB.`);
    files.set(p, u.data);
  }
  if (!files.size) throw new HubError('No files to upload.');
  if (files.size > LIMITS.files) throw new HubError(`${files.size} files; the limit is ${LIMITS.files}.`);
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  if (total > LIMITS.versionBytes) throw new HubError(`The upload is ${(total / 1e6).toFixed(1)} MB; the limit is ${LIMITS.versionBytes / 1e6} MB.`);
  // Uploading a folder gives every path its folder name: keep paths relative to it.
  const tops = new Set([...files.keys()].map(p => p.includes('/') ? p.split('/')[0] : ''));
  const strip = tops.size === 1 && !tops.has('') ? [...tops][0] + '/' : '';

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM hub_repos WHERE id = $1 FOR UPDATE', [r.id]);
    const { rows } = await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM hub_versions WHERE repo_id = $1', [r.id]);
    const number = Number(rows[0].n);
    await client.query(
      `INSERT INTO hub_versions (repo_id, number, message, author, file_count, total_bytes, review) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.id, number, message.trim().slice(0, 500) || `Version ${number}`, author, files.size, total, r.visibility === 'public' ? 'pending' : 'none']);
    for (const [p, data] of files) {
      const sha = createHash('sha256').update(data).digest('hex');
      await client.query(`INSERT INTO hub_blobs (sha256, size, content) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING`, [sha, data.length, data]);
      await client.query(`INSERT INTO hub_files (repo_id, number, path, sha256, size) VALUES ($1, $2, $3, $4, $5)`,
        [r.id, number, p.slice(strip.length), sha, data.length]);
    }
    await client.query(`UPDATE hub_repos SET updated_at = $1 WHERE id = $2`, [now(), r.id]);
    await client.query('COMMIT');
    return number;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function versionFiles(r: Repo, number: number): Promise<FileEntry[]> {
  return await db().prepare(`SELECT path, size, sha256 FROM hub_files WHERE repo_id = ? AND number = ? ORDER BY path`)
    .all(r.id, number) as FileEntry[];
}

/** File text for the code view, or null when it is binary. */
export async function fileText(r: Repo, number: number, path: string): Promise<{ text: string | null; size: number } | null> {
  const row = await db().prepare(`
    SELECT b.content, b.size FROM hub_files f JOIN hub_blobs b USING (sha256) WHERE f.repo_id = ? AND f.number = ? AND f.path = ?
  `).get(r.id, number, path) as { content: Buffer; size: number } | undefined;
  if (!row) return null;
  const head = row.content.subarray(0, 8000);
  return { text: head.includes(0) ? null : row.content.toString('utf8'), size: row.size };
}

/** What a reviewer should look at: each hub's expected entry point, plus anything odd. */
export function versionChecks(hub: HubId, files: FileEntry[]): { ok: boolean; text: string }[] {
  const names = files.map(f => f.path.split('/').pop()!);
  const out: { ok: boolean; text: string }[] = [];
  if (hub === 'data') out.push({ ok: names.includes('source_api.py'), text: 'Has a source_api.py' });
  if (hub === 'broker') out.push({ ok: names.includes('broker_api.py'), text: 'Has a broker_api.py' });
  if (hub === 'seed') out.push({ ok: files.some(f => f.path.endsWith('.py')), text: 'Has Python modules' });
  out.push({ ok: files.some(f => /^readme(\.md)?$/i.test(f.path)), text: 'Has a README' });
  const big = files.filter(f => f.size > 250_000).length;
  if (big) out.push({ ok: false, text: `${big} file(s) over 250 KB` });
  return out;
}

// ── review (admin) ─────────────────────────────────────────────────────────
export async function pendingReviews() {
  return await db().prepare(`
    SELECT r.hub, r.owner_username, r.name, r.description, r.code_visible, r.published_version,
           v.number, v.message, v.author, v.created_at, v.file_count, v.total_bytes::float8 AS total_bytes
    FROM hub_versions v JOIN hub_repos r ON r.id = v.repo_id
    WHERE v.review = 'pending' ORDER BY v.created_at
  `).all() as Record<string, unknown>[];
}

export async function review(r: Repo, number: number, approve: boolean, note: string, admin: string): Promise<void> {
  const res = await db().prepare(`
    UPDATE hub_versions SET review = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE repo_id = ? AND number = ? AND review = 'pending'
  `).run(approve ? 'approved' : 'rejected', note.trim().slice(0, 500) || null, admin, now(), r.id, number);
  if (!res.changes) throw new HubError('That version is not waiting for review.', 409);
  if (approve) {
    await db().prepare(`UPDATE hub_repos SET published_version = GREATEST(coalesce(published_version, 0), ?), updated_at = ? WHERE id = ?`)
      .run(number, now(), r.id);
  }
}

export const hubName = (hub: HubId) => HUBS[hub].name;
