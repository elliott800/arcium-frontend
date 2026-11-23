// Shapes the Data Hub page shares with its API (no server imports: used by the page and the routes).

import { DrillTree, type DrillNode, type TagQuery } from '@/lib/drillTree';

/** Every frequency the rate checklists show, finest first; the ones an item can't record are shown greyed out. */
export const ALL_RATES = ['Tick', 'S5', 'S10', 'S15', 'S30', 'M1', 'M2', 'M4', 'M5', 'M10', 'M15', 'M30',
  'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D', 'W', 'M'];

/** Rates the owner records by default, ticked first in the Recorder's Data rates control (owner, Nov 16 2026). */
export const DEFAULT_RATES = ['H4', 'D'];

/** Option chains: a 4-hour snapshot of the nearest expiries and the full chain daily; nothing finer (owner, Nov 16 2026). */
export const OPTION_RATES = ['H4', 'D'];
export const isOptionChain = (key: string) => key.endsWith('options.chain');

export type DhCategory = 'instrument' | 'reference';

/** A recording at one rate (or the item's only recording when the key has no rate): one hub hook. */
export interface DhHook {
  hook_id: string; rate: string | null; enabled: boolean; status: string | null; error: string | null;
  every: number; ran: string | null; disabled_by: string | null;
}

/** One stored series of an item (a warehouse stream). */
export interface DhStored {
  series_id: number; store: string; rate: string | null; part: string; field: string;
  rows: number; first: string | null; last: string | null;
}

/** A node of the Data Hub's drill tables (the site's standard DrillNode, with the hub's own fields). Leaves are items:
 *  one thing a source records (an instrument, a FRED series ...). */
export interface DhNode extends DrillNode {
  source?: string;          // the source connection (leaves, and source branches)
  format?: string;
  contents?: string;
  tags: string[];
  count: number;            // items beneath (1 for a leaf)
  children?: DhNode[];
  item?: { connection: string; key: string; param: string; value: string; allowed: string[]; changeable: boolean; hooks: DhHook[] };
  stored?: DhStored[];
  lazy?: 'options';         // children load on expand (option months and strikes)
}

export interface DhSourceKey {
  key: string; hooks: number; on: number; failing: number; last_run: string | null;
  stored_series: number; stored_rows: number;
  map: {
    category: DhCategory; structure: 'Structured' | 'Unstructured' | 'Stats' | null; group: string; form: 'Spot' | 'Future' | 'Option' | null;
    format: string; store: string; item: string; request: string; tags: string[]; saved: boolean;
    updated_by?: string | null; updated_at?: string | null;
  };
}
export interface DhSource {
  connection: string; type: string; enabled: boolean; error: string | null;
  categories: DhCategory[]; warehouse: boolean; keys: DhSourceKey[];
}

export interface DhHome {
  sources: number; hooks: number; on: number; failing: number; streams: number; rows: number;
  lists: number; recording_lists: number; recorder_running: boolean; recorder_tick: string | null; database_size: string | null;
}

// ---- tag search and filtering: the site's standard drill tree (src/lib/drillTree.ts) ------------------------------------

export { parseTagQuery, matchesQuery, isEmptyQuery as emptyQuery, type TagQuery } from '@/lib/drillTree';

/** The tree cut down to items matching the query (DrillTree.filter). */
export function filterTree(nodes: DhNode[], q: TagQuery | string): DhNode[] {
  return new DrillTree(nodes).filter(q).nodes as DhNode[];
}

export function countItems(nodes: DhNode[]): number {
  return new DrillTree(nodes).size;
}

export const fmtInterval = (s: number) => (s >= 86400 ? `${Math.round(s / 86400)} d` : s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
export const ymd = (s: string | null) => (s ? new Date(s).toISOString().slice(0, 10) : '?');
