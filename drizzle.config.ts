import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration (drizzle-kit 0.31.x).
 *
 * Drives schema introspection, migration generation, and `drizzle-kit migrate`
 * against PostgreSQL. The connection string is taken from DATABASE_URL — the
 * same env var the SSR server uses (see src/server.ts / src/db/client.ts).
 *
 * Note: drizzle-kit reads this at CLI invocation time, so DATABASE_URL must be
 * present in the environment when running e.g. `npx drizzle-kit generate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
