'use client';

// Dashboard "Branch reviews" (control.reviews, owner): every open pull request with the demo agent's recording of the
// screens it touches, before (main) and after (the branch), side by side; Approve or Request changes posts the
// owner's review to GitHub, and main only accepts approved pull requests. Also the walkthroughs recorded after each
// merge, and one live preview of a branch at a time. Also reached at reviews.arciumsites.com.
//
//   API   GET/POST /api/admin/reviews · GET /api/admin/reviews/file?p=…   (src/lib/reviews.ts)

import { useMemo, useState } from 'react';
import { Notice, Page, Table, ago, postJson, useJson } from '@/ui/kit';

// ── shapes (as src/lib/reviews.ts returns them) ──
interface Screen {
  id: string; file: string; flags: string[]; newErrors: string[];
  before: { loadMs: number | null } | null; after: { loadMs: number | null } | null;
}
interface Pr {
  repo: string; pr: number; title: string; author: string; url: string; body: string; state: string; head_sha: string;
  updated_at: string; checks: Record<string, string>; dir: string;
  report: { files: string[]; screens: Screen[]; attention: boolean; gui: { failed: string[] } | null } | null;
  decision: { sha: string; event: string; body: string; at: string } | null;
}
interface Walk { repo: string; sha: string; dir: string; at: string; screens: { id: string; file: string }[] }
interface Preview { state: string; repo?: string; pr?: number; url?: string; stops_at?: string; message?: string }
interface Reviews { configured: boolean; token: boolean; prs: Pr[]; walkthroughs: Walk[]; preview: Preview }
type Msg = { ok: boolean; text: string } | null;

const file = (p: string) => `/api/admin/reviews/file?p=${encodeURIComponent(p)}`;
const checksOk = (c: Record<string, string>) => Object.values(c).every(v => v === 'success');
const decided = (p: Pr) => p.decision && p.decision.sha === p.head_sha ? p.decision.event : null;

export default function BranchReviews() {
  const { data, error, reload } = useJson<Reviews>('/api/admin/reviews', 30000);
  const [tab, setTab] = useState<'prs' | 'walks'>('prs');
  const [pick, setPick] = useState<string | null>(null);
  const prs = useMemo(() => data?.prs ?? [], [data]);
  const current = useMemo(() => prs.find(p => `${p.repo}#${p.pr}` === pick) ?? prs.find(p => p.state === 'open') ?? null, [prs, pick]);
  const waiting = prs.filter(p => p.state === 'open' && !decided(p)).length;

  return (
    <Page title="Branch reviews" intro={data ? `${waiting} pull request${waiting === 1 ? '' : 's'} waiting for you.` : 'Loading…'}
      actions={<>
        <button type="button" className={`m-btn${tab === 'prs' ? ' primary' : ''}`} onClick={() => setTab('prs')}>Pull requests</button>
        <button type="button" className={`m-btn${tab === 'walks' ? ' primary' : ''}`} onClick={() => setTab('walks')}>Walkthroughs</button>
      </>}>
      {error && <p className="m-error">{error}</p>}
      {data && !data.configured && <Setup />}
      {data && data.configured && !data.token && <p className="m-badge warn">GITHUB_REVIEW_TOKEN is not set: you can look, but not approve.</p>}
      {data?.preview && data.preview.state !== 'idle' && <PreviewBar p={data.preview} />}

      {tab === 'prs' && data && (
        <>
          <Table rows={prs} rowKey={p => `${p.repo}#${p.pr}`} selected={current ? `${current.repo}#${current.pr}` : undefined}
            onRow={p => setPick(`${p.repo}#${p.pr}`)} empty="No pull requests yet." columns={[
              { key: 'pr', label: '#', numeric: true, render: p => <a href={p.url} target="_blank" rel="noreferrer">{p.pr}</a> },
              { key: 'title', label: 'Pull request', render: p => <><strong>{p.title}</strong> <span className="m-muted">{p.repo}</span></> },
              { key: 'author', label: 'By' },
              { key: 'checks', label: 'Checks', render: p => <span className={`m-badge ${checksOk(p.checks) ? 'good' : 'bad'}`}>{checksOk(p.checks) ? 'pass' : 'failing'}</span> },
              { key: 'screens', label: 'Screens', render: p => p.report ? <span className={`m-badge${p.report.attention ? ' warn' : ''}`}>{p.report.screens.length}{p.report.attention ? ' · look' : ''}</span> : <span className="m-muted">recording…</span> },
              { key: 'you', label: 'You', render: p => p.state !== 'open' ? <span className="m-badge">{p.state}</span>
                : decided(p) === 'APPROVE' ? <span className="m-badge good">approved</span>
                : decided(p) === 'REQUEST_CHANGES' ? <span className="m-badge bad">changes asked</span>
                : <span className="m-badge warn">waiting</span> },
              { key: 'updated', label: 'Updated', render: p => ago(p.updated_at) },
            ]} />
          {current && <PrDetail key={`${current.repo}#${current.pr}@${current.head_sha}`} pr={current} canDecide={data.token} onDone={reload} />}
        </>
      )}

      {tab === 'walks' && data && <Walkthroughs walks={data.walkthroughs} />}
    </Page>
  );
}

