// The Fusion Analysis portal's modules. Each module is a set of pages under /fusion/<id> built from
// content/fusion/<id>/*.md (contentDir), opens in the Workspace as a panel (embed), and lists the data and
// broker integrations it uses or will use, so a new integration plugs in here without changing the pages.
// Every module is admin-only (the /fusion layout checks the session on the server).
// Pruned 2026-11-16: forex, stocks, playbook and alpha carry are in arcium_feature_archive/ (the type keeps
// their ids so the shared page code that still handles them compiles when one is restored).

export type FusionModuleId = 'forex' | 'macro' | 'stocks' | 'playbook' | 'alpha-carry';

export interface FusionIntegration {
  id: string;
  label: string;
  status: 'live' | 'partial' | 'planned';   // partial: some of the module's controls read it already
}

export interface FusionModule {
  id: FusionModuleId;
  title: string;
  desc: string;
  order: number;
  contentDir: boolean;          // pages come from content/fusion/<id>/
  embed: string;                // the Workspace panel URL
  integrations: FusionIntegration[];
}

// US FRED readings already reach the macro factor table (src/lib/macro.ts); the other nations' series are still to come
const DATAHUB_MACRO: FusionIntegration = { id: 'datahub-macro', label: 'Data Hub macro series (FRED, IMF, OECD, BIS)', status: 'partial' };
const DATAHUB_PRICES: FusionIntegration = { id: 'datahub-prices', label: 'Data Hub prices (stocks, ETFs, FX)', status: 'live' };

export const FUSION_MODULES: FusionModule[] = [
  {
    id: 'macro', title: 'Macro', order: 1, contentDir: true, embed: '/fusion/macro/factors?embed=1',
    desc: 'Macro factors with bullish and bearish levels and their charts, sector rotation and cycle probability.',
    integrations: [DATAHUB_MACRO, DATAHUB_PRICES],
  },
];

export function fusionModule(id: string): FusionModule | undefined {
  return FUSION_MODULES.find(m => m.id === id);
}

/** A module whose pages come from content/fusion (not FULL SCAN), or undefined. */
export function contentModule(id: string): FusionModule | undefined {
  const m = fusionModule(id);
  return m?.contentDir ? m : undefined;
}

/** A Fusion link that stays inside a Workspace panel: with embed, ?embed=1 goes before any #section. */
export function fusionHref(href: string, embed: boolean): string {
  const [path, hash] = href.split('#');
  if (!embed || /[?&]embed=1\b/.test(path)) return href;
  return `${path}${path.includes('?') ? '&' : '?'}embed=1${hash ? `#${hash}` : ''}`;
}

// Tools other parts of the site build and the hub links to (the Portfolio Maker page, the options and highlight
// scanners were archived on 2026-11-16; see arcium_feature_archive/). A tool still being built is 'coming'.
export interface FusionSharedTool { id: string; title: string; desc: string; href: string; embed: string; status: 'live' | 'coming' }
export const FUSION_SHARED: FusionSharedTool[] = [];
