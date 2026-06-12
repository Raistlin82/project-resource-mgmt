#!/usr/bin/env bash
#
# start-prod.sh — Delivery Control in PRODUCTION mode.
#
#   • Persists to PostgreSQL via DATABASE_URL. On boot the server runs the Drizzle
#     migrations (drizzle/) and idempotently seeds reference data (initPersistence)
#     — no separate migrate step is required.
#   • Real authentication: Keycloak OIDC (OIDC_ISSUER, optional OIDC_AUDIENCE).
#     Header-trust is FORCED off — verified JWTs only.
#
# Configure via environment variables or a .env file at the repo root
# (see .env.example). Refuses to start if a production precondition is unmet.
# Usage:  npm run start:prod     (or:  ./scripts/start-prod.sh)
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env (operator configuration) if present; exported so the server inherits it.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

SERVER="dist/app/server/server.mjs"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

fail() { echo "ERROR: $1" >&2; exit 1; }

# --- Production preconditions -------------------------------------------------
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL must be set (PostgreSQL connection string). See .env.example."
[ -n "${OIDC_ISSUER:-}" ]  || fail "OIDC_ISSUER must be set (Keycloak realm issuer URL). See .env.example."
if [ "${AUTH_TRUST_HEADERS:-false}" = "true" ]; then
  fail "AUTH_TRUST_HEADERS must NOT be 'true' in production (it trusts spoofable headers). Unset it or set 'false'."
fi

if [ ! -f "$SERVER" ]; then
  echo "→ Build not found — building (npm run build)…"
  npm run build
fi

echo "→ Delivery Control — PRODUCTION — http://${HOST}:${PORT}"
echo "  • PostgreSQL persistence (migrations + idempotent seed applied on boot)"
echo "  • Keycloak OIDC issuer: ${OIDC_ISSUER}"
echo "  • header-trust OFF (verified JWTs only); PGSSL=${PGSSL:-false}"
echo

# AUTH_TRUST_HEADERS is forced false here as a hard safety guard; DATABASE_URL,
# OIDC_ISSUER, OIDC_AUDIENCE, PGSSL, PG_CA_CERT, etc. are inherited from the env/.env.
exec env \
  PORT="$PORT" \
  HOST="$HOST" \
  AUTH_TRUST_HEADERS=false \
  node "$SERVER"
