/** Format a Date using its local calendar fields, avoiding UTC day rollover. */
export function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local calendar date suitable for date inputs and business-day comparisons. */
export function todayLocalIso(now: () => Date = () => new Date()): string {
  return localIsoDate(now());
}

/**
 * P2-21 — the bridge from "what day is it where the user is" into the UTC date
 * arithmetic the schedule/forecast/finance utils are built on: the UTC-midnight
 * epoch ms of the user's LOCAL civil date.
 *
 * `Date.now()` is NOT that. It carries a time of day, so its UTC calendar date
 * is the user's yesterday at negative offsets late in the day and the user's
 * tomorrow at positive offsets late in the evening. Feeding it into UTC day/week
 * math slips the result by a day — or, once a week boundary is involved, by a
 * whole week. Feed this instead and leave the arithmetic downstream untouched.
 */
export function todayLocalUtcMs(now: () => Date = () => new Date()): number {
  return Date.parse(todayLocalIso(now));
}

/**
 * `count` consecutive calendar months ENDING at `endMonth` ('YYYY-MM'),
 * ascending — the trailing-window helper behind the dashboard's trend chip and
 * recognised-revenue chart.
 *
 * The month walk goes through `Date.UTC`, which normalises the underflow
 * (month -1 becomes December of the previous year) and is deliberately left as
 * UTC arithmetic. Only the ANCHOR has to be the user's civil month, which is why
 * it is a parameter and never read off the clock in here: callers pass
 * `todayLocalIso().slice(0, 7)`.
 */
export function trailingMonths(count: number, endMonth: string): string[] {
  const year = Number(endMonth.slice(0, 4));
  const month = Number(endMonth.slice(5, 7));
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
