// Every dashboard of the workspace, in one list. This file is the GUI's only extension point:
//
//   1. write the dashboard as src/modules/<group>/<name>.tsx (default export: a server component; it may
//      render client components)
//   2. add one entry below with `load: () => import('./<group>/<name>')`
//
// The shell (src/shell) builds the dashboard menu, the checklist, the tabs and the access checks from this
// list; nothing else needs to change. A planned dashboard is an entry with status 'planned' and a `plan`
// (a markdown file in content/planned/): it opens its plan until it gets a `load` of its own.
import type { ComponentType } from 'react';

export type Access = 'user' | 'portal' | 'admin';       // anyone signed in | Factory users | the owner
export type Status = 'live' | 'planned';

/** What a module receives: the URL's query (e.g. /w/macro.analysis?page=factors). */
export interface ModuleProps { searchParams?: Promise<Record<string, string | undefined>> }

export interface ModuleDef {
  id: string;                                            // the URL: /w/<id>
  group: string;                                         // the menu section
  title: string;
  summary: string;
  access: Access;
  status: Status;
  load?: () => Promise<{ default: ComponentType<ModuleProps> }>;
  plan?: string;                                         // content/planned/<plan>.md
}

export const GROUPS = ['Factory', 'Data Hub', 'Macro', 'Control panel', 'Account', 'Planned'] as const;

