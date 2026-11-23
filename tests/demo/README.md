# Demo agent

Shows the owner what a change looks like before it merges. On every pull request CI (`.github/workflows/pr.yml`,
job `demo`) runs it; after every merge to main it records the walkthrough (`.github/workflows/main.yml`).

| Step | File | What it does |
|---|---|---|
| 1 | `changed.mjs` | changed files → the screens they touch (dashboards from `src/modules/registry.ts`, the workspace home, the public pages), following imports and the API routes each dashboard calls |
| 2 | `tour.mjs` | opens each screen signed in, waits until nothing says "Loading…", records a scrolling video, a desktop and a phone screenshot, console errors and load time |
| 3 | `summary.mjs` | pairs `before` (main) with `after` (the branch) into `demo-report.json` and a markdown table for the checks page |

The tour only looks: every API call that would change something is answered locally and never reaches the site.

## Run it yourself

    git diff --name-only origin/main...HEAD | node tests/demo/changed.mjs - > tests/demo/screens.txt
    node tests/demo/tour.mjs --base http://localhost:3000 --label after --screens-file tests/demo/screens.txt
    node tests/demo/tour.mjs --base http://localhost:3000 --all --walkthrough --label walkthrough
    node tests/demo/summary.mjs tests/demo/out

Output goes to `tests/demo/out/<label>/` (git-ignored). Sign-in works like the GUI suite (`tests/gui/session.mjs`):
your `.env.local` demo database, or `GUI_LOGIN` / `GUI_PASSWORD` for another site.

## Where the owner sees it

The server's review sync (`arcium_production_site/server/review-sync.py`) downloads each run's `demo-<pr>-<sha>`
artifact; the Branch reviews page (Control panel, or reviews.arciumsites.com) shows before and after side by side
with the videos, and posts the owner's Approve or Request changes back to the pull request.
