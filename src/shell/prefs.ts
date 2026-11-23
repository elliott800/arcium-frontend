// The workspace a person arranges: where the nav bar is docked, which dashboards the menu lists (set from
// the checklist), which are open as tabs, and named workspaces to switch between. Stored in the user's
// preferences (user_preferences, key `workspace`) so it follows them to any browser.
export type Dock = 'left' | 'right' | 'top' | 'bottom';

export interface Layout {
  dock: Dock;
  menu: string[] | null;          // dashboards listed in the menu; null = every one this person may open
  tabs: string[];                 // open dashboards, in tab order
}

export interface WorkspacePrefs extends Layout {
  panel: boolean;                 // the side panel is shown
  current: string;                // the named workspace in use
  saved: Record<string, Layout>;  // named workspaces
}

export const DEFAULT_PREFS: WorkspacePrefs = {
  dock: 'left', panel: true, menu: null, tabs: [], current: 'Main', saved: {},
};

const DOCKS: Dock[] = ['left', 'right', 'top', 'bottom'];
const ids = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];

/** Whatever is stored, a valid WorkspacePrefs (unknown dashboards are dropped by the shell). */
export function readPrefs(v: unknown): WorkspacePrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const layout = (x: unknown): Layout => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      dock: DOCKS.includes(l.dock as Dock) ? l.dock as Dock : 'left',
      menu: l.menu === null || l.menu === undefined ? null : ids(l.menu),
      tabs: ids(l.tabs),
    };
  };
  const saved: Record<string, Layout> = {};
  if (o.saved && typeof o.saved === 'object') {
    for (const [k, x] of Object.entries(o.saved as Record<string, unknown>).slice(0, 30)) saved[k.slice(0, 40)] = layout(x);
  }
  return { ...layout(o), panel: o.panel !== false, current: typeof o.current === 'string' ? o.current.slice(0, 40) : 'Main', saved };
}
