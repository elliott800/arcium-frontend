// Branch reviews (server side): what the review sync left on disk, and the owner's decisions back to GitHub.
//
// The sync (arcium_production_site/server/review-sync.py, every 5 minutes on the server) writes, under REVIEWS_DIR:
//   <repo>/pr-<n>/meta.json            the pull request: title, author, url, body, state, head sha, checks
//   <repo>/pr-<n>/<sha>/               that commit's demo artifact (before/, after/, demo-report.json)
//   <repo>/pr-<n>/decision.json        the owner's last decision (written here, by decide())
//   <repo>/walkthroughs/<sha>/         a walkthrough recorded after a merge (walkthrough.webm, *.png, report.json)
//   preview.json / preview-request.json   the one live preview: its state, and a request for a new one
// Nothing here talks to the database. GitHub is only called to post a review, with GITHUB_REVIEW_TOKEN.
import 'server-only';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';

export const REVIEWS_DIR = process.env.REVIEWS_DIR || '';

// ── shapes ──
export interface PrMeta {
  repo: string; full_name: string; pr: number; title: string; author: string; url: string; body: string;
  state: 'open' | 'closed' | 'merged'; head_sha: string; updated_at: string;
  checks: Record<string, string>;                 // check name -> success | failure | pending | ...
}
export interface DemoScreen {
  id: string; file: string; url: string; flags: string[]; newErrors: string[];
  before: { loadMs: number | null; errors: string[] } | null; after: { loadMs: number | null; errors: string[] } | null;
}
export interface DemoReport { files: string[]; screens: DemoScreen[]; attention: boolean; gui: { failed: string[] } | null }
export interface Decision { sha: string; event: 'APPROVE' | 'REQUEST_CHANGES'; body: string; at: string; by: string }
export interface PrReview extends PrMeta { dir: string; report: DemoReport | null; decision: Decision | null }
export interface Walkthrough { repo: string; sha: string; dir: string; at: string; screens: { id: string; file: string }[] }
export interface Preview { state: 'idle' | 'building' | 'running' | 'stopped' | 'failed'; repo?: string; pr?: number; url?: string; stops_at?: string; message?: string }

// ── reading ──
function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}
const dirs = (p: string) => (existsSync(p) ? readdirSync(p).filter(n => statSync(join(p, n)).isDirectory()) : []);

export function listReviews(): { prs: PrReview[]; walkthroughs: Walkthrough[]; preview: Preview } {
  const prs: PrReview[] = [];
  const walkthroughs: Walkthrough[] = [];
  if (!REVIEWS_DIR) return { prs, walkthroughs, preview: { state: 'idle' } };
  for (const repo of dirs(REVIEWS_DIR)) {
    for (const d of dirs(join(REVIEWS_DIR, repo))) {
      if (d.startsWith('pr-')) {
        const meta = readJson<PrMeta>(join(REVIEWS_DIR, repo, d, 'meta.json'));
        if (!meta) continue;
        const dir = `${repo}/${d}/${meta.head_sha}`;
        prs.push({
          ...meta, dir,
          report: readJson<DemoReport>(join(REVIEWS_DIR, dir, 'demo-report.json')),
          decision: readJson<Decision>(join(REVIEWS_DIR, repo, d, 'decision.json')),
        });
      } else if (d === 'walkthroughs') {
        for (const sha of dirs(join(REVIEWS_DIR, repo, d))) {
          const dir = `${repo}/walkthroughs/${sha}`;
          const r = readJson<{ at: string; screens: { id: string; file: string }[] }>(join(REVIEWS_DIR, dir, 'report.json'));
          if (r) walkthroughs.push({ repo, sha, dir, at: r.at, screens: r.screens });
        }
      }
    }
  }
  prs.sort((a, b) => (a.state === 'open') !== (b.state === 'open') ? (a.state === 'open' ? -1 : 1) : b.updated_at.localeCompare(a.updated_at));
  walkthroughs.sort((a, b) => b.at.localeCompare(a.at));
  return { prs, walkthroughs, preview: readJson<Preview>(join(REVIEWS_DIR, 'preview.json')) ?? { state: 'idle' } };
}

/** A recorded file (screenshot, video, report), only from inside REVIEWS_DIR. */
const TYPES: Record<string, string> = { '.png': 'image/png', '.webm': 'video/webm', '.json': 'application/json' };
export function reviewFile(path: string): { body: Buffer; type: string } | null {
  if (!REVIEWS_DIR || !path) return null;
  const full = normalize(join(REVIEWS_DIR, path));
  const inside = relative(REVIEWS_DIR, full);
  if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`)) return null;
  const type = TYPES[full.slice(full.lastIndexOf('.')).toLowerCase()];
  if (!type || !existsSync(full)) return null;
  return { body: readFileSync(full), type };
}

// ── the owner's decision, posted to GitHub as a review ──
export async function decide(repo: string, pr: number, event: Decision['event'], body: string, by: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.GITHUB_REVIEW_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_REVIEW_TOKEN is not set on this site.' };
  const folder = join(REVIEWS_DIR, repo, `pr-${pr}`);
  const meta = readJson<PrMeta>(join(folder, 'meta.json'));
  if (!meta) return { ok: false, error: 'Unknown pull request.' };
  if (event === 'REQUEST_CHANGES' && !body.trim()) return { ok: false, error: 'Say what should change.' };
  const r = await fetch(`https://api.github.com/repos/${meta.full_name}/pulls/${pr}/reviews`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json', 'User-Agent': 'arcium-branch-reviews' },
    body: JSON.stringify({ commit_id: meta.head_sha, event, body: body.trim() || 'Approved on the Branch reviews page.' }),
  }).catch(() => null);
  if (!r || !r.ok) {
    const why = r ? ((await r.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${r.status}` : 'GitHub could not be reached';
    return { ok: false, error: `GitHub refused the review: ${why}` };
  }
  const d: Decision = { sha: meta.head_sha, event, body: body.trim(), at: new Date().toISOString(), by };
  writeFileSync(join(folder, 'decision.json'), JSON.stringify(d, null, 2));
  return { ok: true };
}

/** Ask the server for a live preview of a pull request (the review sync starts it; one at a time). */
export function requestPreview(repo: string, pr: number, by: string): { ok: boolean; error?: string } {
  if (!REVIEWS_DIR) return { ok: false, error: 'REVIEWS_DIR is not set on this site.' };
  const meta = readJson<PrMeta>(join(REVIEWS_DIR, repo, `pr-${pr}`, 'meta.json'));
  if (!meta) return { ok: false, error: 'Unknown pull request.' };
  writeFileSync(join(REVIEWS_DIR, 'preview-request.json'),
    JSON.stringify({ repo, pr, sha: meta.head_sha, full_name: meta.full_name, at: new Date().toISOString(), by }, null, 2));
  return { ok: true };
}
