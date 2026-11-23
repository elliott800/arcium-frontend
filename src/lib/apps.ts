// Every Arcium dashboard one account opens, for the app switcher.
// Links to Fusion Hub pages carry ?sso=1: the page signs in through this site by itself, so
// someone signed in here arrives signed in there. The hubs share this site's session; Discord Hub
// and Arcium Sites sign in through it with a button. A site not on single sign-on would be `ownLogin`. Pages of this app link by path, so they work on any of its hosts.

import { FUSION_MODULES, FUSION_SHARED } from '@/lib/fusion/modules';

export interface AppLink { id: string; name: string; desc: string; href: string; adminOnly?: boolean; ownerOnly?: boolean; ownLogin?: boolean }
export interface AppGroup { site: string; apps: AppLink[] }

// The Arcium focus (Nov 7): the Fusion Hub, the Factory and the Data Hub, with the Broker Hub and Seed Hub supporting
// the Factory. Every other service is off this site's menus, tiles and starters. Add an id here to hide one more.
export const HIDDEN = new Set<string>([]);

const ALL_APP_GROUPS: AppGroup[] = [
  { site: 'Arcium Signals', apps: [
    { id: 'workspace', name: 'Workspace', desc: 'Tiles, menus and windows for every dashboard', href: '/workspace' },
    { id: 'portal', name: 'Factory', desc: 'Machines, silos, engines, optimizer, models and portfolios', href: '/portal', ownerOnly: true },
    { id: 'account', name: 'Account', desc: 'Your account and plans', href: '/account' },
  ] },
  // The Fusion Hub (admin): its home, one Workspace panel per module from the module registry, and the shared
  // tools it links to (the Portfolio Maker) as panels.
  { site: 'Fusion Analysis', apps: [
    ...FUSION_MODULES.map(m => ({ id: `fusion-${m.id}`, name: `Fusion ${m.title}`, desc: m.desc, href: m.embed, adminOnly: true })),
    ...FUSION_SHARED.filter(t => t.status === 'live').map(t => ({ id: `fusion-${t.id}`, name: t.title, desc: t.desc, href: t.embed, adminOnly: true })),
  ] },
  { site: 'Hubs', apps: [
    { id: 'datahub', name: 'Data Hub', desc: 'Recording lists and every recorded stream', href: '/datahub', adminOnly: true },
    { id: 'brokerhub', name: 'Broker Hub', desc: 'Broker APIs', href: 'https://brokerhub.arciumsignals.com' },
    { id: 'seedhub', name: 'Seed Hub', desc: 'Seed modules', href: 'https://seedhub.arciumsignals.com' },
  ] },
  // The admin tools, in one place at the end (only admins see this group).
  { site: 'Admin', apps: [
    { id: 'control', name: 'Control panel', desc: 'Users, hub services, data, sites', href: '/control', adminOnly: true },
    { id: 'schedule', name: 'Schedules', desc: 'Release 1: key events, with their tasks', href: '/control/schedule', adminOnly: true },
    { id: 'schedule-pdf', name: 'Schedule PDF', desc: 'Download the fillable, printable schedule', href: '/control/schedule/pdf', adminOnly: true },
    { id: 'datahub-status', name: 'Data Hub status', desc: 'Recorders, collectors and last ticks', href: 'https://datahub.arciumsignals.com/status', adminOnly: true },
  ] },
];

/** Every visible dashboard (hidden projects left out, empty groups dropped). */
export const APP_GROUPS: AppGroup[] = ALL_APP_GROUPS
  .map(g => ({ ...g, apps: g.apps.filter(a => !HIDDEN.has(a.id)) }))
  .filter(g => g.apps.length);

/** The groups a person may open: admins see the control panel, the owner sees the portal. */
export function appsFor(opts: { admin: boolean; owner: boolean }): AppGroup[] {
  return APP_GROUPS.map(g => ({ ...g, apps: g.apps.filter(a => (!a.adminOnly || opts.admin) && (!a.ownerOnly || opts.owner)) }))
    .filter(g => g.apps.length);
}
