'use client';

// Hub versions waiting for the admin: a repo going public, or a new version of a public one.
// Open one to read its files and checks, then approve (it becomes the public version) or reject with a note.

import { useCallback, useEffect, useState } from 'react';
import { HUBS, type HubId } from '@/lib/hub-origins';

interface Pending {
  hub: HubId; owner_username: string; name: string; description: string; code_visible: boolean; published_version: number | null;
  number: number; message: string; author: string; created_at: string; file_count: number; total_bytes: number;
}
interface Detail { files: { path: string; size: number }[]; checks: { ok: boolean; text: string }[] }

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const key = (p: Pending) => `${p.hub}/${p.owner_username}/${p.name}@${p.number}`;
const repoApi = (p: Pending) => `/api/hubs/${p.hub}/repos/${encodeURIComponent(p.owner_username)}/${encodeURIComponent(p.name)}/versions/${p.number}`;

export default function HubReviewsPanel({ onCount }: { onCount?: (n: number) => void }) {
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [file, setFile] = useState<{ path: string; text: string | null } | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch('/api/admin/hub-reviews').then(r => (r.ok ? r.json() : { pending: [] }))
      .then(j => { setPending(j.pending); onCount?.(j.pending.length); }).catch(() => setPending([]));
  }, [onCount]);
  useEffect(load, [load]);

  function toggle(p: Pending) {
    const k = key(p);
    setFile(null); setNote(''); setMsg('');
    if (open === k) { setOpen(null); return; }
    setOpen(k); setDetail(null);
    fetch(repoApi(p)).then(r => r.json()).then(setDetail).catch(() => setDetail({ files: [], checks: [] }));
  }
  function show(p: Pending, path: string) {
    fetch(`${repoApi(p)}?path=${encodeURIComponent(path)}`).then(r => r.json())
      .then(j => setFile({ path, text: j.text ?? null })).catch(() => setFile({ path, text: null }));
  }
  async function decide(p: Pending, approve: boolean) {
    const r = await fetch('/api/admin/hub-reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hub: p.hub, owner: p.owner_username, name: p.name, number: p.number, approve, note }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(j.error ?? 'Could not save the review.'); return; }
    setOpen(null); load();
  }

  if (!pending) return <p className="c-hint">Loading…</p>;
  return (
    <>
      <p className="c-hint">Nothing on a hub goes public without your approval: publishing a repo, and every new version of a public one, waits here. Uploaded code is only stored and shown, never run.</p>
      {pending.length === 0 && <p className="c-ok">Nothing waiting for review.</p>}
      <ul className="c-reviews">
        {pending.map(p => {
          const k = key(p);
          return (
            <li key={k} className="c-panel c-review">
              <button type="button" className="c-review-head" aria-expanded={open === k} onClick={() => toggle(p)}>
                <strong>{HUBS[p.hub].name} · {p.owner_username} / {p.name} · v{p.number}</strong>
                <span>{p.message} · {p.file_count} files, {kb(p.total_bytes)} · {p.published_version ? `public now at v${p.published_version}` : 'first publication'}{p.code_visible ? '' : ' · code hidden'}</span>
              </button>
              {open === k && (
                <div className="c-review-body">
                  {p.description && <p className="c-hint">{p.description}</p>}
                  {!detail ? <p className="c-hint">Loading files…</p> : (
                    <>
                      <ul className="c-checks">{detail.checks.map(c => <li key={c.text} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '!'} {c.text}</li>)}</ul>
                      <div className="c-review-files">
                        <ul>{detail.files.map(f => (
                          <li key={f.path}><button type="button" className={file?.path === f.path ? 'on' : ''} onClick={() => show(p, f.path)}>{f.path}<span>{kb(f.size)}</span></button></li>
                        ))}</ul>
                        <pre className="c-review-code">{file ? (file.text ?? 'Binary file, not shown.') : 'Pick a file to read it.'}</pre>
                      </div>
                    </>
                  )}
                  <div className="c-form-row">
                    <input className="p-search" placeholder="Note to the author (optional)" value={note} onChange={e => setNote(e.target.value)} maxLength={500} />
                    <button className="p-dash-btn p-dash-btn--accent" onClick={() => decide(p, true)}>Approve</button>
                    <button className="p-dash-btn" onClick={() => decide(p, false)}>Reject</button>
                    <a className="c-top-link" href={`${HUBS[p.hub].origin}/#/r/${encodeURIComponent(p.owner_username)}/${encodeURIComponent(p.name)}`}>Open on the hub</a>
                  </div>
                  {msg && <p className="c-warn">{msg}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
