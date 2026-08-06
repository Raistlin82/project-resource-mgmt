/**
 * Shared, SSR-safe formatting + scale helpers for the Ledger chart library.
 *
 * Pure functions only — NO DOM, NO measurement, NO platform branching. Every
 * helper is deterministic given its inputs so server render and client render
 * produce byte-identical SVG (no hydration mismatch).
 */

/** Built-in value formatting modes. Adopters can bypass with a `format` fn. */
export type ChartFormatKind = 'number' | 'currency' | 'percent';

/**
 * A value formatter: takes a raw numeric value and returns a display string.
 * Charts accept EITHER a {@link ChartFormatKind} enum + locale/currency, OR a
 * custom function via this signature (the function always wins if provided).
 */
export type ChartFormatFn = (value: number) => string;

/** Options for {@link makeFormatter}. */
export interface ChartFormatOptions {
  /** Built-in formatting kind. Default `'number'`. Ignored if `format` is set. */
  readonly kind?: ChartFormatKind;
  /** BCP-47 locale for Intl.NumberFormat. Default `'en-US'`. */
  readonly locale?: string;
  /** ISO-4217 currency code, used only when `kind === 'currency'`. Default `'USD'`. */
  readonly currency?: string;
  /** Max fraction digits. Defaults: number 0, currency 0, percent 0. */
  readonly maximumFractionDigits?: number;
  /**
   * For `kind: 'percent'`, whether the raw value is already a fraction (0.42)
   * that should be multiplied by 100, or an already-scaled percent (42).
   * `'fraction'` (default) → Intl percent style; `'scaled'` → append "%".
   */
  readonly percentBasis?: 'fraction' | 'scaled';
}

/**
 * Build a deterministic value formatter. A custom `format` function, if given,
 * always takes precedence over `opts`. Safe to call in a `computed()`.
 */
export function makeFormatter(
  format: ChartFormatFn | undefined,
  opts: ChartFormatOptions = {},
): ChartFormatFn {
  if (format) {
    return format;
  }
  const kind = opts.kind ?? 'number';
  const locale = opts.locale ?? 'en-US';

  if (kind === 'currency') {
    const nf = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: opts.currency ?? 'USD',
      maximumFractionDigits: opts.maximumFractionDigits ?? 0,
    });
    return (v: number) => nf.format(v);
  }

  if (kind === 'percent') {
    if ((opts.percentBasis ?? 'fraction') === 'scaled') {
      const nf = new Intl.NumberFormat(locale, {
        maximumFractionDigits: opts.maximumFractionDigits ?? 0,
      });
      return (v: number) => `${nf.format(v)}%`;
    }
    const nf = new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: opts.maximumFractionDigits ?? 0,
    });
    return (v: number) => nf.format(v);
  }

  const nf = new Intl.NumberFormat(locale, {
    maximumFractionDigits: opts.maximumFractionDigits ?? 0,
  });
  return (v: number) => nf.format(v);
}

/**
 * Compute a "nice" axis upper/lower bound and evenly spaced tick values via the
 * classic 1-2-5 nice-number algorithm. Deterministic; no DOM.
 *
 * @param min Data minimum (often 0 for bars).
 * @param max Data maximum.
 * @param tickCount Target number of intervals (ticks ≈ tickCount + 1).
 * @returns `{ niceMin, niceMax, ticks }` — ticks are ascending, inclusive of bounds.
 */
export function niceScale(
  min: number,
  max: number,
  tickCount = 5,
): { niceMin: number; niceMax: number; ticks: number[] } {
  // Degenerate: flat data. Produce a [0, max||1] band so bars/lines still render.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const top = Number.isFinite(max) && max !== 0 ? Math.abs(max) : 1;
    // `min` reaches here non-finite too, and `min < 0` is TRUE for -Infinity — so
    // the old `min < 0 ? min : 0` handed buildTicks a -Infinity floor, spacing
    // came out NaN, and EVERY tick was NaN: the branch that exists to keep the
    // chart renderable was the one destroying the axis. Only a finite negative
    // floor may pass; anything else falls back to the 0 baseline this branch's
    // contract promises.
    const lo = Number.isFinite(min) && min < 0 ? min : 0;
    return buildTicks(lo, lo === 0 ? top : top + lo, tickCount);
  }
  const range = niceNum(max - min, false);
  const spacing = niceNum(range / Math.max(1, tickCount), true);
  const niceMin = Math.floor(min / spacing) * spacing;
  const niceMax = Math.ceil(max / spacing) * spacing;
  return buildTicks(niceMin, niceMax, Math.round((niceMax - niceMin) / spacing));
}

function buildTicks(
  niceMin: number,
  niceMax: number,
  steps: number,
): { niceMin: number; niceMax: number; ticks: number[] } {
  const n = Math.max(1, steps);
  const spacing = (niceMax - niceMin) / n;
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) {
    // Round to kill float noise like 0.30000000000000004.
    ticks.push(round(niceMin + i * spacing));
  }
  return { niceMin, niceMax, ticks };
}

/** Round a number to the 1-2-5 family at its order of magnitude. */
function niceNum(range: number, round_: boolean): number {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = range / Math.pow(10, exp);
  let niceFrac: number;
  if (round_) {
    if (frac < 1.5) niceFrac = 1;
    else if (frac < 3) niceFrac = 2;
    else if (frac < 7) niceFrac = 5;
    else niceFrac = 10;
  } else {
    if (frac <= 1) niceFrac = 1;
    else if (frac <= 2) niceFrac = 2;
    else if (frac <= 5) niceFrac = 5;
    else niceFrac = 10;
  }
  return niceFrac * Math.pow(10, exp);
}

function round(v: number): number {
  return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Resolve a series index (0-based) to a Ledger series CSS variable.
 * Wraps at 7 so any number of series stays themed. Index < 0 → accent.
 */
export function seriesColor(index: number): string {
  if (index < 0) return 'var(--color-accent)';
  return `var(--color-series-${(index % 7) + 1})`;
}
