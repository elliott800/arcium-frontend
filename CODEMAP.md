# Code map

Where each part of the site lives, in the order a person clicks through it. Every source file starts with a comment
saying what it is (`npm run lint` checks), and long files mark their sections with `// ── name ──` (or `/* ── name ── */`
in CSS), so you can jump from this map to a file and from its header to the section you need.

## 1. The way in

| What you see | Address | Files |
|---|---|---|
| Landing page | www.arciumsignals.com | separate repo `www.arciumsignals.com/index.php` (one static page; links into the app) |
| Sign in (and the demo's test session) | app.arciumsignals.com `/` | `src/app/page.tsx`, `src/app/_public/{Shell,SignInForm,passkey}.tsx/.ts`, `theme.module.css` |
| Forgot / reset password | `/forgot-password`, `/reset-password` | `src/app/forgot-password/`, `src/app/reset-password/` |
| Sign-in hand-off for other Arcium sites | `/sso`, `/hub-signin` | `src/app/sso/`, `src/app/hub-signin/`, `src/lib/sso.ts` |
| The Arcium bar on every Arcium site | `/arcium-nav.js` | `public/arcium-nav.js`, `src/app/api/nav/` |

Signed-out requests to `/api/*` are stopped in `src/proxy.ts` (the list of public routes is at its top).

## 2. The workspace (`/w`)

| Part | Files |
|---|---|
| Shell: bar, side panel (dashboard menu, checklist, workspaces, bar position), tabs | `src/shell/Shell.tsx`, `src/shell/prefs.ts`, `src/shell/shell.css` |
| Workspace home (every dashboard by group) | `src/app/w/page.tsx` |
| One dashboard, `/w/<id>` | `src/app/w/[module]/page.tsx` → the registry entry's `load()` |
| **The list of dashboards** (menu, access, tests) | `src/modules/registry.ts` |
| What dashboards are built from | `src/ui/kit.tsx` (`Page`, `Table`, `useJson`, `Notice`, …) and the `m-*` classes in `shell.css` |

## 3. The dashboards

| Group | Dashboard (`/w/<id>`) | File | Data from |
|---|---|---|---|
| Factory | Machine (`factory.machine`) | `src/modules/factory/machine.tsx` | `/api/machines/status` |
| | Silos (`factory.silos`) | `src/modules/factory/silos.tsx` | `/api/silos`, `/api/catalogs` |
| | Engine Hangar (`factory.engines`) | `src/modules/factory/engines.tsx` | `/api/machines/status`, `/api/silos/<silo>/data` |
| | Model catalog (`factory.catalog`) | `src/modules/factory/catalog.tsx` | `/api/catalogs` |
| Data Hub | Data Hub (`datahub.hub`) | `src/modules/datahub/hub.tsx` → `view/DataHubPanel.tsx`, `view/hub/*` | `/api/admin/datahub/*` |
| | Portfolio Maker (`datahub.portfolios`) | `src/modules/datahub/portfolios.tsx` → `src/legacy/factory/WatchlistPanel.tsx` | `/api/watchlists*`, `/api/instruments/*` |
| Macro | Macro analysis (`macro.analysis`) | `src/modules/macro/analysis.tsx`, `view/*` | `content/fusion/*.md`, `src/lib/fusion/*` |
| Control panel (owner) | Live controller (`control.machines`) | `src/modules/control/machines.tsx` → `src/legacy/control/LiveControllerPanel.tsx` | `/api/machines/status`, `/api/admin/machines/control` |
| | Branch reviews (`control.reviews`) | `src/modules/control/reviews.tsx`, `src/lib/reviews.ts` | `/api/admin/reviews`, files the server's review sync downloads (REVIEWS_DIR) |
| | Hub reviews | `control/hub-reviews.tsx` → `legacy/control/HubReviewsPanel.tsx` | `/api/admin/hub-reviews` |
| | Users | `control/users.tsx` → `legacy/control/AdminAccessPanel.tsx` | `/api/admin/{approvals,invites,machines}` |
| | Schedule | `control/schedule.tsx` → `legacy/control/schedule/` | `/api/admin/schedule`, `src/lib/schedule-release1.json` |
| | Data | `control/data.tsx` | `/api/admin/datahub` |
| | Hub services | `control/services.tsx` → `legacy/control/HubServicesPanel.tsx` | `/api/admin/services` |
| | Credentials | `control/credentials.tsx` | `/api/admin/credentials` |
| Account | Your account (`account.profile`) | `src/modules/account/profile.tsx` | `/api/sso/me`, `/api/sso/profile`, `/api/passkey*` |
| Planned | every `planned.*` entry | `src/modules/planned.tsx` | `content/planned/*.md` |

`src/legacy/` holds panels kept from the old site (styled by `src/legacy/compat.css` and `legacy/factory/portfolio.css`).
They lint with warnings, not errors. Rebuilding one on the kit and deleting its legacy file is a good first change.

## 4. The server side

| Part | Files |
|---|---|
| Database tables and queries (shared with production: add columns, never drop) | `src/lib/db.ts` |
| Sessions, users, admin checks | `src/lib/auth.ts`, `src/lib/accounts.ts`, `src/lib/profile.ts` |
| Routes other services call (the hooks contract) | `src/app/api/{machine,sso,hubs,nav,workbench}/` (listed in `contract/hooks.json`; payloads in contract/README.md) |
| Demo mode | `src/lib/site-mode.ts`, `src/lib/demo.ts`, `scripts/local-demo.mjs` |
| The Services Hub and the Arcade (serviceshub. / arcade. hosts) | pages: `public/services/` (index, trader, arcade); routing: `src/proxy.ts` servicesHost, `src/lib/hosts.ts`; sign-in: client `fusionhub` in `src/lib/sso.ts`; simulated /v1 API: `src/lib/sim-services.ts`, `src/app/api/sim/services/` |
| Simulated backend (local development) | `npm run sim`: `scripts/sim.mjs`, `src/lib/sim-db.ts` (in-process Postgres), `sim/warehouse.sql`, `scripts/demo-seed.mjs`; `npm run mock:machine`: `scripts/mock-machine.mjs` (a controller on the real hooks) |

## 5. Styles, in one picture

One palette everywhere: the tokens at the top of `src/shell/shell.css` (light, then dark), Arcium Signals blue as the
only accent. Every other stylesheet uses those tokens (`var(--accent)`, `var(--text)`, `var(--border)`, …), never fixed
colours, except the Macro charts' categorical colours (phases, bands, cycles), which carry meaning.

## 6. House patterns

- **Fetching:** `useJson(url, everyMs)` from the kit, not a hand-written `useEffect` + `fetch`.
- **Time labels ("5 min ago", stale checks):** `const now = useNow()` from the kit; never `Date.now()` while rendering.
- **Posting:** `postJson(url, body)` → `{ ok, data }`; show the result with `<Notice msg={…} />`.
- **Loosely typed JSON** (database rows, route replies) is allowed where it is marked: `src/lib/db.ts` as a whole, and
  elsewhere an `eslint-disable-next-line @typescript-eslint/no-explicit-any -- <why>` on the line.

## 7. Cleanup backlog (good first changes)

`npm run lint` lists about 20 warnings, all React's "state set inside an effect" advice. They work today. Each is one
of three kinds, with the preferred fix:

| Kind | Where | Fix |
|---|---|---|
| Fetch when the page opens (`useEffect(() => { load(); }, [])`) | legacy Users, Hub services, Schedule; Data Hub Recorder, Warehouse | `useJson` from the kit |
| Reset when a choice changes (`useEffect(() => { setX(null) }, [choice])`) | Portfolio Maker, Data Hub Sources, Recorder | give the child a `key={choice}`, or reset in the handler that changes the choice |
| Read the browser after the first render (localStorage, passkey support, the URL) | sign-in, Data Hub, drill tables | keep the effect (the server can't read these); add `// eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only` |

Rebuilding a `src/legacy/` panel on the kit clears its warnings at the same time.

## 8. Checks

    npm run check        type check + ESLint + the header rule (a pull request must pass)
    npm run lint:fix     ESLint's automatic fixes
    npm run test:gui     the GUI suite (tests/gui/README.md)
    tests/demo/          the demo agent: records the screens a change touches (tests/demo/README.md)

Pull requests: `.github/workflows/pr.yml` (check, gui, demo), `main.yml` (the walkthrough after a merge),
`.github/CODEOWNERS`, the template, and CONTRIBUTING.md "How a change gets in".
