'use client';

// The Data Hub (admin), in the Arcium Datahub layout: Home, then Recorder, Sources and Warehouse, each with a
// Summary and a Controller, and API keys (the data sources' keys and account IDs). Everything shown is the hub's real data; changes go to the hub's recorder as commands.

import { useCallback, useEffect, useState } from 'react';
import { useNow } from '@/ui/kit';
import Home from './hub/Home';
import Recorder from './hub/Recorder';
import Sources from './hub/Sources';
import Warehouse from './hub/Warehouse';
import ApiKeys from './hub/ApiKeys';
import ApiAccess from './hub/ApiAccess';
import { api, hub } from './hub/api';
import type { DhHome, DhSource } from '@/lib/datahubTypes';

type Section = 'home' | 'recorder' | 'sources' | 'warehouse' | 'keys' | 'access';
const SECTIONS: { id: Section; icon: string; title: string; subtitle: string }[] = [
  { id: 'home', icon: '⌂', title: 'Datahub overview', subtitle: 'Choose a data workspace to explore and manage.' },
  { id: 'recorder', icon: '◉', title: 'Recorder', subtitle: 'Review what is recorded or control the recording pipeline.' },
  { id: 'sources', icon: '⇄', title: 'Sources', subtitle: 'Inspect connected providers, map their requests and control their access.' },
  { id: 'warehouse', icon: '▤', title: 'Warehouse', subtitle: 'Explore stored data or check warehouse readiness.' },
  { id: 'keys', icon: '⚿', title: 'API keys', subtitle: 'The keys, account IDs and settings each data source uses (admin only).' },
  { id: 'access', icon: '⛁', title: 'API access', subtitle: 'Guest access to the Data Hub API and the processed-data subscriptions (admin only).' },
];
const LABEL: Record<Section, string> = { home: 'Home', recorder: 'Recorder', sources: 'Sources', warehouse: 'Warehouse', keys: 'API keys', access: 'API access' };