// ── one pull request: description, checks, screens before/after, decision ──
function PrDetail({ pr, canDecide, onDone }: { pr: Pr; canDecide: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const screens = pr.report?.screens ?? [];

  async function send(action: 'decide' | 'preview', event?: 'APPROVE' | 'REQUEST_CHANGES') {
    setBusy(true); setMsg(null);
    const { ok, data } = await postJson('/api/admin/reviews', { action, repo: pr.repo, pr: pr.pr, event, body: note });
    setBusy(false);
    setMsg(ok ? { ok: true, text: action === 'preview' ? 'Preview asked for: it starts within a few minutes.' : event === 'APPROVE' ? 'Approved on GitHub.' : 'Changes asked for on GitHub.' }
      : { ok: false, text: data.error ?? 'Could not send.' });
    if (ok) onDone();
  }

  return (
    <section className="m-card rv-detail">
      <div className="m-row">
        <h2 style={{ margin: 0 }}>#{pr.pr} {pr.title}</h2>
        <a className="m-btn" href={`${pr.url}/files`} target="_blank" rel="noreferrer">The code on GitHub</a>
        {pr.state === 'open' && <button type="button" className="m-btn" disabled={busy} onClick={() => send('preview')}>Open a live preview</button>}
      </div>
      <p className="m-muted">by {pr.author} · commit {pr.head_sha.slice(0, 7)} · updated {ago(pr.updated_at)}</p>
      <div className="m-row">
        {Object.entries(pr.checks).map(([k, v]) => <span key={k} className={`m-badge ${v === 'success' ? 'good' : v === 'pending' || v === 'in_progress' ? 'warn' : 'bad'}`}>{k}: {v}</span>)}
        {pr.report?.gui?.failed.length ? <span className="m-badge bad">GUI suite failing: {pr.report.gui.failed.join(', ')}</span> : null}
      </div>
      {pr.body && <pre className="rv-body">{pr.body}</pre>}

      {/* ── the screens ── */}
      {!pr.report && <p className="m-muted">The demo agent hasn&apos;t finished recording this commit yet.</p>}
      {pr.report && !screens.length && <p className="m-muted">This change touches no screen (docs, tests or scripts only).</p>}
      {screens.map(s => (
        <div key={s.id} className="rv-screen">
          <div className="m-row">
            <strong>{s.id}</strong>
            <span className="m-muted">{s.before?.loadMs ?? '–'} → {s.after?.loadMs ?? '–'} ms</span>
            {s.flags.map(f => <span key={f} className="m-badge warn">{f}</span>)}
          </div>
          <div className="rv-pair">
            <figure><figcaption>Before (main)</figcaption>
              {s.before ? <a href={file(`${pr.dir}/before/${s.file}.png`)} target="_blank" rel="noreferrer"><img src={file(`${pr.dir}/before/${s.file}.png`)} alt={`${s.id} before`} loading="lazy" /></a> : <p className="m-muted">Not on main yet.</p>}
            </figure>
            <figure><figcaption>After (this branch)</figcaption>
              {s.after ? <a href={file(`${pr.dir}/after/${s.file}.png`)} target="_blank" rel="noreferrer"><img src={file(`${pr.dir}/after/${s.file}.png`)} alt={`${s.id} after`} loading="lazy" /></a> : <p className="m-muted">Gone in this branch.</p>}
            </figure>
          </div>
          {s.after && (
            <details>
              <summary>Video and phone view</summary>
              <div className="rv-pair">
                <video controls preload="none" src={file(`${pr.dir}/after/${s.file}.webm`)} />
                <img className="rv-phone" src={file(`${pr.dir}/after/${s.file}.phone.png`)} alt={`${s.id} on a phone`} loading="lazy" />
              </div>
            </details>
          )}
          {s.newErrors.length > 0 && <pre className="rv-body">{s.newErrors.join('\n')}</pre>}
        </div>
      ))}

      {/* ── decision ── */}
      {pr.state === 'open' && (
        <div className="rv-decide">
          <textarea className="m-input" rows={3} placeholder="A note for the author (needed when asking for changes)" value={note} onChange={e => setNote(e.target.value)} />
          <div className="m-row">
            <button type="button" className="m-btn primary" disabled={busy || !canDecide} onClick={() => send('decide', 'APPROVE')}>Approve</button>
            <button type="button" className="m-btn danger" disabled={busy || !canDecide} onClick={() => send('decide', 'REQUEST_CHANGES')}>Request changes</button>
            {decided(pr) && <span className="m-muted">You {decided(pr) === 'APPROVE' ? 'approved' : 'asked for changes on'} this commit {ago(pr.decision!.at)}.</span>}
            <Notice msg={msg} />
          </div>
        </div>
      )}
    </section>
  );
}

// ── walkthroughs: the whole suite after each merge ──
function Walkthroughs({ walks }: { walks: Walk[] }) {
  const [i, setI] = useState(0);
  const w = walks[i];
  if (!w) return <div className="m-card m-empty">No walkthroughs yet: one is recorded after each merge to main.</div>;
  return (
    <section className="m-card">
      <div className="m-row">
        <select className="ws-select" style={{ width: 'auto' }} value={i} onChange={e => setI(Number(e.target.value))}>
          {walks.map((x, n) => <option key={x.dir} value={n}>{x.repo} · {x.sha.slice(0, 7)} · {new Date(x.at).toLocaleString()}</option>)}
        </select>
        <a className="m-btn" href={file(`${w.dir}/walkthrough.webm`)} download>Download the video</a>
      </div>
      <video className="rv-walk" controls preload="metadata" src={file(`${w.dir}/walkthrough.webm`)} />
      <div className="m-grid">
        {w.screens.map(s => (
          <a key={s.id} href={file(`${w.dir}/${s.file}.png`)} target="_blank" rel="noreferrer" className="rv-thumb">
            <img src={file(`${w.dir}/${s.file}.png`)} alt={s.id} loading="lazy" /><span>{s.id}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function PreviewBar({ p }: { p: Preview }) {
  return (
    <div className={`m-badge ${p.state === 'running' ? 'good' : p.state === 'failed' ? 'bad' : 'warn'}`} style={{ padding: '6px 12px' }}>
      Live preview {p.repo} #{p.pr}: {p.state}
      {p.state === 'running' && p.url && <> · <a href={p.url} target="_blank" rel="noreferrer">open it</a></>}
      {p.stops_at && <> · stops {new Date(p.stops_at).toLocaleTimeString()}</>}
      {p.message && <> · {p.message}</>}
    </div>
  );
}

function Setup() {
  return (
    <section className="m-card m-prose">
      <h2>Not set up on this site yet</h2>
      <p>Branch reviews read what the server&apos;s review sync downloads from GitHub. On the server:</p>
      <ol>
        <li>Put a fine-grained GitHub token (pull requests: read and write; actions: read) in the private
          <code> arcium_production_site/secrets</code>, as <code>GITHUB_REVIEW_TOKEN</code>.</li>
        <li>Set <code>REVIEWS_DIR</code> (e.g. <code>/var/www/reviews</code>) for this site and the sync.</li>
        <li>Start the sync: <code>arcium_production_site/server/review-sync.py</code> (cron, every 5 minutes).</li>
      </ol>
    </section>
  );
}
