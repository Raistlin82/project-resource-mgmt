/**
 * The month window `GET /bench/history/:resourceId` derives, and the validation of
 * the one query parameter it accepts. PURE: no clock, no I/O — the anchor month is
 * always supplied by the caller, like `benchRollup`'s `today`.
 *
 * This lives here, and not inline in `src/server.ts`, because `src/server.ts`
 * instantiates the SSR engine on import and so cannot be loaded by Vitest: every
 * pure rule the API enforces has to be extracted to be testable at all. The
 * existing `/bench/monthly` window arithmetic is still inline and therefore still
 * untested — that is the gap this file deliberately does not repeat.
 *
 * WHY A SEPARATE ENDPOINT INSTEAD OF WIDENING `/bench/monthly`
 *
 * `/bench/monthly`'s 6-month window is fixed by design spec §8 and is read by four
 * screens; the staffing candidate card renders exactly one dot per month of it and
 * labels the window in its legend, so lengthening the shared window silently turns
 * a 6-dot traffic light into an N-dot one. The history is also a different QUESTION:
 * it looks BACKWARD from the present, while `/bench/monthly` looks forward from an
 * `Open` planning period — different anchor, different direction, not one window
 * with a different length. And it is an on-demand detail of ONE row, so putting it
 * in the shared grid would multiply rows × months of payload for every consumer to
 * serve something opened one resource at a time.
 */

/** Months of history returned when the caller does not ask for a specific count. */
export const BENCH_HISTORY_DEFAULT_MONTHS = 12;

/**
 * Hard ceiling on the months a single request may ask for. Bounds the work per
 * request (the handler reads every assignment day in the process) the same way
 * `GET /audit-logs` bounds its page. Two years is past the point where a
 * disallocation trend is still actionable.
 */
export const BENCH_HISTORY_MAX_MONTHS = 24;

export type HistoryMonthsResult =
  | { ok: true; months: number }
  | { ok: false; error: string };

/**
 * Validates the `months` query parameter: absent means {@link BENCH_HISTORY_DEFAULT_MONTHS}.
 *
 * Out-of-range and non-numeric values are REFUSED rather than clamped. Silently
 * clamping a request for 60 months down to 24 would answer a question the caller
 * did not ask while looking exactly like a full answer — the reader would read a
 * 2-year history as a 5-year one. A 400 says which bound was crossed.
 */
export function parseHistoryMonths(raw: string | undefined): HistoryMonthsResult {
  if (raw === undefined || raw === '') return { ok: true, months: BENCH_HISTORY_DEFAULT_MONTHS };
  // Reject anything Number() would coerce loosely ('12abc' -> NaN is fine, but
  // ' 12 ', '1e1', '12.0' and '+12' all coerce to a number and must not sneak in
  // as a month count) — an integer literal only.
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'months must be a whole number' };
  const months = Number(raw);
  if (months < 1 || months > BENCH_HISTORY_MAX_MONTHS) {
    return { ok: false, error: `months must be between 1 and ${BENCH_HISTORY_MAX_MONTHS}` };
  }
  return { ok: true, months };
}

export interface BenchHistoryWindow {
  /** The months to RETURN, oldest-first: `monthCount` months ENDING at the anchor. */
  displayMonths: string[];
  /**
   * The wider window to FETCH: 2 extra months of look-back and 1 of look-ahead
   * around `displayMonths`, exactly as `/bench/monthly` builds its own. The
   * look-back is what makes the OLDEST displayed month's aging bucket truthful
   * (`monthsIdleAt` walks back up to 3 months); without it the first month of
   * every history would read as bucket B — "idle one month" — no matter how long
   * the person had already been idle.
   */
  months: string[];
}

const monthToIdx = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return y * 12 + (m - 1);
};
const idxToMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/**
 * `monthCount` months of history ending AT (and including) `anchorMonth`.
 *
 * The anchor is the CURRENT month at every call site: a history that stops before
 * now is not a history. It is a parameter rather than read from the clock here so
 * the arithmetic is testable, and so this file has no notion of "now" to get wrong
 * across time zones (the caller owes it a local-calendar month).
 */
export function benchHistoryWindow(anchorMonth: string, monthCount: number): BenchHistoryWindow {
  const anchor = monthToIdx(anchorMonth);
  const first = anchor - (monthCount - 1);
  const displayMonths: string[] = [];
  for (let i = first; i <= anchor; i++) displayMonths.push(idxToMonth(i));
  const months: string[] = [];
  for (let i = first - 2; i <= anchor + 1; i++) months.push(idxToMonth(i));
  return { displayMonths, months };
}