export const MODULES: ModuleDef[] = [
  // ── Factory: the silos and engines the backend runs on its machines ──
  { id: 'factory.machine', group: 'Factory', title: 'Machine', access: 'portal', status: 'live',
    summary: 'The controller machine: online, training runs, engines, and its controls.',
    load: () => import('./factory/machine') },
  { id: 'factory.silos', group: 'Factory', title: 'Silos', access: 'portal', status: 'live',
    summary: 'Each optimization silo: its settings, its stacks and its best models.',
    load: () => import('./factory/silos') },
  { id: 'factory.engines', group: 'Factory', title: 'Engine Hangar', access: 'portal', status: 'live',
    summary: 'Engines: start or stop a simulated or practice-live run, and watch its equity.',
    load: () => import('./factory/engines') },
  { id: 'factory.catalog', group: 'Factory', title: 'Model catalog', access: 'portal', status: 'live',
    summary: 'Every model the optimizers stored, with its in- and out-of-sample stats.',
    load: () => import('./factory/catalog') },

  // ── Data Hub: the one connection to outside data ──
  { id: 'datahub.hub', group: 'Data Hub', title: 'Data Hub', access: 'admin', status: 'live',
    summary: 'Home, Sources, Recorder (with the Source Bundle Maker) and Warehouse drill tables.',
    load: () => import('./datahub/hub') },
  { id: 'datahub.portfolios', group: 'Data Hub', title: 'Portfolio Maker', access: 'portal', status: 'live',
    summary: 'Watchlists: search, paste or import a fund, filter by tags, apply to a silo.',
    load: () => import('./datahub/portfolios') },

  // ── Macro ──
  { id: 'macro.analysis', group: 'Macro', title: 'Macro analysis', access: 'admin', status: 'live',
    summary: 'Macro factors with level bands, sector rotation, charts and cycle probability.',
    load: () => import('./macro/analysis') },

  // ── Control panel (the owner) ──
  { id: 'control.machines', group: 'Control panel', title: 'Live controller', access: 'admin', status: 'live',
    summary: "Each machine's launcher: train, pause, resume, restart, update.",
    load: () => import('./control/machines') },
  { id: 'control.reviews', group: 'Control panel', title: 'Branch reviews', access: 'admin', status: 'live',
    summary: 'Pull requests with before/after recordings of the screens they touch: approve or ask for changes.',
    load: () => import('./control/reviews') },
  { id: 'control.hub-reviews', group: 'Control panel', title: 'Hub reviews', access: 'admin', status: 'live',
    summary: 'Versions waiting for approval in the Data, Broker and Seed hubs.',
    load: () => import('./control/hub-reviews') },
  { id: 'control.users', group: 'Control panel', title: 'Users', access: 'admin', status: 'live',
    summary: 'Accounts waiting for approval, and invitations.',
    load: () => import('./control/users') },
  { id: 'control.schedule', group: 'Control panel', title: 'Schedule', access: 'admin', status: 'live',
    summary: 'Release 1: key events with their tasks folded.',
    load: () => import('./control/schedule') },
  { id: 'control.data', group: 'Control panel', title: 'Data', access: 'admin', status: 'live',
    summary: "The Data Hub's stock watchlist, tracked funds, source connections and errors.",
    load: () => import('./control/data') },
  { id: 'control.services', group: 'Control panel', title: 'Hub services', access: 'admin', status: 'live',
    summary: "The Data Hub's background services: state, start, stop, restart.",
    load: () => import('./control/services') },
  { id: 'control.credentials', group: 'Control panel', title: 'Credentials', access: 'admin', status: 'live',
    summary: 'Broker and data keys held for machines (names only).',
    load: () => import('./control/credentials') },

  // ── Account (everyone signed in) ──
  { id: 'account.profile', group: 'Account', title: 'Your account', access: 'user', status: 'live',
    summary: 'Your name, phone and passkeys; one account for every Arcium site.',
    load: () => import('./account/profile') },

  // ── Planned: designed in the briefs or archived on Nov 16; each opens its plan until it is built ──
  { id: 'planned.model-tracker', group: 'Planned', title: 'Model tracker view', access: 'admin', status: 'planned',
    summary: 'A view of its own for trackers (which symbols are recorded for models, by fund).', plan: 'model-tracker' },
  { id: 'planned.pinned-lists', group: 'Planned', title: 'Pinned list layers', access: 'admin', status: 'planned',
    summary: 'Pin watchlists, bundles or trackers as top layers of any drill table.', plan: 'pinned-lists' },
  { id: 'planned.portfolio-rotator', group: 'Planned', title: 'Portfolio rotator', access: 'admin', status: 'planned',
    summary: "Filters score a universe; the top assets rotate into an engine's portfolio.", plan: 'portfolio-rotator' },
  { id: 'planned.fusion-forex', group: 'Planned', title: 'Fusion: Forex', access: 'admin', status: 'planned',
    summary: 'Forex factors, pair differentials, the policy trilemma, sovereign debt.', plan: 'fusion-forex' },
  { id: 'planned.fusion-stocks', group: 'Planned', title: 'Fusion: Stocks', access: 'admin', status: 'planned',
    summary: 'CANSLIM, analysis steps, SEC forms, credit, valuation, rate sensitivity.', plan: 'fusion-stocks' },
  { id: 'planned.fusion-playbook', group: 'Planned', title: 'Fusion: Playbook', access: 'admin', status: 'planned',
    summary: 'The rules, long/short basics and playbook entries.', plan: 'fusion-playbook' },
  { id: 'planned.fusion-alpha-carry', group: 'Planned', title: 'Fusion: Alpha carry', access: 'admin', status: 'planned',
    summary: 'The alpha carry method.', plan: 'fusion-alpha-carry' },
  { id: 'planned.options-scanner', group: 'Planned', title: 'Options scanner', access: 'admin', status: 'planned',
    summary: 'Options scanning on the recorded chains.', plan: 'fusion-options-scanner' },
  { id: 'planned.highlight-scanner', group: 'Planned', title: 'Highlight scanner', access: 'admin', status: 'planned',
    summary: 'Mean-break and breakout picks.', plan: 'fusion-highlight-scanner' },
  { id: 'planned.fusion-home', group: 'Planned', title: 'Fusion hub home', access: 'admin', status: 'planned',
    summary: 'The Fusion hub home layout plan.', plan: 'fusion-hub-home' },
];

export const moduleById = (id: string) => MODULES.find(m => m.id === id);

export function mayOpen(m: ModuleDef, me: { role: string | null; portal?: boolean }): boolean {
  if (me.role === 'admin') return true;
  if (m.access === 'admin') return false;
  return m.access === 'user' || !!me.portal;
}

/** What the browser needs to know about the modules (no loaders). */
export type ModuleInfo = Omit<ModuleDef, 'load'>;
export const moduleInfo = (m: ModuleDef): ModuleInfo => {
  const { load: _load, ...rest } = m;
  return rest;
};
