// Demo agent, step 2: record screens as the person reviewing a change would see them.
//
//   node tests/demo/tour.mjs --base http://localhost:3000 --out tests/demo/out --label after --screens factory.silos,public:signin
//   node tests/demo/tour.mjs ... --screens-file screens.txt         one id per line (from changed.mjs)
//   node tests/demo/tour.mjs ... --all                              every dashboard, the workspace and the public pages
//   node tests/demo/tour.mjs ... --all --walkthrough                one continuous video through the whole suite
//
// For each screen: a video that scrolls the page (<id>.webm), a full-page screenshot at desktop width (<id>.png) and
// at phone width (<id>.phone.png), the console errors, and how long it took to finish loading. <out>/<label>/report.json
// lists them. Run it twice, --label before (the main branch) and --label after (the pull request), for a side-by-side.
//
// Sign-in: tests/gui/session.mjs (local: a throwaway session in the .env.local demo database; remote: GUI_LOGIN /
// GUI_PASSWORD). The tour only looks: every request that would change something (any non-GET API call, including
// saving the workspace arrangement) is answered locally and never reaches the site.
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openSession } from '../gui/session.mjs';
import { dashboards } from './changed.mjs';

// ── arguments ──
const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const base = (opt('base', 'http://localhost:3005')).replace(/\/$/, '');
const label = opt('label', 'after');
const out = join(opt('out', 'tests/demo/out'), label);
const walkthrough = args.includes('--walkthrough');
const PUBLIC = Object.fromEntries([                    // the public pages: screen id, address
  ['public:signin', '/'], ['public:forgot-password', '/forgot-password'], ['public:reset-password', '/reset-password'],
]);
let screens;
if (args.includes('--all')) screens = ['public:signin', 'workspace', ...dashboards().map(d => d.id)];
else if (opt('screens-file')) screens = readFileSync(opt('screens-file'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
else screens = (opt('screens', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const fileOf = id => id.replace(/[^\w.-]/g, '-');      // public:signin -> public-signin (safe on every system)
const urlOf = id => PUBLIC[id] ?? (id === 'workspace' ? '/w' : `/w/${encodeURIComponent(id)}`);
const DESK = { width: 1400, height: 900 }, PHONE = { width: 390, height: 844 };

// ── helpers ──
async function lookOnly(ctx) {
  await ctx.route('**/api/**', route => route.request().method() === 'GET'
    ? route.continue()
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"demo":"answered by the tour"}' }));
}

async function settle(page) {
  const t0 = Date.now();
  await page.waitForLoadState('load').catch(() => {});
  // finished loading = no visible "Loading…" text (the kit's and the panels' placeholder), up to 25 s
  await page.waitForFunction(() => ![...document.querySelectorAll('body *')].some(el =>
    el.childElementCount === 0 && /^\s*Loading…?\s*$/.test(el.textContent || '') && el.getBoundingClientRect().height > 0),
  null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(400);
  return Date.now() - t0;
}

async function scrollThrough(page) {
  // a slow scroll to the bottom and back, so the video shows the whole page
  const box = await page.evaluate(() => {
    const el = document.querySelector('.ws-content') || document.scrollingElement;
    return { h: el.scrollHeight, v: el.clientHeight };
  });
  for (let y = 0; y < box.h - box.v; y += Math.max(200, box.v * 0.6)) {
    await page.evaluate(top => (document.querySelector('.ws-content') || document.scrollingElement).scrollTo({ top, behavior: 'smooth' }), y);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.querySelector('.ws-content') || document.scrollingElement).scrollTo({ top: 0 }));
}

async function newContext(browser, viewport, token, video) {
  const ctx = await browser.newContext({ viewport, ...(video ? { recordVideo: { dir: video, size: { width: 1280, height: 820 } } } : {}) });
  if (token) await ctx.addCookies([{ name: 'arcium_session', value: token, url: base }]);
  await lookOnly(ctx);
  return ctx;
}

// ── the tour ──
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tmp = join(out, '.video');
const browser = await chromium.launch();
const session = await openSession(base);
const report = { label, base, at: new Date().toISOString(), walkthrough, screens: [] };

try {
  if (walkthrough) {
    // one continuous video: sign-in page, then the workspace and every dashboard in menu order
    const ctx = await newContext(browser, DESK, session.token, tmp);
    const page = await ctx.newPage();
    for (const id of screens) {
      const errors = [];
      const onErr = m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); };
      page.on('console', onErr);
      if (PUBLIC[id]) {                                      // the public pages, as a signed-out visitor sees them
        const pub = await newContext(browser, DESK, null, null);
        const p = await pub.newPage();
        await p.goto(base + urlOf(id)); await settle(p);
        await p.screenshot({ path: join(out, `${fileOf(id)}.png`), fullPage: true });
        await pub.close();
        report.screens.push({ id, file: fileOf(id), url: urlOf(id), errors, loadMs: null });
        page.off('console', onErr);
        continue;
      }
      await page.goto(base + urlOf(id));
      const loadMs = await settle(page);
      await page.screenshot({ path: join(out, `${fileOf(id)}.png`), fullPage: true });
      await scrollThrough(page);
      page.off('console', onErr);
      report.screens.push({ id, file: fileOf(id), url: urlOf(id), title: await page.title(), errors, loadMs });
    }
    const v = page.video();
    await ctx.close();
    if (v) renameSync(await v.path(), join(out, 'walkthrough.webm'));
  } else {
    for (const id of screens) {
      const token = PUBLIC[id] ? null : session.token;
      const errors = [];
      // desktop, with video
      const ctx = await newContext(browser, DESK, token, tmp);
      const page = await ctx.newPage();
      page.on('console', m => {
        if (m.type() !== 'error') return;
        if (!token && /status of 401/.test(m.text())) return;          // signed out: the "am I signed in?" check says no
        errors.push(m.text().slice(0, 300));
      });
      page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
      const resp = await page.goto(base + urlOf(id));
      const loadMs = await settle(page);
      await page.screenshot({ path: join(out, `${fileOf(id)}.png`), fullPage: true });
      await scrollThrough(page);
      const title = await page.title();
      const v = page.video();
      await ctx.close();
      if (v) renameSync(await v.path(), join(out, `${fileOf(id)}.webm`));
      // phone
      const phone = await newContext(browser, PHONE, token, null);
      const pp = await phone.newPage();
      await pp.goto(base + urlOf(id)); await settle(pp);
      const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      await pp.screenshot({ path: join(out, `${fileOf(id)}.phone.png`), fullPage: true });
      await phone.close();
      report.screens.push({ id, file: fileOf(id), url: urlOf(id), status: resp?.status() ?? null, title, errors, loadMs, phoneOverflow: overflow });
      console.log(`${label} ${id}: ${loadMs} ms, ${errors.length} console error(s)${overflow ? ', phone overflows sideways' : ''}`);
    }
  }
} finally {
  await session.close();
  await browser.close();
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${label}: ${report.screens.length} screen(s) -> ${out}`);
