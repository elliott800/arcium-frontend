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
curl -fs -o /dev/null "http://localhost:$PORT/api/site-info"
# The first database request creates the tables and the owner account (site-info reads no database). A sign-in with
# an account that does not exist opens the database and is refused; the 401 is expected.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Origin: http://localhost:$PORT"   -d '{"login":"nobody@example.invalid","password":"x"}' "http://localhost:$PORT/api/login")
echo "schema request answered $code"
[ "$code" = 401 ] || [ "$code" = 403 ] || { echo "the site could not open its database"; tail -50 "server-$PORT.log"; exit 1; }

# ── simulated silos, models, engines and curves ──
npm run demo:seed
echo "demo site on http://localhost:$PORT"
