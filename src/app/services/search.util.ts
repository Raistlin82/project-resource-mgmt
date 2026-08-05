/**
 * Cross-entity search (Block G) — pure match/paginate layer. No I/O, no clock.
 *
 * Mirrors `/audit-logs`'s own clamp shape (`AUDIT_LOG_DEFAULT_LIMIT`/
 * `AUDIT_LOG_MAX_LIMIT`, `server.ts:6521-6522`) with this feature's own
 * thresholds, applied per-collection (design spec §7) rather than invented
 * once for a combined endpoint that does not exist here.
 *
 * Deliberately NOT adapter-aware: every caller applies this AFTER an
 * unmodified `repos.X.list()` call, the same call every existing read of
 * that collection already makes on either persistence adapter. There is no
 * `if (db) { SQL } else { ... }` branch here (contrast `/audit-logs`) because
 * there is no adapter-specific operator to run — parity is a consequence of
 * calling the SAME function once, not a second path to keep in sync
 * (design spec §7).
 */

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** Clamp raw (string | undefined) query values into a safe {limit, offset} pair. */
export function clampSearchPage(raw: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const rawLimit = Number(raw.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
  const rawOffset = Number(raw.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * Case-insensitive substring match across one or more fields of T. A field
 * whose value is not a string (undefined, a number, ...) never matches and
 * never throws — this project's records carry several optional string
 * fields (e.g. `Resource.organization?`, `ResourceRequest.description?`).
 */
export function matchesQuery<T>(record: T, fields: readonly (keyof T)[], q: string): boolean {
  const needle = q.toLowerCase();
  return fields.some(field => {
    const value = record[field];
    return typeof value === 'string' && value.toLowerCase().includes(needle);
  });
}

/**
 * Filters (only when `q` is a non-empty string) then paginates. When `q` is
 * `undefined`, returns the FULL array unmodified — the backward-compatibility
 * invariant every existing caller of these six collections depends on
 * (design spec §3): omitting the query parameter must behave exactly as it
 * does today, on every one of these six endpoints.
 */
export function searchPage<T>(
  records: readonly T[],
  fields: readonly (keyof T)[],
  q: string | undefined,
  page: { limit: number; offset: number },
): T[] {
  if (q === undefined) return [...records];
  const trimmed = q.trim();
  const matched = trimmed === '' ? [...records] : records.filter(r => matchesQuery(r, fields, trimmed));
  return matched.slice(page.offset, page.offset + page.limit);
}
