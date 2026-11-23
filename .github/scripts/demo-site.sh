#!/usr/bin/env bash
# CI: a demo site on a throwaway database. Writes .env.local, creates and fills the demo database, builds and starts
# the site on the given port, and waits until it answers.   usage: bash .github/scripts/demo-site.sh <port>
set -euo pipefail
PORT="${1:-3000}"

# ── settings: a demo database, random keys made for this run only ──
if [ ! -f .env.local ]; then
  {
    echo "DATABASE_URL=${DATABASE_URL}"
    echo "ARCIUM_SITE_MODE=demo"
    echo "ARCIUM_SECRET_KEY=$(openssl rand -hex 32)"
    echo "ARCIUM_ADMIN_EMAIL=${ARCIUM_ADMIN_EMAIL}"
    echo "ARCIUM_ADMIN_PASSWORD=$(openssl rand -hex 16)"
  } > .env.local
fi

# ── database, build, start ──
npm run demo:create
npm run build
nohup npx next start -p "$PORT" > "server-$PORT.log" 2>&1 &
for i in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:$PORT/" && break; sleep 2; done
curl -fs -o /dev/null "http://localhost:$PORT/api/site-info"     # the first request creates the tables and the owner account
sleep 2

# ── simulated silos, models, engines and curves ──
npm run demo:seed
echo "demo site on http://localhost:$PORT"
