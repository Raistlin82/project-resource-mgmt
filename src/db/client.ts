/**
 * Drizzle ORM database client (SERVER-ONLY).
 *
 * This module instantiates a node-postgres connection Pool and a Drizzle ORM
 * handle over it. It must NEVER be imported into browser/client bundles: it
 * reads filesystem CA certs and process env, and pulls in the `pg` driver.
 *
 * Connection lifecycle mirrors src/server.ts exactly:
 *   - Adapter selection is validated by persistence-config.util. Production
 *     cannot fall back to memory, unknown explicit values fail startup, and a
 *     Pool is created only for the resolved PostgreSQL adapter.
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
import { resolvePersistenceConfig } from './persistence-config.util';

/** Validated once at module load so no caller can select a different adapter. */
export const persistenceConfig = resolvePersistenceConfig(process.env);

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
 * Shared node-postgres connection Pool, or null for the validated memory mode.
 * Exported so migrations / scripts can reuse the same pool and TLS options.
 */
export const pool: Pool | null = persistenceConfig.adapter === 'postgresql'
  ? new Pool(buildPoolConfig(persistenceConfig.databaseUrl))
  : null;

/**
 * Drizzle ORM database handle bound to the shared Pool, or null when
 * memory mode is selected. Type is the schema-less NodePgDatabase; once
 * src/db/schema.ts exists, callers may pass it via `drizzle({ client, schema })`
 * (or this can be widened) for fully-typed relational queries.
 */
export const db: NodePgDatabase<Record<string, never>> | null = pool ? drizzle({ client: pool }) : null;
