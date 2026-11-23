// The GUI feature list. Each group runs in its own browser context (size, signed in or not).
// Every dashboard in src/modules/registry.ts also gets a smoke test automatically (MODULE_SMOKE), so a new
// dashboard is covered the moment it is registered; add specific features for what it does.
import { readFileSync } from 'node:fs';

/** The dashboards in the registry: [{ id, group, title, status }] (read from the source, no build needed). */
export function registryModules() {
  const src = readFileSync('src/modules/registry.ts', 'utf8');
  const out = [];
  for (const m of src.matchAll(/\{\s*id:\s*'([^']+)',\s*group:\s*'([^']+)',\s*title:\s*'([^']+)'[^]*?status:\s*'(live|planned)'/g)) {
    out.push({ id: m[1], group: m[2], title: m[3], status: m[4] });
  }
  return out;
}

const MODULES = registryModules();
const menuValues = t => t.page.$eval('.ws-panel select', s => [...s.options].map(o => o.value));

export const SHELL = [
  { id: 'shell.home', area: 'Shell', name: 'The workspace opens with the bar, the panel and every dashboard listed',
    run: async t => { await t.goto('/w'); await t.see('.ws-bar', 'nav bar'); await t.see('.ws-panel', 'side panel'); await t.count('.ws-home-item', MODULES.length); } },
  { id: 'shell.menu', area: 'Shell', name: 'The dashboard menu lists every dashboard by group',
    run: async t => {
      const opts = await menuValues(t);
      for (const m of MODULES) if (!opts.includes(m.id)) throw new Error(`menu misses ${m.id}`);
      const groups = await t.page.$$eval('.ws-panel optgroup', g => g.map(x => x.label));
      for (const g of new Set(MODULES.map(m => m.group))) if (!groups.includes(g)) throw new Error(`no ${g} group`);
    } },
  { id: 'shell.open', area: 'Shell', name: 'Choosing a dashboard opens it in a tab',
    run: async t => {
      await t.page.selectOption('.ws-panel select', 'factory.machine');
      await t.page.waitForURL(/\/w\/factory\.machine$/, { timeout: 60000 });
      await t.see('.ws-tab.on:has-text("Machine")', 'Machine tab');
      await t.text('.m-head h1', /Machine/);
    } },
  { id: 'shell.tabs', area: 'Shell', name: 'Tabs switch and close',
    run: async t => {
      await t.page.selectOption('.ws-panel select', 'factory.catalog');
      await t.page.waitForURL(/factory\.catalog$/, { timeout: 60000 });
      await t.count('.ws-tab', 2);
      await t.click('.ws-tab a:has-text("Machine")');
      await t.page.waitForURL(/factory\.machine$/, { timeout: 60000 });
      await t.click('.ws-tab:has-text("Model catalog") button');
      if (await t.page.$('.ws-tab:has-text("Model catalog")')) throw new Error('tab did not close');
    } },
  { id: 'shell.dock', area: 'Shell', name: 'The bar docks to each edge and the choice is saved',
    run: async t => {
      for (const d of ['right', 'top', 'bottom', 'left']) {
        const saved = t.page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/user-preferences'), { timeout: 15000 });
        await t.page.selectOption('.ws-field-inline select', d);
        await saved;
        if (!(await t.page.$(`.ws.ws-dock-${d}`))) throw new Error(`not docked ${d}`);
      }
    } },
  { id: 'shell.panel', area: 'Shell', name: 'The panel hides and shows',
    run: async t => {
      await t.click('.ws-bar button[aria-controls="ws-panel"]');
      if (await t.page.$('.ws-panel')) throw new Error('panel still shown');
      await t.click('.ws-bar button[aria-controls="ws-panel"]');
      await t.see('.ws-panel', 'panel');
    } },
  { id: 'shell.checklist', area: 'Shell', name: 'The checklist sets what the menu lists',
    run: async t => {
      await t.click('.ws-panel button:has-text("Choose what the menu lists")');
      await t.click('.ws-check-row:has-text("Model tracker view") input');
      if ((await menuValues(t)).includes('planned.model-tracker')) throw new Error('unchecked dashboard still in the menu');
      await t.click('.ws-check button:has-text("All")');
      if (!(await menuValues(t)).includes('planned.model-tracker')) throw new Error('All did not restore it');
      await t.click('.ws-panel button:has-text("Done")');
    } },
  { id: 'shell.workspaces', area: 'Shell', name: 'A workspace can be saved under a name',
    run: async t => {
      t.page.once('dialog', d => d.accept('GUI test'));
      await t.click('.ws-panel button:has-text("Save as")');
      const names = await t.page.$$eval('.ws-panel select', s => [...s[1].options].map(o => o.value));
      if (!names.includes('GUI test')) throw new Error(`workspaces: ${names}`);
      t.page.once('dialog', d => d.accept());
      await t.click('.ws-panel button:has-text("Delete")');
    } },
  { id: 'shell.account', area: 'Shell', name: 'The account menu offers sign-out',
    run: async t => { await t.click('.ws-avatar'); await t.see('.ws-pop button:has-text("Sign out")', 'Sign out'); await t.click('.ws-avatar'); } },
];

