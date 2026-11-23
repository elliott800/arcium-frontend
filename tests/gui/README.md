# GUI suite

Every feature in `features.mjs` is opened in a real browser (Playwright), clicked, and checked for what it should
show and the API call it should make. Calls that would change something (start an engine, save, apply a list)
are answered by a mock, so nothing really runs; reads go to the site.

    npm run test:gui                                   # the dev server on http://localhost:3005 (the owner's test site)
    node tests/gui/run.mjs http://localhost:3000       # your dev server
    node tests/gui/run.mjs --only=shell.               # one group
    node tests/gui/run.mjs --update-baseline           # accept the current passing set

Sign-in: locally the suite opens a session for the first approved admin in the database named by `.env.local`
(`session.mjs`); against another site set `GUI_LOGIN` and `GUI_PASSWORD`.

Groups: **shell** (bar, docking, panel, menu, checklist, tabs, workspaces), **dashboards** (every dashboard in
`src/modules/registry.ts` opens: generated, so a new dashboard is covered at once), **factory**, **data**,
**public** (signed out), **mobile** (phone size).

`baseline.json` is the set that passed last time: a feature in it that fails now is a REGRESSION and the run exits 2.
`out/report.json` has every result and the calls each made; a failure leaves a screenshot in `out/`.

Adding a feature: an entry with `id`, `area`, `name` and `run(t)` in the right group of `features.mjs`, using the
helpers in `run.mjs` (`goto`, `click`, `see`, `text`, `count`, `noOverflow`, `mock`).
