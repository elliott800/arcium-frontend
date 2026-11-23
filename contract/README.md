# The hooks contract: how the backend talks to this site

The site and **arcium backend** (the trading engines and optimizer, running on controller machines) share no code.
They meet only at the hooks listed in [hooks.json](hooks.json): HTTP routes the backend calls on this site, and the
settings names each side reads. Hold these fixed and either side can change everything else.

You don't need the backend to work here. `npm run sim` gives the site a simulated database, and
`npm run mock:machine` plays the backend through these same hooks:

    npm run sim                          terminal 1: the site on http://localhost:3010
    npm run mock:machine                 terminal 2: a controller machine streaming into it
    npm run mock:machine -- --once       or one round of every hook, PASS/FAIL each
    npm run contract                     does the site still serve everything in hooks.json?

`hooks.json` is a copy of the contract kept in the owner's private production repo, which also checks the backend
side. **To change a hook** (add, rename or remove a route, a payload field or a setting), open a pull request that
changes `hooks.json` and the code together, and say why in the description. The owner updates the backend to match.
Adding a new optional field to a response is safe; removing or renaming one is not.

## Who calls what

```
 controller machine (arcium backend)                        this site (arcium frontend)
 ───────────────────────────────────                        ───────────────────────────
 heartbeat + table push    ── POST /api/machine/sync ──────▶  machines, silos, catalog, equity tables
 command loop (~1-2 s)     ── GET  /api/machine/commands ──▶  pending_scripts the GUI queued
                           ── POST .../commands/{id}/ack ──▶  running / completed / failed + output
 account placement         ── GET/POST /api/machine/assignments
 launcher status (1 min)   ── POST /api/machine/live-status
 market data               ── GET  /api/machine/warehouse/catalog, /read, /bars
 seeds                     ── POST /api/machine/seeds, GET /api/machine/seeds/{id}
 broker keys               ── GET  /api/machine/credentials/{id}
```

The site never calls a machine. Everything the GUI asks a machine to do goes into the command queue, and the
machine picks it up on its next poll.

## Signing in as a machine

An admin registers a machine (Control panel > Machines), which issues its key once; the site stores only a sha256
of the key. Every call carries:

    x-machine-name: demo_machine
    x-machine-key:  <key>

`/machine/sync` and `/machine/commands/{id}/ack` take the same pair as `machine_name` / `api_key` in the JSON body.
In the simulated database the machine is `demo_machine`, key `sim-machine-key` (local only, not a secret).

## The payloads

The route files are the reference (`src/app/api/machine/**/route.ts`; each opens with its request and response),
with shared types in `src/lib/api-types.ts`. In short:

**`POST /api/machine/sync`** carries the heartbeat and any tables, as row arrays:

```json
{
  "machine_name": "demo_machine", "api_key": "<the machine key>",
  "heartbeat": { "hostname": "node-01", "platform": "linux",
                 "load": { "at": 1795400000, "accounts": 0, "cpu_percent": 37, "stacks_running": 1 } },
  "tables": {
    "processes": [ { "machine_name": "demo_machine", "process_name": "engine:mock_live", "pid": 4101,
                     "status": "running", "started_at": "2026-11-22T22:00:00Z", "cmdline_summary": "..." } ],
    "web_equity_curve": [ { "username": "demo_template", "trader_name": "demo_template", "silo_name": "mock_live",
                            "engine_kind": "live", "cycle_time": "2026-11-22T22:00:00Z", "balance": 10000,
                            "equity": 10012.5, "unrealised_pnl": 12.5, "margin_used": 350, "pnl": 0,
                            "ingest_ts": "2026-11-22T22:00:01Z", "machine_name": "demo_machine" } ]
  }
}
```

Response: `{ "ok": true, "results": { "processes": 1, "web_equity_curve": 1 } }`, with a number of rows written
per table, or a `"skipped: <reason>"` string. Tables a machine may push: `silo_registry`, `folder_tree`,
`workspace_folders`, `silo_managers`, `catalog_models`, `catalog_signals`, `catalog_signal_stats`, `nav_blob`,
`portfolio_blob`, `web_equity_curve`, `web_portfolio_allocs`, `web_balance_allocs`, `watchlists`, `processes`
(`ALLOWED_SYNC_TABLES` in `src/lib/db.ts`; their columns are the `CREATE TABLE`s there). `processes` is a full
snapshot each time; every other table is upserted on its key. For full example rows of every table, see
`scripts/demo-seed.mjs`, which writes the simulated database in exactly the shape the backend pushes.

**`GET /api/machine/commands`** returns `{ "commands": [ { "id", "machine_name", "username", "script_path",
"flags" (JSON text), "status": "pending", "priority", "created_at", ... } ] }`.
The machine runs each one, then **`POST /api/machine/commands/{id}/ack`** with
`{ machine_name, api_key, status: "running" | "completed" | "failed", output?, error?, exit_code?, pid? }`.

**`GET /api/machine/assignments`** returns `{ machine_name, accounts: [ { id, owner_username, name, broker,
seed_id, seed_name, status, paused, removed, credentials, seed_bundle_url, ... } ] }`; the machine reports progress
with `POST { account_id, status: "provisioning" | "ready" | "error" | "removing" | "removed", detail? }`.

**`POST /api/machine/live-status`** takes any JSON status object up to 60 KB (the launcher sends `commit`,
`paused`, `training`, `train_logs`, `launcher_log`); the Control panel shows it.

**`GET /api/machine/warehouse/catalog`** (`?connection=&key=&match=&limit=`) lists what the Data Hub records:
`{ hooks: [ { hook_id, connection, key, params, enabled, series: [ { series_id, part, field, store, first, last,
rows } ] } ] }`. **`GET /api/machine/warehouse/read?series_id=&from=&to=&limit=`** returns one series' rows;
**`GET /api/machine/bars?symbol=&rate=&limit=`** returns `{ symbol, rate, source, bars: [ { t, o, h, l, c, v } ] }`.

## The Services Hub API (`services_api`)

The Services Hub and Arcade pages, which this repo serves on serviceshub.arciumsignals.com and
arcade.arciumsignals.com (`public/services/`), call the Services Hub service (Fusion Hub, Python) under `/v1`. In
production nginx sends `/v1` on those hosts to the service. Locally, `src/proxy.ts` sends it to `SERVICES_API_URL`
when that is set, otherwise (under `npm run sim`) to the simulated one in `src/lib/sim-services.ts`, which answers
every route listed in `services_api`; `npm run contract` checks that it does.

Sign-in: the page sends the browser to the app's `/sso?client=fusionhub`, comes back with a pass, and trades it at
`POST /v1/auth/sso` for a bearer token (or `POST /v1/auth/login` with an email and password). Every call after that
carries `Authorization: Bearer <token>`. Errors are `{ "error": "...", "code"?: "..." }` with an HTTP status.

## Settings

`frontend_env` in hooks.json lists every environment setting the site may read: `hooks` are shared with other
services, `site_only` are this site's own. `npm run contract` fails if the code reads one not listed. Values never
go in this repo; `.env.example` shows which ones local development needs (with `npm run sim`, none).
