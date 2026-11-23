'use client';

// The workspace shell (every /w page): a slim bar docked to any edge, a side panel with the dashboard menu and the
// saved workspaces, and the open dashboards as tabs. Everything it lists comes from src/modules/registry.ts; the
// arrangement is saved to the user's preferences (src/shell/prefs.ts).
//
//   bar     ☰ shows or hides the panel · the logo goes to the workspace home · the initial opens the account menu
//   panel   Dashboards: open one; "Choose what the menu lists" sets the menu from a checklist
//           Workspace: switch, save as, delete; and where the bar sits
//   main    the tabs, then the open dashboard

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ModuleInfo } from '@/modules/registry';
import { DEFAULT_PREFS, readPrefs, type Dock, type Layout, type WorkspacePrefs } from './prefs';

interface Me { username: string; role: string; display_name?: string }

const DOCKS: { value: Dock; label: string }[] = [
  { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
  { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' },
];

export default function Shell({ me, modules, initial, children }: {
  me: Me; modules: ModuleInfo[]; initial: unknown; children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // ── state: the arrangement (only dashboards this person may open survive a load) ──
  const known = useMemo(() => new Map(modules.map(m => [m.id, m])), [modules]);
  const clean = useCallback((p: WorkspacePrefs): WorkspacePrefs => ({
    ...p, tabs: p.tabs.filter(id => known.has(id)), menu: p.menu && p.menu.filter(id => known.has(id)),
  }), [known]);
  const [prefs, setPrefs] = useState<WorkspacePrefs>(() => clean(readPrefs(initial ?? DEFAULT_PREFS)));
  const [editing, setEditing] = useState(false);
  const [account, setAccount] = useState(false);
  const active = pathname.startsWith('/w/') ? decodeURIComponent(pathname.slice(3).split('/')[0]) : '';
  const title = (id: string) => known.get(id)?.title ?? id;

  // ── saving: debounced, whenever the arrangement changes ──
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      fetch('/api/user-preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: prefs }) }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [prefs]);

  // The dashboard on screen is always one of the tabs.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the URL, which changes outside React
    if (active && known.has(active) && !prefs.tabs.includes(active)) setPrefs(p => ({ ...p, tabs: [...p.tabs, active] }));
  }, [active, known, prefs.tabs]);

  // ── the menu: dashboards by group, filtered by the checklist ──
  const menuIds = prefs.menu ?? modules.map(m => m.id);
  const groups = useMemo(() => {
    const out = new Map<string, ModuleInfo[]>();
    for (const m of modules) out.set(m.group, [...(out.get(m.group) ?? []), m]);
    return [...out.entries()];
  }, [modules]);

  // ── actions ──
  const open = (id: string) => { if (id) router.push(`/w/${encodeURIComponent(id)}`); };
  const close = (id: string) => {
    const tabs = prefs.tabs.filter(t => t !== id);
    setPrefs(p => ({ ...p, tabs }));
    if (id === active) router.push(tabs.length ? `/w/${encodeURIComponent(tabs[tabs.length - 1])}` : '/w');
  };
  const toggleMenu = (id: string) => setPrefs(p => {
    const cur = p.menu ?? modules.map(m => m.id);
    return { ...p, menu: cur.includes(id) ? cur.filter(x => x !== id) : modules.map(m => m.id).filter(x => x === id || cur.includes(x)) };
  });
  const layoutOf = (p: WorkspacePrefs): Layout => ({ dock: p.dock, menu: p.menu, tabs: p.tabs });
  const switchTo = (name: string) => {
    const l = prefs.saved[name];
    if (!l) return;
    const next = clean({ ...prefs, ...l, saved: { ...prefs.saved, [prefs.current]: layoutOf(prefs) }, current: name });
    setPrefs(next);
    router.push(next.tabs.length ? `/w/${encodeURIComponent(next.tabs[0])}` : '/w');
  };
  const saveAs = () => {
    const name = window.prompt('Save this workspace as:', prefs.current)?.trim().slice(0, 40);
    if (name) setPrefs(p => ({ ...p, current: name, saved: { ...p.saved, [name]: layoutOf(p) } }));
  };
  const remove = () => {
    if (!window.confirm(`Delete the workspace "${prefs.current}"?`)) return;
    setPrefs(p => { const saved = { ...p.saved }; delete saved[p.current]; return { ...p, saved, current: 'Main' }; });
  };
  const signOut = async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  };

  const workspaces = [...new Set([prefs.current, ...Object.keys(prefs.saved)])];
  const name = me.display_name || me.username;

  return (
    <div className={`ws ws-dock-${prefs.dock}${prefs.panel ? ' ws-panel-open' : ''}`}>
      {/* ── bar ── */}
      <nav className="ws-bar" aria-label="Workspace">
        <button type="button" className="ws-icon" aria-expanded={prefs.panel} aria-controls="ws-panel"
          title={prefs.panel ? 'Hide the panel' : 'Show the panel'} onClick={() => setPrefs(p => ({ ...p, panel: !p.panel }))}>☰</button>
        <Link className="ws-brand" href="/w" title="Workspace home">
          <img src="/arcium-signals-card-32.png" alt="Arcium Signals" width={22} height={22} />
        </Link>
        <span className="ws-grow" />
        <div className="ws-account">
          <button type="button" className="ws-icon ws-avatar" title={name} aria-haspopup="menu"
            aria-expanded={account} onClick={() => setAccount(a => !a)}>{name.slice(0, 1).toUpperCase()}</button>
          {account && (
            <div className="ws-pop" role="menu">
              <div className="ws-pop-head">{name}</div>
              <button type="button" role="menuitem" onClick={() => { setAccount(false); open('account.profile'); }}>Your account</button>
              <button type="button" role="menuitem" onClick={signOut}>Sign out</button>
            </div>
          )}
        </div>
      </nav>

      {/* ── panel ── */}
      {prefs.panel && (
        <aside id="ws-panel" className="ws-panel" aria-label="Dashboards and workspaces">
          <section className="ws-section">
            <label className="ws-field">
              <span>Dashboards</span>
              <select className="ws-select" value={menuIds.includes(active) ? active : ''} onChange={e => open(e.target.value)}>
                <option value="">Open a dashboard…</option>
                {groups.map(([g, ms]) => {
                  const shown = ms.filter(m => menuIds.includes(m.id));
                  return shown.length ? (
                    <optgroup key={g} label={g}>
                      {shown.map(m => <option key={m.id} value={m.id}>{m.title}{m.status === 'planned' ? ' (planned)' : ''}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
            <button type="button" className="ws-link" aria-expanded={editing} onClick={() => setEditing(e => !e)}>
              {editing ? 'Done' : 'Choose what the menu lists'}
            </button>
            {editing && (
              <div className="ws-check" role="group" aria-label="Dashboards in the menu">
                <div className="ws-check-actions">
                  <button type="button" className="ws-link" onClick={() => setPrefs(p => ({ ...p, menu: null }))}>All</button>
                  <button type="button" className="ws-link" onClick={() => setPrefs(p => ({ ...p, menu: modules.filter(m => m.status === 'live').map(m => m.id) }))}>Built only</button>
                </div>
                {groups.map(([g, ms]) => (
                  <fieldset key={g}>
                    <legend>{g}</legend>
                    {ms.map(m => (
                      <label key={m.id} className="ws-check-row" title={m.summary}>
                        <input type="checkbox" checked={menuIds.includes(m.id)} onChange={() => toggleMenu(m.id)} />
                        <span>{m.title}</span>{m.status === 'planned' && <em>planned</em>}
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
          </section>

          <section className="ws-section">
            <label className="ws-field">
              <span>Workspace</span>
              <select className="ws-select" value={prefs.current} onChange={e => switchTo(e.target.value)}>
                {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <div className="ws-row">
              <button type="button" className="ws-btn" onClick={saveAs}>Save as…</button>
              {prefs.current in prefs.saved && <button type="button" className="ws-btn" onClick={remove}>Delete</button>}
            </div>
            <label className="ws-field ws-field-inline">
              <span>Bar</span>
              <select className="ws-select" value={prefs.dock} onChange={e => setPrefs(p => ({ ...p, dock: e.target.value as Dock }))}>
                {DOCKS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
          </section>
        </aside>
      )}

      {/* ── main: tabs, then the dashboard ── */}
      <main className="ws-main">
        {prefs.tabs.length > 0 && (
          <div className="ws-tabs" role="tablist" aria-label="Open dashboards">
            {prefs.tabs.map(id => (
              <div key={id} className={`ws-tab${id === active ? ' on' : ''}`} role="presentation">
                <a role="tab" aria-selected={id === active} href={`/w/${encodeURIComponent(id)}`}
                  onClick={e => { e.preventDefault(); open(id); }}>{title(id)}</a>
                <button type="button" aria-label={`Close ${title(id)}`} onClick={() => close(id)}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="ws-content">{children}</div>
      </main>
    </div>
  );
}
