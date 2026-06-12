#!/usr/bin/env bash
#
# start-dev.sh — Delivery Control in DEV / TEST mode with demo data.
#
#   • In-memory repository (DATABASE_URL forced unset) → seeded demo data,
#     reset on every restart. No PostgreSQL required.
#   • Demo auth: AUTH_TRUST_HEADERS=true → the SPA auto-logs in as "Demo Admin"
#     (the AuthService demo fallback) — no Keycloak required.
#
# NOT for production: header-trust accepts spoofable X-User-* headers.
# Usage:  npm run start:dev     (or:  PORT=4100 ./scripts/start-dev.sh)
#
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4000}"
HOST="${HOST:-localhost}"
SERVER="dist/app/server/server.mjs"

if [ ! -f "$SERVER" ]; then
  echo "→ Build not found — building (npm run build)…"
  npm run build
fi

echo "→ Delivery Control — DEV / demo data — http://${HOST}:${PORT}"
echo "  • in-memory repository (seeded demo data; resets on restart)"
echo "  • auto-login as Demo Admin (AUTH_TRUST_HEADERS=true) — no Keycloak needed"
echo "  • Ctrl-C to stop"
echo

# Force demo mode regardless of any .env in the environment:
#   -u DATABASE_URL → no Postgres → in-memory seeded repository.
exec env -u DATABASE_URL \
  PORT="$PORT" \
  HOST="$HOST" \
  AUTH_TRUST_HEADERS=true \
  NG_ALLOWED_HOSTS="${NG_ALLOWED_HOSTS:-localhost,127.0.0.1}" \
  node "$SERVER"
