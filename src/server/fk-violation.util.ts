/**
 * Narrow guard for a PostgreSQL foreign-key-violation error. The `pg` driver
 * surfaces the SQLSTATE in a string `code` property (`'23503'` ==
 * foreign_key_violation) — present on both the JS `DatabaseError` and the
 * native binding — but drizzle-orm's `PgPreparedQuery.queryWithCache` (every
 * query path) catches that and rethrows a `DrizzleQueryError` wrapping it as
 * `.cause`, never copying `.code` onto the outer error
 * (`node_modules/drizzle-orm/pg-core/session.js`). Checking `err.code` alone
 * therefore NEVER matches in practice on this stack — verified against a
 * genuinely fresh Postgres (Task 10's fresh-Postgres parity run): deleting an
 * FK-referenced row raised a raw 500 HTML error page, not the 409 this
 * function exists to produce. Walk the `.cause` chain (bounded, in case of a
 * cyclic or unexpectedly deep wrap) rather than assuming the SQLSTATE is
 * flat. Read via `unknown`/`in` so no `any` leaks in.
 */
export function isFkViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 5 && typeof current === 'object' && current !== null; i++) {
    if ('code' in current && (current as { code?: unknown }).code === '23503') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
