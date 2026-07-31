/** Pure, SSR-safe calendar helpers for time-phased allocation. Dates are ISO
 *  'YYYY-MM-DD' strings; no Date.now()/argless new Date() (parity with schedule.util).
 *  Callers must pass valid ISO strings ('YYYY-MM' / 'YYYY-MM-DD'); malformed input
 *  degrades to `[]`/`{}` rather than throwing — validation is the caller's
 *  responsibility (e.g. the server endpoint). */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → 'YYYY-MM'. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** UTC day-of-week 0=Sun..6=Sat via `new Date(...Z)` (deterministic UTC). */
function dow(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

/** YYYY-MM-DD for a UTC epoch-ms instant; stable across time zones. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True iff `date` is a weekday and not in `holidays`. */
export function isWorkingDay(date: string, holidays: ReadonlySet<string>): boolean {
  const d = dow(date);
  return d !== 0 && d !== 6 && !holidays.has(date);
}

/** All working-day dates of `month` ('YYYY-MM'), ascending. */
export function workingDaysInMonth(month: string, holidays: ReadonlySet<string>): string[] {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
  const out: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${month}-${String(day).padStart(2, '0')}`;
    if (isWorkingDay(iso, holidays)) out.push(iso);
  }
  return out;
}

/** Target hours for a resource in a month = working days × contract hours/day. */
export function monthlyTargetHours(contractHoursPerDay: number, month: string, holidays: ReadonlySet<string>): number {
  return workingDaysInMonth(month, holidays).length * contractHoursPerDay;
}

/** Spread `total` hours evenly across the working days in [start,end] (inclusive),
 *  preserving the total (last day absorbs the rounding remainder). Empty if none. */
export function distributeHoursOverWindow(
  total: number,
  start: string,
  end: string,
  holidays: ReadonlySet<string>,
): Record<string, number> {
  const days: string[] = [];
  const endMs = Date.parse(end + 'T00:00:00Z');
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= endMs; t += MS_PER_DAY) {
    const iso = toIsoDate(t);
    if (isWorkingDay(iso, holidays)) days.push(iso);
  }
  // Guard rejects 0 / negative / NaN totals — nothing to distribute.
  if (days.length === 0 || !(total > 0)) return {};
  const per = Math.round((total / days.length) * 100) / 100;
  const map: Record<string, number> = {};
  let acc = 0;
  days.forEach((d, i) => {
    const h = i === days.length - 1 ? Math.round((total - acc) * 100) / 100 : per;
    map[d] = h;
    acc += h;
  });
  return map;
}