// Every registered dashboard opens with its title and no page error.
export const MODULE_SMOKE = MODULES.map(m => ({
  id: `module.${m.id}`, area: `Dashboards: ${m.group}`, name: `${m.title} opens`,
  run: async t => {
    await t.goto(`/w/${m.id}`);
    await t.see('.m-page .m-head h1', 'title');
    if (await t.page.$('text=Application error')) throw new Error('application error');
    if (m.status === 'planned') await t.see('.m-prose h1', 'the plan');
  },
}));

export const FACTORY = [
  { id: 'factory.machine-status', area: 'Factory', name: 'Machine shows each controller with its silos, engines and controls',
    run: async t => {
      await t.goto('/w/factory.machine', [['GET', /^\/api\/machines\/status$/]]);
      await t.page.waitForSelector('[data-machine], .m-empty', { timeout: 30000 });
      // The controls show only where the owner may send commands (not on the demo site: its machine is simulated).
      if (await t.page.$('[data-machine] button:has-text("Report now")')) {
        await t.click('[data-machine] button:has-text("Report now")', [['POST', /^\/api\/admin\/machines\/control$/]]);   // mocked
      }
    } },
  { id: 'factory.engines-cards', area: 'Factory', name: 'Engine Hangar shows a simulated and a practice-live engine per silo',
    run: async t => {
      await t.goto('/w/factory.engines', [['GET', /^\/api\/machines\/status$/]]);
      await t.page.waitForSelector('[data-engine], .m-empty', { timeout: 30000 });
      if (await t.page.$('[data-engine]')) { await t.count('[data-engine$="/sim"]', 1); await t.count('[data-engine$="/live"]', 1); }
    } },
  { id: 'factory.silos-detail', area: 'Factory', name: "Silos lists the silos and shows the first one's settings",
    run: async t => {
      await t.goto('/w/factory.silos', [['GET', /^\/api\/silos$/]]);
      await t.page.waitForSelector('.m-table tbody tr, .m-empty', { timeout: 30000 });
      if (await t.page.$('.m-table tbody tr')) await t.see('.m-card h2:has-text("Trader")', 'trader settings');
    } },
  { id: 'factory.catalog-rows', area: 'Factory', name: 'The model catalog loads its rows and filters them',
    run: async t => {
      await t.goto('/w/factory.catalog', [['GET', /^\/api\/catalogs$/]]);
      await t.text('.m-page > p.m-muted', /rows/);
      await t.page.fill('input[aria-label="Filter"]', 'zzzz-nothing');
      await t.text('.m-page > p.m-muted', /^0 of/);
    } },
];

