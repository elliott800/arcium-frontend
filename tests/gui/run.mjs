// GUI regression suite: every feature in features.mjs is opened, clicked, checked for the
// display it should show and for the API call it should make (side-effecting calls are
// answered by a mock so nothing really runs). Reports the feature count and compares with
// the saved baseline: a feature that passed before and fails now is a REGRESSION.
//
//   node tests/gui/run.mjs [base] [--update-baseline] [--only=<id prefix>] [--dark]
//   base defaults to http://localhost:3005 (local: uses the local DB for a session; remote:
//   set GUI_LOGIN and GUI_PASSWORD). Output: tests/gui/out/report.json + failure screenshots.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { openSession } from './session.mjs';
import { findUnreachable } from './reach.mjs';
import { SHELL, MODULE_SMOKE, FACTORY, DATA, PUBLIC, MOBILE } from './features.mjs';

const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const base = args.find(a => /^https?:/.test(a)) || 'http://localhost:3005';
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
// GUI_BASELINE picks another baseline file (CI keeps its own: a fresh demo database has no Data Hub tables).
const OUT = 'tests/gui/out', BASELINE = process.env.GUI_BASELINE || 'tests/gui/baseline.json';
mkdirSync(OUT, { recursive: true });

function helpers(page, log) {
  const waitApi = (method, re, timeout = 20000) => page.waitForResponse(r => {
    const u = new URL(r.url());
    return r.request().method() === method && re.test(u.pathname);
  }, { timeout }).then(r => { if (r.status() >= 300) throw new Error(`${method} ${new URL(r.url()).pathname} -> ${r.status()}`); log.push(`${method} ${new URL(r.url()).pathname} ${r.status()}`); return r; });
  const sel = s => (/^[.#\[]|>>|:has|^\w+[.#\[]|^(button|input|main|svg|table)\b/.test(s) ? s : `text=${s}`);
  const t = {
    page,
    async goto(path, apis = [], absolute = false) {
      const waits = apis.map(([m, re]) => waitApi(m, re));
      waits.forEach(w => w.catch(() => {}));   // a failed step must fail its feature, not crash the run
      await page.goto(absolute ? path : base + path, { waitUntil: 'load' });
      await Promise.all(waits);
    },
    async click(s, apis = []) {
      const waits = apis.map(([m, re]) => waitApi(m, re));
      waits.forEach(w => w.catch(() => {}));
      await page.click(sel(s), { timeout: 15000 });
      await Promise.all(waits);
      await page.waitForTimeout(300);
    },
    async see(s, what) {
      try { await page.waitForSelector(sel(s), { state: 'visible', timeout: 15000 }); }
      catch { throw new Error(`not shown: ${what} (${s})`); }
    },
    async text(s, re) {
      await page.waitForSelector(sel(s), { timeout: 15000 });
      await page.waitForFunction(([q, src, fl]) => new RegExp(src, fl).test(document.querySelector(q)?.innerText || ''),
        [s, re.source, re.flags], { timeout: 15000 }).catch(async () => {
        throw new Error(`${s} text doesn't match ${re}: "${((await page.textContent(s)) || '').slice(0, 120)}"`);
      });
    },
    async count(s, min) {
      await page.waitForFunction(([q, n]) => document.querySelectorAll(q).length >= n, [s, min], { timeout: 15000 })
        .catch(async () => { throw new Error(`${s}: ${await page.$$eval(s, e => e.length)} found, want >= ${min}`); });
    },
    async scrollbarsReachable() {
      // Every box that scrolls sideways must have its scrollbar reachable: after scrolling all its
      // vertically scrolling ancestors to the bottom, the box's bottom edge must be inside the window.
      const bad = await page.evaluate(() => {
        const out = [];
        const scrollsY = el => { const o = getComputedStyle(el).overflowY; return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1; };
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if (!(cs.overflowX === 'auto' || cs.overflowX === 'scroll') || el.scrollWidth <= el.clientWidth + 1) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          let bottom = Math.min(r.bottom, r.top + el.clientHeight + 20);
          for (let a = el.parentElement; a; a = a.parentElement) {
            if (scrollsY(a)) bottom -= a.scrollHeight - a.clientHeight - a.scrollTop;
          }
          if (bottom > innerHeight + 2) out.push(`${el.className.toString().split(' ')[0] || el.tagName} (${Math.round(bottom - innerHeight)}px below)`);
        }
        return out;
      });
      if (bad.length) throw new Error(`sideways scrollbars out of reach: ${bad.slice(0, 4).join(', ')}`);
    },
    async contentReachable() {
      // Every piece of text can be scrolled into view (see reach.mjs): nothing clipped for good.
      const bad = await page.evaluate(findUnreachable);
      if (bad.length) throw new Error(`out of reach: ${bad.slice(0, 3).join('; ')}`);
    },
    async noOverflow() {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (over > 1) throw new Error(`page scrolls sideways by ${over}px`);
    },
    async mock(method, re) {
      await page.route('**/api/**', route => {
        const r = route.request(), p = new URL(r.url()).pathname;
        if (r.method() === method && re.test(p)) { log.push(`MOCKED ${method} ${p}`); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"mocked":true}' }); }
        return route.fallback();
      });
    },
  };
  return t;
}

async function runGroup(browser, name, features, ctxOpts, token, results) {
  const ctx = await browser.newContext(ctxOpts);
  if (token) await ctx.addCookies([{ name: 'arcium_session', value: token, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Never let a test reach a side-effecting endpoint for real.
  await page.route('**/api/**', route => {
    const r = route.request(), p = new URL(r.url()).pathname;
    if (r.method() !== 'GET' && !/^\/api\/(login|logout|sso\/)/.test(p))
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"mocked":true}' });
    return route.fallback();
  });
  for (const f of features) {
    if (only && !f.id.startsWith(only)) continue;
    const log = [], t0 = Date.now();
    const errBefore = errors.length;
    try {
      await f.run(helpers(page, log));
      if (errors.length > errBefore) throw new Error(`page error: ${errors[errors.length - 1].slice(0, 160)}`);
      results.push({ group: name, id: f.id, area: f.area, name: f.name, ok: true, ms: Date.now() - t0, calls: log });
    } catch (e) {
      const shot = `${OUT}/${f.id}.png`;
      await page.screenshot({ path: shot }).catch(() => {});
      results.push({ group: name, id: f.id, area: f.area, name: f.name, ok: false, ms: Date.now() - t0, error: e.message.split('\n')[0], shot, calls: log });
    }
  }
  await ctx.close();
}

const dark = args.includes('--dark');
const session = await openSession(base);
const browser = await chromium.launch();
const results = [];
try {
  const desk = { viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' };
  await runGroup(browser, 'shell', SHELL, desk, session.token, results);
  await runGroup(browser, 'dashboards', MODULE_SMOKE, desk, session.token, results);
  await runGroup(browser, 'factory', FACTORY, desk, session.token, results);
  await runGroup(browser, 'data', DATA, { viewport: { width: 1500, height: 1000 } }, session.token, results);
  await runGroup(browser, 'public', PUBLIC, { viewport: { width: 1280, height: 860 } }, null, results);
  await runGroup(browser, 'mobile', MOBILE, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, session.token, results);
} finally {
  await browser.close();
  await session.close();
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { passing: [] };
const passing = results.filter(r => r.ok).map(r => r.id);
const regressions = results.filter(r => !r.ok && baseline.passing.includes(r.id));
const areas = {};
for (const r of results) { areas[r.area] ??= { pass: 0, fail: 0 }; areas[r.area][r.ok ? 'pass' : 'fail']++; }
writeFileSync(`${OUT}/report.json`, JSON.stringify({ base, at: new Date().toISOString(), features: results.length, passing: passing.length, regressions: regressions.map(r => r.id), results }, null, 2));
console.log(`\nGUI suite against ${base}: ${results.length} features, ${passing.length} pass, ${results.length - passing.length} fail`);
for (const [a, c] of Object.entries(areas)) console.log(`  ${a.padEnd(14)} ${c.pass} pass${c.fail ? `, ${c.fail} FAIL` : ''}`);
for (const r of results.filter(r => !r.ok)) console.log(`  ${regressions.includes(r) ? 'REGRESSION' : 'FAIL      '} ${r.id}: ${r.error}`);
if (args.includes('--update-baseline')) {
  writeFileSync(BASELINE, JSON.stringify({ updated: new Date().toISOString(), features: results.length, passing }, null, 2));
  console.log(`baseline updated: ${passing.length} passing features`);
}
process.exit(regressions.length ? 2 : 0);
