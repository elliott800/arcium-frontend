# Working on arcium frontend

The GUI of Arcium Signals: a workspace of dashboards (Next.js 16, React 19, TypeScript, Postgres). This guide is
for anyone working on it. You never need production access: you develop against a simulated backend.

## Set up (about 2 minutes)

You need Node 24 and Git. Nothing else: no database server, no `.env.local`.

    npm ci
    npm run sim                         # http://localhost:3010 (the first start builds .sim-db/, about a minute)

Press **Start a test session** and you are in the workspace on the simulated machine (a session lasts two hours;
sign out deletes it), or sign in as the simulated owner, `admin@example.com` / `sim-admin-password`, to see the
admin dashboards too. `npm run sim -- --reset` throws the simulated database and its build cache (`.next-sim`) away: run it after pulling if a page or API answers 404.
If the repository is in a synced folder (Google Drive, OneDrive, Dropbox), set `ARCIUM_SIM_DIR` in `.env.local` to a
folder outside it: sync clients lock the database's files while uploading them.

**The other Arcium hosts.** The same server answers as the Services Hub, http://serviceshub.localhost:3010 (Trader at
`/trader`), and the Arcade, http://arcade.localhost:3010. Sign in to the site first, then use "Sign in with Arcium"
there. Their pages are plain HTML and JavaScript in `public/services/`, served as production serves them; their `/v1`
API is simulated (`src/lib/sim-services.ts`: simulated prices, sample scanner data). To use a real Fusion Hub instead,
set `SERVICES_API_URL` (e.g. `http://127.0.0.1:8094`).

**The backend, simulated.** In a second terminal:

    npm run mock:machine                # a controller machine on the real hooks: heartbeat, a live equity stream,
                                        # commands from the GUI picked up and acknowledged
    npm run mock:machine -- --once      # or one round of every hook, PASS/FAIL each

Its silo, `mock_live`, streams a new equity row every 10 seconds. Sign in as the simulated owner to watch it live
(Factory > Engine Hangar); new test sessions get a copy of it as it stood when they started, and
`--user <your test session's username>` streams into your session instead. How the backend and this site connect, with
every payload, is in contract/README.md.

**With your own Postgres 16** (closer to production, optional):

    cp .env.example .env.local          # then set DATABASE_URL to your local Postgres (database name with "demo")
    npm run demo:create                 # creates that database
    npm run dev                         # http://localhost:3000 — open it once so the site creates its tables
    npm run demo:seed                   # fills it with simulated silos, models, engines and curves


## The rules

0. **Find your way with CODEMAP.md.** Every source file opens with a comment saying what it is (the lint checks);
   long files mark sections with `// ── name ──`. Keep both up to date when you add or move code.

1. **No tokens in this repo, ever.** Real keys, passwords and connection strings live only in the owner's private
   arcium production site repo. `.env.local` is git-ignored; `.env.example` holds names, never values.
   Publishing runs a secret scan and refuses a repo that holds one.
2. **The hooks are a contract.** The routes other services call (`/api/machine/*` for the backend, `/api/sso/*`,
   `/api/hubs/*`, `/api/nav`, `/api/workbench/*`) and the settings names are listed in
   `contract/hooks.json` (explained in contract/README.md). Don't change or remove one without changing the
   contract in the same pull request and saying why; `npm run contract` checks this site keeps to it.
3. **One registry, one kit.** Every dashboard is an entry in `src/modules/registry.ts`; build it from `src/ui/kit.tsx`
   and the `m-*` classes in `src/shell/shell.css` (no new design system, no new CSS framework). Panels in
   `src/legacy/` are older code kept until someone rewrites them with the kit; prefer the kit for new work.
4. **Slim.** Add a dependency only when the kit and the platform can't do it. Remove what nothing uses.
5. **The database schema is shared with production.** `src/lib/db.ts` creates and upgrades the tables; add columns
   with `ADD COLUMN IF NOT EXISTS`, never drop or rename one the live site or the backend still uses.

## Adding a dashboard

See README.md "Adding a dashboard": one file under `src/modules/<group>/`, one registry entry. It appears in the
menu, the checklist and the home page, gets a URL (`/w/<id>`), and the GUI suite smoke-tests it.
Planned dashboards (`status: 'planned'`) open their plan in `content/planned/`; build one by giving it a `load`.

## Before you open a pull request

    npm run check               # type check + ESLint + the header rule + the hooks contract; 0 errors
    npm run test:gui            # against your running site; see tests/gui/README.md

- A change to the shell or a dashboard needs its GUI feature in `tests/gui/features.mjs` (the registry smoke test is
  automatic; add a feature for what your dashboard does).
- Keep commits small, one change each, with a message that says what changed for the person using the site.

## How a change gets in

1. Branch from `main` (`git switch -c <short-name>`), commit, push, open a pull request. Fill in the template.
2. CI runs three checks (`.github/workflows/pr.yml`): **check** (type check, lint, build), **gui** (the GUI suite on a
   throwaway demo database) and **demo**: the demo agent (`tests/demo/`) records every screen your change touches,
   before and after, as screenshots and videos. Its table is on the pull request's checks page.
3. The owner looks at the recordings on the Branch reviews page and approves or asks for changes there; the answer
   arrives as a normal review on your pull request. Push fixes to the same branch: the agent records again.
4. `main` only takes pull requests with passing checks and the owner's approval; they are squash-merged. Nobody pushes
   to `main` directly. After each merge, CI records a walkthrough of the whole suite.
5. Merging never changes the live site: the owner pins a tested release and deploys it (below). The foundation is
   resealed by the nightly regression (`foundation/foundation.py`).

## How it reaches production

The owner deploys: `deploy-side <site>` on the server builds beside the live site, tests it, swaps it in and rolls
back on a failed check. The demo (demo.arciumsignals.com) runs this same code with `ARCIUM_SITE_MODE=demo`.
