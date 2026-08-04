#!/usr/bin/env bash
#
# start-prod.sh — Delivery Control in PRODUCTION mode.
#
#   • Persists to PostgreSQL. On boot the server runs Drizzle migrations; demo
#     seed is disabled unless SEED_DEMO_DATA=true is explicitly configured.
#   • Real authentication: Keycloak OIDC (issuer + audience are mandatory).
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
[ -n "${OIDC_AUDIENCE:-}" ] || fail "OIDC_AUDIENCE must be set for production token validation. See .env.example."
PERSISTENCE_ADAPTER="${PERSISTENCE_ADAPTER:-postgresql}"
[ "$PERSISTENCE_ADAPTER" = "postgresql" ] || fail "PERSISTENCE_ADAPTER must be 'postgresql' in production."
SEED_DEMO_DATA="${SEED_DEMO_DATA:-false}"
case "$SEED_DEMO_DATA" in true|false) ;; *) fail "SEED_DEMO_DATA must be exactly 'true' or 'false'." ;; esac
if [ "${AUTH_TRUST_HEADERS:-false}" = "true" ]; then
  fail "AUTH_TRUST_HEADERS must NOT be 'true' in production (it trusts spoofable headers). Unset it or set 'false'."
fi

if [ ! -f "$SERVER" ]; then
  echo "→ Build not found — building (npm run build)…"
  npm run build
fi

echo "→ Delivery Control — PRODUCTION — http://${HOST}:${PORT}"
echo "  • PostgreSQL persistence (migrations on boot; demo seed=${SEED_DEMO_DATA})"
echo "  • Keycloak OIDC issuer: ${OIDC_ISSUER}"
echo "  • header-trust OFF (verified JWTs only); PGSSL=${PGSSL:-false}"
echo

# AUTH_TRUST_HEADERS is forced false here as a hard safety guard; DATABASE_URL,
# OIDC_ISSUER, OIDC_AUDIENCE, PGSSL, PG_CA_CERT, etc. are inherited from the env/.env.
exec env \
  NODE_ENV=production \
  PERSISTENCE_ADAPTER="$PERSISTENCE_ADAPTER" \
  SEED_DEMO_DATA="$SEED_DEMO_DATA" \
  PORT="$PORT" \
  HOST="$HOST" \
  AUTH_TRUST_HEADERS=false \
  node "$SERVER"
