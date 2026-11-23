// Can every piece of text on the page be scrolled into view? Used by the GUI suite (contentReachable)
// and runnable alone as an audit across pages and screen sizes:
//
//   node tests/gui/reach.mjs [base]        -> prints each page x viewport with anything out of reach
//
// For each visible element with its own text, walk up its ancestors: a box that scrolls on an axis can
// bring it into view there (the element then counts as being at that box's edge); a box that clips
// without scrolling (overflow hidden/clip) hides it for good if it lies outside that box. Finally the
// window: past the bottom or right edge with nothing left to scroll is out of reach.
export function findUnreachable() {
  const out = [];
  const docScrollsY = (() => {
    const se = document.scrollingElement, cs = getComputedStyle(document.documentElement), bs = getComputedStyle(document.body);
    return se.scrollHeight > innerHeight + 1 && cs.overflowY !== 'hidden' && bs.overflowY !== 'hidden';
  })();
  const docScrollsX = document.scrollingElement.scrollWidth > innerWidth + 1
    && getComputedStyle(document.documentElement).overflowX !== 'hidden' && getComputedStyle(document.body).overflowX !== 'hidden';
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
  for (const el of document.querySelectorAll('body *')) {
    if (!ownText(el) || el.closest('[aria-hidden="true"], details:not([open]) > :not(summary), script, style, noscript')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    let r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    r = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    let why = null;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.position === 'fixed' && a !== el) { /* fixed boxes sit in the window; checked against it below */ }
      const ar = a.getBoundingClientRect();
      const sy = (as.overflowY === 'auto' || as.overflowY === 'scroll') && a.scrollHeight > a.clientHeight + 1;
      const sx = (as.overflowX === 'auto' || as.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1;
      const clipY = as.overflowY === 'hidden' || as.overflowY === 'clip';
      const clipX = as.overflowX === 'hidden' || as.overflowX === 'clip';
      if (sy) { const h = Math.min(r.bottom - r.top, ar.height); r.top = Math.max(ar.top, Math.min(r.top, ar.bottom - h)); r.bottom = r.top + h; }
      else if (clipY && (r.top >= ar.bottom - 1 || r.bottom <= ar.top + 1)) { why = 'clipped (top/bottom)'; break; }
      if (sx) { const w = Math.min(r.right - r.left, ar.width); r.left = Math.max(ar.left, Math.min(r.left, ar.right - w)); r.right = r.left + w; }
      else if (clipX && (r.left >= ar.right - 1 || r.right <= ar.left + 1)) {
        if (as.textOverflow === 'ellipsis' || cs.textOverflow === 'ellipsis') continue;   // deliberate "…" truncation
        why = 'clipped (sideways)'; break;
      }
      if (as.position === 'fixed') break;   // a fixed box doesn't move with the page
    }
    if (!why && !docScrollsY && r.top >= innerHeight - 1) why = `below the window by ${Math.round(r.top - innerHeight)}px`;
    if (!why && !docScrollsX && r.left >= innerWidth - 1) why = `right of the window by ${Math.round(r.left - innerWidth)}px`;
    if (why) {
      const name = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase();
      out.push(`${name} "${el.textContent.trim().slice(0, 40)}": ${why}`);
    }
  }
  return out;
}

// ── standalone audit ──────────────────────────────────────────────────────────
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  'short laptop': { width: 1366, height: 600 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  'phone landscape': { width: 844, height: 390, isMobile: true, hasTouch: true },
};

