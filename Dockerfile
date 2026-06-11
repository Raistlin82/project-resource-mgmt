# syntax=docker/dockerfile:1
#
# Multi-stage image for the Delivery Control PSA app (Angular 21 SSR + Express).
#
# The Angular `@angular/build:application` builder runs with outputMode "server"
# (see angular.json), so `npx ng build` emits BOTH halves of the app under
# dist/<project>/:
#   - dist/app/browser/        -> client bundles (served as static assets)
#   - dist/app/server/server.mjs  -> the SSR + Express entry (src/server.ts)
# The project name is "app" (angular.json projects.app), which is why the entry
# is dist/app/server/server.mjs — the same path package.json's `serve:ssr:app`
# script runs. server.mjs binds to PORT/HOST and mounts /api, /<static>, and the
# Angular SSR catch-all.
#
# Migrations are NOT baked in: initPersistence() runs drizzle migrate + an
# idempotent seed at boot (src/db/bootstrap.ts) when DATABASE_URL is set, so the
# generated SQL under ./drizzle must be present at runtime. It is copied below.

# --- Stage 1: build -----------------------------------------------------------
# Pinned to Node 22 (LTS) — Angular 21 / @angular/build require Node 20.19+ or 22.
FROM node:22-bookworm AS build
WORKDIR /app

# Install dependencies first (better layer caching). Copy only the manifests so a
# code-only change does not invalidate the npm layer.
COPY package.json package-lock.json ./
# `npm ci` is the reproducible install for CI/images. If the lockfile has drifted
# out of sync with package.json, `npm ci` fails by design — regenerate it locally
# with `npm install` and commit the updated package-lock.json, then rebuild.
RUN npm ci

# Copy the rest of the sources and produce the production build.
COPY . .
RUN npx ng build

# --- Stage 2: runtime ---------------------------------------------------------
# Slim runtime: no build toolchain, just Node + the built app + prod deps.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bind on all interfaces inside the container so the published port is reachable;
# PORT 3000 matches the app's default and the compose port mapping.
ENV PORT=3000
ENV HOST=0.0.0.0

# Production dependencies only (the SSR server needs express, pg, jose,
# drizzle-orm, the Angular runtime, ... at runtime).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built app (browser + server) and the runtime assets the SSR server reads.
COPY --from=build /app/dist ./dist
# Drizzle migrations are applied at boot by initPersistence() (DATABASE_URL set).
COPY --from=build /app/drizzle ./drizzle
# drizzle.config.ts is not needed at runtime (initPersistence points migrate() at
# ./drizzle directly), but keep it so `npx drizzle-kit` is usable inside the
# container for ad-hoc migration generation.
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

# Drop root for the running process.
USER node

EXPOSE 3000

# Boot the SSR + Express server. The same module that `npm run serve:ssr:app`
# runs; verified against angular.json (project "app") and package.json.
CMD ["node", "dist/app/server/server.mjs"]
