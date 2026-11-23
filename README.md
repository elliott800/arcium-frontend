# arcium frontend

The GUI of the Arcium rebuild (Release 1 r3): a slim, fresh build of app.arciumsignals.com, one of three
repos beside **arcium backend** (the terminal optimizer and engine hangar, run on the controller machines)
and **arcium production site** (the server setup, the hooks contract and the release lock).

The design (owner, Nov 21, 2026): plain and essential, **driven by workspace management**. A nav bar docks
to any edge; its side panel reveals the dashboard menu, whose contents are set from a checklist; open
dashboards sit in tabs; named workspaces keep an arrangement. Dashboards that are planned but not built
are in the menu too, opening their plan.

## Open source: build freely, the owner merges

MIT licensed (LICENSE; names and logos: NOTICE.md). Anyone can fork, build and open a pull request. Every pull
request runs the checks and the demo agent, which records the screens it changes before and after; the owner looks
at that and approves before anything reaches `main`. Start with CONTRIBUTING.md and CODEMAP.md; the cleanup backlog
in CODEMAP.md lists good first changes. Development runs on a simulated backend (`npm run sim`, plus `npm run mock:machine` for a controller machine
talking through the real hooks): no database server, account or production access is needed.

## Run it

    npm ci
    npm run sim                     the site on a simulated backend: http://localhost:3010, nothing else to install
    npm run mock:machine            (second terminal) a simulated controller machine streaming into it
    npm run check                   type check, ESLint, the header rule and the hooks contract
    node tests/gui/run.mjs http://localhost:3010     the GUI suite (see tests/gui/README.md)

The same server also answers as the other Arcium hosts, as production does:
**http://serviceshub.localhost:3010** (the Services Hub, with Trader at `/trader`) and **http://arcade.localhost:3010**
(the Arcade). Their pages are in `public/services/`; their `/v1` API is simulated under `npm run sim`
(`src/lib/sim-services.ts`) and is Fusion Hub's in production. "Sign in with Arcium" works on both.

On the simulated backend, press **Start a test session**, or sign in as the simulated owner
(`admin@example.com` / `sim-admin-password`) for the admin dashboards. `npm run sim -- --reset` starts it over.
Its data is the Data Hub warehouse sample in `sim/warehouse.sql` and the simulated systems from
`scripts/demo-seed.mjs`. A local Postgres works too (CONTRIBUTING.md, "With your own Postgres").

Settings for `npm run dev` come from `.env.local` (never committed); the names the site may read are listed in
`contract/hooks.json`.

## Layout

CODEMAP.md walks the site in click order (landing, sign-in, workspace, each dashboard) with the files and API
routes behind each part.

| Path | What |
|---|---|
| `src/modules/registry.ts` | **Every dashboard, in one list.** The menu, checklist, tabs, access and tests come from it. |
| `src/modules/<group>/<name>.tsx` | One dashboard each (Factory, Data Hub, Macro, Control panel). |
| `src/modules/planned.tsx`, `content/planned/*.md` | Planned dashboards: their plan until they are built. |
| `src/shell/` | The workspace shell (dockable bar, side panel, tabs, workspaces) and its stylesheet with the `m-*` kit. |
| `src/ui/kit.tsx` | What dashboards share: `useJson`, `Table`, `Page`, `sendControl`, `ago`, `num`. |
| `src/app/w/` | The workspace routes: `/w` and `/w/<dashboard id>`. |
| `src/app/api/` | The routes: the dashboards' data, plus the hooks other services call (machine, SSO, hubs, alarm, workbench). |
| `src/legacy/` | Panels kept from the old site until rewritten with the kit (`compat.css` styles them). |

## Adding a dashboard

1. Write `src/modules/<group>/<name>.tsx`. Its default export is the dashboard: a server component, or a
   client one (`'use client'`). Build it from the kit:

   ```tsx
   'use client';
   import { Page, Table, useJson } from '@/ui/kit';

   export default function Example() {
     const { data } = useJson<{ name: string; value: number }[]>('/api/example', 15000);
     return (
       <Page title="Example" intro="What it shows.">
         <Table rows={data ?? []} rowKey={r => r.name}
           columns={[{ key: 'name', label: 'Name' }, { key: 'value', label: 'Value', numeric: true }]} />
       </Page>
     );
   }
   ```

2. Add one entry to `MODULES` in `src/modules/registry.ts`:

   ```ts
   { id: 'factory.example', group: 'Factory', title: 'Example', access: 'admin', status: 'live',
     summary: 'One line for the menu and the home page.', load: () => import('./factory/example') },
   ```

That's all: it appears in the menu, the checklist and the workspace home, opens at `/w/factory.example`,
gets a tab, and the GUI suite smoke-tests it. A new group is a new `group` name (add it to `GROUPS` to set
its place). A module that needs the URL's query takes `{ searchParams }` (see `macro/analysis.tsx`).

**Turning a planned dashboard into a real one:** give its entry a `load`, set `status: 'live'`, and keep
or delete its plan in `content/planned/`.

**Data:** a dashboard reads the site's routes under `src/app/api`. If it needs new data from the machines,
that goes through the hooks (`contract/hooks.json`, explained in contract/README.md): change the contract and
the code in the same pull request; the owner updates the backend to match.

## How it joins the backend

Only through the hooks in `contract/hooks.json` (explained, with payloads, in contract/README.md): the
`/api/machine/*` routes the backend calls with its `X-Machine-Name` / `X-Machine-Key` headers, and the site's
own database. The same contract lists the routes the hubs, the ArciumAlarm app and the seed workbench use, so the
slim build cannot drop them unnoticed. `npm run mock:machine` plays the backend through these hooks.

    npm run contract                the site still serves every hook (part of npm run check and CI)

## Foundation

    python foundation/foundation.py status          what the foundation holds and what proves it
    python foundation/foundation.py seal            when the GUI suite and the contracts pass
