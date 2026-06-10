/**
 * Pure id-sequence helper (SERVER-ONLY, no side effects, unit-testable).
 *
 * Extracted from src/server.ts so it can be tested WITHOUT importing the SSR
 * Express app (which instantiates the Angular app engine at module load). The
 * server re-exports `maxIdSeq` from here, so callers and tests share one source
 * of truth.
 */

/**
 * Largest numeric suffix embedded in a set of ids.
 *
 * `newId()` (in server.ts) emits a bare number, but that number is also embedded
 * inside the PREFIXED ids the handlers build from it ('TE'+newId(), 'AL'+newId(),
 * 'AR'+newId(), 'OB'+newId()). For each id we strip a single leading run of ASCII
 * letters ([A-Za-z]+) and parse the remaining characters as the numeric suffix;
 * ids whose remainder is not all-digits are ignored. Returns the max suffix seen,
 * or 0 for an empty/no-numeric set. Used by `seedSequences` so a restart never
 * re-issues a suffix already burned into a persisted prefixed id (which would
 * cause PK violations the best-effort audit insert swallows).
 */
export function maxIdSeq(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    // Strip a single leading [A-Za-z]+ prefix; the rest must be all digits.
    const suffix = id.replace(/^[A-Za-z]+/, '');
    if (suffix.length === 0 || !/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}