export const DATA = [
  { id: 'datahub.views', area: 'Data Hub', name: 'The Data Hub opens with its views',
    run: async t => { await t.goto('/w/datahub.hub', [['GET', /^\/api\/admin\/datahub/]]); await t.see('.dh-module', 'Data Hub'); } },
  { id: 'datahub.warehouse-drill', area: 'Data Hub', name: 'The Warehouse drill tree opens to an item\'s stored rates, which open no further',
    run: async t => {
      await t.goto('/w/datahub.hub', [['GET', /^\/api\/admin\/datahub/]]);
      await t.click('.datahub-navigation button:has-text("Warehouse")');
      await t.page.waitForSelector('.arc-drill-tr, .arc-drill-empty', { timeout: 60000 });
      // open the first closed row at each depth, down to the item's rate rows
      for (let d = 0; d < 8; d++) {
        const row = await t.page.$(`.arc-drill-tr[data-depth="${d}"] .arc-drill-toggle-row[aria-expanded="false"]`);
        if (!row) break;
        await row.click();
        await t.page.waitForTimeout(400);
      }
      const reopening = await t.page.$$eval('.arc-drill-tr', trs => trs.filter(tr =>
        / · \d{4}-\d\d-\d\d:/.test(tr.querySelector('td')?.textContent || '') && tr.querySelector('.arc-drill-toggle-row')).length);
      if (reopening) throw new Error(`${reopening} stored-rate rows open again (they should end the tree)`);
    } },
  { id: 'datahub.portfolio-maker', area: 'Data Hub', name: 'The Portfolio Maker has a silo to apply lists to',
    run: async t => { await t.goto('/w/datahub.portfolios', [['GET', /^\/api\/silos$/]]); await t.see('select[aria-label="Silo"]', 'silo picker'); } },
  { id: 'macro.pages', area: 'Macro', name: 'Macro lists its pages and opens another',
    run: async t => {
      await t.goto('/w/macro.analysis');
      await t.count('.macro-nav li', 1);
      const second = await t.page.$('.macro-nav li:nth-child(2) a');
      if (second) { await second.click(); await t.page.waitForURL(/[?&]page=/, { timeout: 90000 }); await t.see('.fu-page', 'page'); }
    } },
];

export const PUBLIC = [
  { id: 'public.signin', area: 'Public', name: 'Sign-in page shows the form',
    run: async t => {
      await t.goto('/');
      // The demo site leads with "Start a test session"; its sign-in form is behind "Owner sign-in".
      await t.page.waitForSelector('input[type="password"], button:has-text("Owner sign-in")', { timeout: 15000 });
      if (await t.page.$('button:has-text("Owner sign-in")')) await t.page.click('button:has-text("Owner sign-in")');
      await t.see('input[type="password"]', 'password field');
    } },
  { id: 'public.gate', area: 'Public', name: 'The workspace sends a signed-out visitor to sign in',
    run: async t => { await t.goto('/w'); if (!/next=(%2F|\/)w/.test(t.page.url())) throw new Error(`landed on ${t.page.url()}`); } },
  { id: 'public.old-address', area: 'Public', name: 'The old /workspace address still leads there',
    run: async t => { await t.goto('/workspace'); if (!/next=/.test(t.page.url())) throw new Error(`landed on ${t.page.url()}`); } },
  { id: 'public.api-gate', area: 'Public', name: 'The API refuses a signed-out visitor',
    run: async t => { const r = await t.page.request.get(new URL('/api/me', t.page.url()).href); if (r.status() !== 401) throw new Error(`/api/me -> ${r.status()}`); } },
];

export const MOBILE = [
  { id: 'mobile.workspace', area: 'Mobile', name: 'On a phone the workspace fits the screen',
    run: async t => { await t.goto('/w'); await t.see('.ws-bar', 'bar'); await t.noOverflow(); } },
  { id: 'mobile.dashboard', area: 'Mobile', name: 'On a phone a dashboard fits the screen',
    run: async t => { await t.goto('/w/factory.silos'); await t.see('.m-head h1', 'title'); await t.noOverflow(); } },
];
