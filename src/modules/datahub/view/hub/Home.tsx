'use client';

// Data Hub Home: find anything by symbol, see what each source is recording and whether it is up to date, and a short
// guide to how the hub works. Built on /api/admin/datahub/streams (every stored series, with freshness).

import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Preview } from './Warehouse';
import { ago, keyName, rateName, sourceAbout, sourceName } from '@/lib/datahubNames';
import type { DhStored } from '@/lib/datahubTypes';

interface Stream {
  series_id: number; store: string; part: string; field: string; rows: number; first: string | null; last: string | null;
  hook_id: string; source: string; key: string; symbol: string; rate: string | null; enabled: boolean;
  every: number; status: string | null; error: string | null; ran: string | null; fresh: boolean;
}
interface SummaryRow { source: string; kind: string; streams: number; rows: number | string; fresh: number; stale: number; off: number; last: string | null }

type Section = 'recorder' | 'sources' | 'warehouse';

function state(s: Pick<Stream, 'enabled' | 'status' | 'fresh'>): { label: string; cls: string } {
  if (!s.enabled) return { label: 'Off', cls: '' };
  if (s.status && s.status !== 'ok') return { label: 'Failing', cls: 'is-bad' };
  return s.fresh ? { label: 'Up to date', cls: 'is-good' } : { label: 'Behind', cls: 'is-warn' };
}

const rateText = (s: Pick<Stream, 'rate' | 'store'>) => s.rate ? `${s.rate} · ${rateName(s.rate)}` : s.store === 'options' ? 'snapshots' : 'as published';