export default function DataHubPanel() {
  const now = useNow(5000);
  const [section, setSection] = useState<Section>('home');
  const [panel, setPanel] = useState<'summary' | 'controller'>('summary');
  const [home, setHome] = useState<DhHome | null>(null);
  const [sources, setSources] = useState<DhSource[] | null>(null);
  const [err, setErr] = useState('');
  const [rainbow, setRainbowState] = useState(true);
  const [focusSource, setFocusSource] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    api<DhHome>(hub({ view: 'home' })).then(setHome).catch(e => setErr(e.message));
    api<{ sources: DhSource[] }>(hub({ view: 'sources' })).then(d => setSources(d.sources)).catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    try { const v = localStorage.getItem('dhx.rainbow'); if (v !== null) setRainbowState(v === '1'); } catch { /* storage unavailable */ }
    try { const s = new URLSearchParams(window.location.search).get('section') as Section | null; if (s && LABEL[s]) setSection(s); } catch { /* ignore */ }
  }, []);
  const setRainbow = (b: boolean) => { setRainbowState(b); try { localStorage.setItem('dhx.rainbow', b ? '1' : '0'); } catch { /* ignore */ } };
  // open a section; from Home, the Recorder can open on one source
  const open = (s: Section, source?: string) => { setSection(s); setPanel('summary'); setFocusSource(source); };
  const meta = SECTIONS.find(s => s.id === section)!;
  const running = !!home?.recorder_running;
  const ago = (iso: string | null) => {
    if (!iso) return '';
    const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  // Home's live figures; while they load, the same tiles show placeholders so nothing jumps.
  const stats: { label: string; value?: string; of?: string; bad?: boolean }[] = [
    { label: 'Sources', value: home?.sources.toLocaleString() },
    { label: 'Recordings on', value: home?.on.toLocaleString(), of: home ? `of ${home.hooks.toLocaleString()}` : undefined },
    { label: 'Failing', value: home?.failing.toLocaleString(), bad: !!home?.failing },
    { label: 'Stored series', value: home?.streams.toLocaleString() },
    { label: 'Stored rows', value: home?.rows.toLocaleString() },
    { label: 'Recording lists', value: home?.recording_lists.toLocaleString(), of: home ? `of ${home.lists}` : undefined },
  ];
  const cardMetric = (id: Section) => !home ? ' ' : id === 'recorder' ? `${home.on.toLocaleString()} recording${home.failing ? ` · ${home.failing} failing` : ''}`
    : id === 'sources' ? `${home.sources} sources connected` : id === 'keys' || id === 'access' ? 'Admin only'
    : `${home.rows.toLocaleString()} rows in ${home.streams.toLocaleString()} series`;

  return (
    <div className="dhx">
      <div className="datahub-shell">
        <aside className="datahub-sidebar" aria-label="Datahub navigation">
          <nav className="datahub-navigation" aria-label="Datahub sections">
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`nav-item${section === s.id ? ' is-active' : ''}`} aria-current={section === s.id ? 'page' : undefined}
                onClick={() => open(s.id)}><span>{s.icon}</span>{LABEL[s.id]}</button>
            ))}
          </nav>
          <div className="sidebar-status" title={home?.recorder_tick ? `Last recorder tick ${new Date(home.recorder_tick).toLocaleString()}` : ''}>
            <span className={`status-dot${running ? '' : ' is-down'}`} /> {home ? (running ? 'Recorder running' : 'Recorder not running') : 'Connecting…'}
          </div>
        </aside>

        <section className="datahub-content" aria-live="polite">
          <header className="page-heading">
            <div><h2>{meta.title}</h2><p>{meta.subtitle}</p></div>
            <div className="dhx-status-strip" aria-label="Recorder status">
              <span className={`dhx-chip ${home ? (running ? 'is-good' : 'is-bad') : ''}`}>
                <span className={`status-dot${home && !running ? ' is-down' : ''}`} />
                {home ? (running ? 'Recorder running' : 'Recorder not running') : 'Connecting…'}
              </span>
              {home?.recorder_tick && <span className="dhx-chip" title={new Date(home.recorder_tick).toLocaleString()}>Last tick {ago(home.recorder_tick)}</span>}
              {!!home?.failing && <button type="button" className="dhx-chip is-warn" onClick={() => open('recorder')}>{home.failing.toLocaleString()} failing</button>}
            </div>
          </header>
          {err && <p className="dhx-err">{err}</p>}
          {section === 'home' ? (
            <>
              <div className={`summary-cards dhx-home-stats${home ? '' : ' is-loading'}`} aria-busy={!home}>
                {stats.map(s => (
                  <div key={s.label} className={`summary-stat${s.bad ? ' is-bad' : ''}`}>
                    <span>{s.label}</span><strong>{s.value ?? '0000'}{s.of && <small> {s.of}</small>}</strong>
                  </div>
                ))}
              </div>
              <Home onOpen={open} />
              <div className="home-grid" aria-label="Datahub workspaces">
                {SECTIONS.filter(s => s.id !== 'home').map(s => (
                  <button key={s.id} type="button" className="home-card" onClick={() => open(s.id)}>
                    <span className="card-icon" aria-hidden="true">{s.icon}</span>
                    <span><strong>{LABEL[s.id]}</strong><small>{s.id === 'recorder' ? 'Recording status, what is recorded, and controls.'
                      : s.id === 'sources' ? 'Connected providers, source maps and access.'
                      : s.id === 'keys' ? 'API keys and account IDs for the data sources.'
                      : s.id === 'access' ? 'Guest access and subscriptions for the Data Hub API.' : 'Stored data, date intervals and readiness.'}</small>
                      <em className="card-metric">{cardMetric(s.id)}</em></span>
                    <span className="card-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </>
          ) : section === 'keys' ? (
            <ApiKeys rainbow={rainbow} />
          ) : section === 'access' ? (
            <ApiAccess rainbow={rainbow} />
          ) : (
            <>
              <div className="section-tabs" role="tablist" aria-label={`${LABEL[section]} views`}>
                {(['summary', 'controller'] as const).map(p => (
                  <button key={p} className={`section-tab${panel === p ? ' is-active' : ''}`} type="button" role="tab" aria-selected={panel === p}
                    onClick={() => setPanel(p)}>{p === 'summary' ? 'Summary' : 'Controller'}</button>
                ))}
              </div>
              {!sources ? <p className="empty-state">Loading the Data Hub…</p>
                : section === 'recorder' ? <Recorder panel={panel} sources={sources} rainbow={rainbow} setRainbow={setRainbow} running={running} initialSource={focusSource} />
                : section === 'sources' ? <Sources panel={panel} setPanel={setPanel} sources={sources} reload={load} rainbow={rainbow} />
                : <Warehouse panel={panel} sources={sources} rainbow={rainbow} setRainbow={setRainbow} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
