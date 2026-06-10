/**
 * Drizzle ORM database client (SERVER-ONLY).
 *
 * This module instantiates a node-postgres connection Pool and a Drizzle ORM
 * handle over it. It must NEVER be imported into browser/client bundles: it
 * reads filesystem CA certs and process env, and pulls in the `pg` driver.
 *
 * Connection lifecycle mirrors src/server.ts exactly:
 *   - A Pool is created ONLY when DATABASE_URL is set; otherwise both exports
 *     are null (the app then runs on the in-memory mock state, as the SSR
 *     server already does).
 *   - TLS is hardened identically: when PGSSL === 'true' we always verify the
 *     server certificate (rejectUnauthorized: true), optionally pinning a
 *     trusted CA bundle supplied via PG_CA_CERT. Certificate verification is
 *     never disabled.
 *
 * `pool` is exported separately so migration tooling can borrow the same
 * connection (and pool options) used at runtime.
 */
import { readFileSync } from 'node:fs';
import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const databaseUrl = process.env['DATABASE_URL'];

/**
 * Build the node-postgres Pool options, replicating the TLS-safe configuration
 * used in src/server.ts. Kept as a factory so the (read-once) CA cert and env
 * reads happen lazily only when a Pool is actually created.
 */
function buildPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    // S-HIGH (TLS): NEVER disable certificate verification. When PGSSL is
    // enabled we always verify the server certificate, optionally pinning a
    // trusted CA bundle supplied via PG_CA_CERT.
    ssl: process.env['PGSSL'] === 'true'
      ? {
          rejectUnauthorized: true,
          ca: process.env['PG_CA_CERT'] ? readFileSync(process.env['PG_CA_CERT'], 'utf8') : undefined,
        }
      : undefined,
  };
}

/**
 * Shared node-postgres connection Pool, or null when DATABASE_URL is unset.
 * Exported so migrations / scripts can reuse the same pool and TLS options.
 */
export const pool: Pool | null = databaseUrl ? new Pool(buildPoolConfig(databaseUrl)) : null;

/**
 * Drizzle ORM database handle bound to the shared Pool, or null when
 * DATABASE_URL is unset. Type is the schema-less NodePgDatabase; once
 * src/db/schema.ts exists, callers may pass it via `drizzle({ client, schema })`
 * (or this can be widened) for fully-typed relational queries.
 */
export const db: NodePgDatabase<Record<string, never>> | null = pool ? drizzle({ client: pool }) : null;