function Find({ onOpen }: { onOpen: (s: Section, source?: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Stream[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<DhStored | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setRows(null); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api<{ streams: Stream[] }>(`/api/admin/datahub/streams?q=${encodeURIComponent(term)}`)
        .then(d => { setRows(d.streams); setErr(''); }).catch(e => setErr(e.message)).finally(() => setBusy(false));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);
  // symbol -> (source, key) groups, each a recording with its stored series
  const groups = useMemo(() => {
    const out = new Map<string, Map<string, Stream[]>>();
    for (const s of rows ?? []) {
      const sym = s.symbol || s.hook_id;
      const g = out.get(sym) ?? new Map<string, Stream[]>();
      const k = `${s.source}|${s.key}|${s.rate ?? ''}`;
      g.set(k, [...(g.get(k) ?? []), s]);
      out.set(sym, g);
    }
    return [...out].slice(0, 12);
  }, [rows]);

  return (
    <section className="panel dhx-find" aria-label="Find data">
      <div className="panel-heading"><div><h3>Find data</h3>
        <p>Type a symbol or series: a stock (AAPL), an ETF (SPY), a currency pair (EUR_USD) or an economic series (UNRATE). You&apos;ll see
          every source that records it, how often, how much is stored and whether it&apos;s up to date.</p></div></div>
      <input className="builder-input dhx-find-input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="AAPL, SPY, EUR_USD, UNRATE…"
        aria-label="Symbol or series to find" autoComplete="off" />
      {err && <p className="dhx-err">{err}</p>}
      {busy && <p className="empty-state">Looking…</p>}
      {!busy && rows && !rows.length && <p className="empty-state">Nothing stored matches “{q.trim()}”. Check the spelling, or add it in the Recorder.</p>}
      {!busy && groups.map(([sym, recs]) => {
        const all = [...recs.values()].flat();
        const latest = all.reduce<string | null>((m, s) => (s.last && (!m || s.last > m) ? s.last : m), null);
        return (
          <div key={sym} className="dhx-find-symbol">
            <h4>{sym} <small>{recs.size} recording{recs.size === 1 ? '' : 's'} · {all.reduce((n, s) => n + Number(s.rows), 0).toLocaleString()} rows · newest data {ago(latest) || '—'}</small></h4>
            <div className="dhx-scroll"><table className="source-summary-table">
              <thead><tr><th>Source</th><th>What</th><th>How often</th><th>Stored</th><th>Newest</th><th>State</th><th /></tr></thead>
              <tbody>{[...recs.values()].map(ss => {
                const s = ss[0];
                const st = state(s);
                const rowsN = ss.reduce((n, x) => n + Number(x.rows), 0);
                const newest = ss.reduce<string | null>((m, x) => (x.last && (!m || x.last > m) ? x.last : m), null);
                return (
                  <tr key={`${s.hook_id}`}>
                    <td><strong>{sourceName(s.source)}</strong></td>
                    <td>{keyName(s.source, s.key)}{ss.length > 1 ? <small> · {ss.length} series</small> : null}</td>
                    <td>{rateText(s)}</td>
                    <td>{rowsN.toLocaleString()} rows<small> since {s.first ? String(s.first).slice(0, 10) : '—'}</small></td>
                    <td>{ago(newest) || '—'}</td>
                    <td><span className={`dhx-chip ${st.cls}`} title={s.error ?? ''}>{st.label}</span></td>
                    <td className="dhx-actions">
                      <button type="button" className="text-action" onClick={() => setPreview(s as unknown as DhStored)}>Preview</button>
                      <a className="text-action" href={`/api/admin/datahub/streams/rows?series_id=${s.series_id}&format=csv`} download>CSV</a>
                      <button type="button" className="text-action" onClick={() => onOpen('recorder', s.source)}>Recorder</button>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </div>
        );
      })}
      {rows && rows.length >= 500 && <p className="form-help">Showing the first 500 matches; type more of the name to narrow it.</p>}
      {preview && <Preview s={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

function Glance({ onOpen }: { onOpen: (s: Section, source?: string) => void }) {
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ summary: SummaryRow[] }>('/api/admin/datahub/streams').then(d => setRows(d.summary)).catch(e => setErr(e.message)); }, []);
  const bySource = useMemo(() => {
    const m = new Map<string, { streams: number; rows: number; fresh: number; stale: number; off: number; last: string | null; kinds: Set<string> }>();
    for (const r of rows ?? []) {
      const x = m.get(r.source) ?? { streams: 0, rows: 0, fresh: 0, stale: 0, off: 0, last: null, kinds: new Set<string>() };
      x.streams += r.streams; x.rows += Number(r.rows); x.fresh += r.fresh; x.stale += r.stale; x.off += r.off; x.kinds.add(r.kind);
      if (r.last && (!x.last || r.last > x.last)) x.last = r.last;
      m.set(r.source, x);
    }
    return [...m].sort((a, b) => b[1].rows - a[1].rows);
  }, [rows]);
  return (
    <section className="panel" aria-label="What each source is recording">
      <div className="panel-heading"><div><h3>What&apos;s recording</h3>
        <p>Each source, what it provides, and how many of its series are up to date. <strong>Behind</strong> means the recorder hasn&apos;t
          refreshed it within three of its intervals; <strong>Off</strong> means it is paused. Open a source in the Recorder to change it.</p></div></div>
      {err && <p className="dhx-err">{err}</p>}
      {!rows ? <p className="empty-state">Loading…</p> : (
        <div className="dhx-scroll"><table className="source-summary-table">
          <thead><tr><th>Source</th><th>Series</th><th>Up to date</th><th>Behind</th><th>Off</th><th>Rows stored</th><th>Newest data</th><th /></tr></thead>
          <tbody>{bySource.map(([src, x]) => (
            <tr key={src}>
              <td><strong>{sourceName(src)}</strong><br /><small>{sourceAbout(src)}</small></td>
              <td>{x.streams.toLocaleString()}</td>
              <td><span className="dhx-chip is-good">{x.fresh.toLocaleString()}</span></td>
              <td>{x.stale ? <span className="dhx-chip is-warn">{x.stale.toLocaleString()}</span> : '0'}</td>
              <td>{x.off ? x.off.toLocaleString() : '0'}</td>
              <td>{x.rows.toLocaleString()}</td>
              <td>{ago(x.last) || '—'}</td>
              <td><button type="button" className="text-action" onClick={() => onOpen('recorder', src)}>Open in Recorder</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function HowItWorks() {
  return (
    <details className="panel dhx-howto">
      <summary><strong>How the Data Hub works</strong> <small>(three steps)</small></summary>
      <ol>
        <li><strong>Sources</strong> are the providers the hub connects to (Webull, SEC EDGAR, OANDA, FRED…). Only the Data Hub talks to them;
          everything else in Arcium reads what the hub has stored.</li>
        <li><strong>The Recorder</strong> decides what is recorded and how often. Find a symbol, open its <em>Rates</em> cell and tick the
          intervals you want: a ticked box is a recording that is on, unticked is off (stored data is kept). <em>Bundle view</em> groups
          recordings by source, such as Webull Nasdaq 100 or FRED Macro factors, with one switch for the whole bundle.</li>
        <li><strong>The Warehouse</strong> is everything stored, by source and date range. Preview the newest rows or download a CSV.
          Other projects read it through the warehouse endpoints with their machine key.</li>
      </ol>
    </details>
  );
}

export default function Home({ onOpen }: { onOpen: (s: Section, source?: string) => void }) {
  return (
    <div className="dhx-home">
      <Find onOpen={onOpen} />
      <Glance onOpen={onOpen} />
      <HowItWorks />
    </div>
  );
}
