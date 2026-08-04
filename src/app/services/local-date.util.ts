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
