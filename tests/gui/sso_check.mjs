// One-off check that the hubs share the Arcium session (Schedule 0, p1.4.1-3):
//   signed in on the app  -> the hub page shows the account
//   signed out            -> the hub's Sign in goes to the app with ?next=<hub page>, which the
//                            app accepts as a place to return to
//   node tests/gui/sso_check.mjs [base] [hub]
import { createRequire } from 'node:module';
import { openSession } from './session.mjs';

const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3005';
const hub = process.argv[3] || 'http://localhost:8091';
const session = await openSession(base);
const browser = await chromium.launch();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
try {
  const signedIn = await browser.newContext();
  await signedIn.addCookies([{ name: 'arcium_session', value: session.token, url: base }]);
  const p = await signedIn.newPage();
  await p.goto(hub + '/', { waitUntil: 'load' });
  await p.waitForSelector('#account .who, #account a', { timeout: 15000 });
  const who = (await p.textContent('#account')).trim();
  check(!!(await p.$('#account .who')) && !/sign in/i.test(who), `signed in on the app, the hub shows the account ("${who.slice(0, 40)}")`);

  // Signed out, a hub page that needs an account sends the browser to the app's sign-in with
  // next=<that hub page>.
  const signedOut = await browser.newContext();
  const q = await signedOut.newPage();
  await q.goto(hub + '/#/new', { waitUntil: 'load' });
  await q.waitForURL(u => u.origin === new URL(base).origin, { timeout: 15000 });
  const next = new URL(q.url()).searchParams.get('next');
  check(next === hub + '/#/new', `signed out, the hub sends you to the app's sign-in with next=<hub page> (${next})`);
  check(await q.waitForSelector('input[type="password"]', { timeout: 15000 }).then(() => true, () => false), 'the app shows its sign-in form');

  // Signed in (as right after signing in), that sign-in link goes straight back to the hub page.
  const r = await signedIn.newPage();
  await r.goto(q.url(), { waitUntil: 'load' });
  await r.waitForURL(u => u.toString().startsWith(hub), { timeout: 15000 }).catch(() => {});
  check(r.url() === hub + '/#/new', `signed in, the sign-in link returns to the hub page (${r.url()})`);

  // A next= that isn't a hub is not followed.
  const s2 = await signedIn.newPage();
  await s2.goto(base + '/?next=' + encodeURIComponent('https://example.com/'), { waitUntil: 'load' });
  await s2.waitForURL(u => !u.toString().includes('?next='), { timeout: 15000 }).catch(() => {});
  check(!s2.url().startsWith('https://example.com'), `a next= outside the hubs is ignored (${s2.url()})`);
} finally {
  await browser.close();
  await session.close();
}
process.exit(failed ? 1 : 0);