if (process.argv[1] && process.argv[1].endsWith('reach.mjs')) {
  const { createRequire } = await import('node:module');
  const { openSession } = await import('./session.mjs');
  const require = createRequire(process.cwd() + '/package.json');
  const { chromium } = require('playwright');
  const base = process.argv.find(a => /^https?:/.test(a)) || 'http://localhost:3005';
  const session = await openSession(base);
  const browser = await chromium.launch();
  const CONTROL = [['Overview'], ['People', 'Users'], ['Data & services', 'Hub services'], ['Data & services', 'Data'], ['Sites', 'Repo reviews'],
                   ['People', 'Subscriptions'], ['Data & services', 'Credentials'], ['Sites', 'Sites']].map(x => x.join(' > '));
  const pages = [
    ['/workspace'], ['/control/schedule'], ['/account'], ['/portal'],
    ...CONTROL.map(s => ['/control', s]),
  ];
  let problems = 0;
  for (const [vname, vp] of Object.entries(VIEWPORTS)) {
    const { isMobile, hasTouch, ...viewport } = vp;
    const ctx = await browser.newContext({ viewport, isMobile, hasTouch });
    await ctx.addCookies([{ name: 'arcium_session', value: session.token, url: base }]);
    const page = await ctx.newPage();
    for (const [path, section] of pages) {
      await page.goto(base + path, { waitUntil: 'load' });
      await page.waitForTimeout(path === '/portal' ? 3000 : 1200);
      if (section) {   // "Section > Tab"
        const [sec, tab] = section.split(' > ');
        const btn = page.locator(`.c-nav-item:has-text("${sec}")`).first();
        if (await btn.count()) { await btn.click(); await page.waitForTimeout(600); }
        const tb = tab ? page.locator(`.c-tab:has-text("${tab}")`).first() : null;
        if (tb && await tb.count()) { await tb.click(); await page.waitForTimeout(1200); }
      }
      const bad = await page.evaluate(findUnreachable);
      const label = `${vname.padEnd(15)} ${path}${section ? ' > ' + section : ''}`;
      if (bad.length) { problems += bad.length; console.log(`${label}: ${bad.length} out of reach`); bad.slice(0, 5).forEach(b => console.log('    ' + b)); }
      else console.log(`${label}: ok`);
    }
    // The portal's data views, opened the way a person would.
    await page.goto(base + '/portal', { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    const silo = '.p-sidebar .p-tile:not(:has-text("arcium_machine")):not(:has-text("Models Catalog")):not(:has-text("Silo Manager"))';
    const VIEWS = [
      ['machine', ['.p-sidebar .p-tile']],
      ['Models Catalog', ['.p-sidebar .p-tile:has-text("Models Catalog")']],
      ['Silo Manager', ['.p-sidebar .p-tile:has-text("Silo Manager")']],
      ['silo main', [silo]],
      ['silo optimizer', ['.p-silo-tab-btn:has-text("Optimizer")']],
      ['silo seed', ['.p-silo-tab-btn:has-text("Seed")']],
      ['silo settings', ['.p-silo-tab-btn:has-text("Settings")']],
      ['funds', ['.p-view-selector-btn', '.p-view-selector-item:has-text("Funds")']],
    ];
    for (const [name, clicks] of VIEWS) {
      const label = `${vname.padEnd(15)} /portal > ${name}`;
      let missing = null;
      for (const sel of clicks) {
        const el = page.locator(sel).first();
        if (!(await el.count()) || !(await el.isVisible())) { missing = sel; break; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click().catch(e => { missing = `${sel} (${e.message.split('\n')[0]})`; });
        await page.waitForTimeout(1500);
      }
      if (missing) { problems++; console.log(`${label}: can't open it here (${missing} not visible)`); continue; }
      const bad = await page.evaluate(findUnreachable);
      if (bad.length) { problems += bad.length; console.log(`${label}: ${bad.length} out of reach`); bad.slice(0, 5).forEach(b => console.log('    ' + b)); }
      else console.log(`${label}: ok`);
    }
    await ctx.close();
  }
  // Signed-out pages
  for (const [vname, vp] of Object.entries(VIEWPORTS)) {
    const { isMobile, hasTouch, ...viewport } = vp;
    const ctx = await browser.newContext({ viewport, isMobile, hasTouch });
    const page = await ctx.newPage();
    for (const path of ['/', '/signup', '/forgot-password']) {
      await page.goto(base + path, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      const bad = await page.evaluate(findUnreachable);
      const label = `${vname.padEnd(15)} ${path} (signed out)`;
      if (bad.length) { problems += bad.length; console.log(`${label}: ${bad.length} out of reach`); bad.slice(0, 5).forEach(b => console.log('    ' + b)); }
      else console.log(`${label}: ok`);
    }
    await ctx.close();
  }
  await browser.close();
  await session.close();
  console.log(problems ? `\n${problems} pieces of text out of reach` : '\nEverything reachable on every page and size');
}
