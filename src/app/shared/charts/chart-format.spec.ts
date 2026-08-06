import { describe, expect, it } from 'vitest';
import { makeFormatter, niceScale, seriesColor } from './chart-format';

/**
 * FIRST spec for chart-format.ts — the pure layer under the whole chart library.
 * Every axis bound, tick label and series colour in the app is produced here, and
 * none of it carried an assertion: the bar-chart spec added alongside it pins the
 * component that CONSUMES these functions, but not the arithmetic itself, so a
 * "simplification" of niceScale or of the percent-basis branch would move every
 * number on /reporting, /forecast and /dashboard with nothing turning red.
 */

describe('niceScale — the 1-2-5 axis arithmetic every chart axis rests on', () => {
  it('rounds an unpinned 0..62 domain up to 80 in steps of 20', () => {
    // The exact case /reporting's utilization chart hits when the busiest
    // resource is at 62%: without the component's pinned-maxValue branch the
    // axis tops out at 80, so a 62% bar fills 78% of the plot and reads as
    // near-capacity. Spacing is niceNum(100/5)=20, so ceil(62/20)*20 = 80.
    expect(niceScale(0, 62, 5)).toEqual({ niceMin: 0, niceMax: 80, ticks: [0, 20, 40, 60, 80] });
  });

  it('leaves an already-nice 0..100 domain exactly at 100 without inventing headroom', () => {
    expect(niceScale(0, 100, 5)).toEqual({
      niceMin: 0,
      niceMax: 100,
      ticks: [0, 20, 40, 60, 80, 100],
    });
  });

  it('gives flat data a band to render in rather than a zero-height axis', () => {
    // min === max is the degenerate branch: a chart of five identical weeks must
    // still have a plot to draw in, or every bar is 0px tall.
    const flat = niceScale(40, 40, 5);
    expect(flat.niceMax).toBeGreaterThan(flat.niceMin);
    expect(flat.ticks.length).toBeGreaterThan(1);
  });

  it('absorbs non-finite bounds instead of emitting NaN ticks', () => {
    // The assertion of ABSENCE that matters for the whole library: a NaN bound
    // must not reach the tick list, because a NaN tick renders as the string
    // "NaN" on the axis and the gridline gets y="NaN" — an invalid coordinate
    // that removes the line. This is niceScale's degenerate branch doing the
    // absorbing; the CONSUMERS additionally guard their own accumulators.
    for (const scale of [niceScale(0, Number.NaN, 5), niceScale(Number.NEGATIVE_INFINITY, 10, 5)]) {
      expect(scale.ticks.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(scale.niceMin)).toBe(true);
      expect(Number.isFinite(scale.niceMax)).toBe(true);
    }
  });

  it('keeps a negative floor for signed data instead of clamping the axis at zero', () => {
    // /forecast's Gap column goes negative on over-capacity weeks, which is the
    // whole reason the export exists. The axis has to descend below zero or those
    // are the bars that get clipped.
    const signed = niceScale(-196.5, 320, 5);
    expect(signed.niceMin).toBeLessThan(0);
    expect(signed.niceMin).toBeLessThanOrEqual(-196.5);
    expect(signed.niceMax).toBeGreaterThanOrEqual(320);
    expect(signed.ticks[0]).toBe(signed.niceMin);
    expect(signed.ticks[signed.ticks.length - 1]).toBe(signed.niceMax);
  });

  it('emits ticks free of float noise, ascending, and spanning exactly the bounds', () => {
    // buildTicks rounds at 1e6 precisely to kill 0.30000000000000004-shaped
    // labels. Asserting the STRING is what pins that: 0.30000000000000004 is
    // toBeCloseTo(0.3) and would slip through a numeric tolerance.
    const { ticks, niceMin, niceMax } = niceScale(0, 1, 5);
    expect(ticks.map(String)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1']);
    expect(ticks[0]).toBe(niceMin);
    expect(ticks[ticks.length - 1]).toBe(niceMax);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });
});

describe('makeFormatter — the tick and tooltip labels', () => {
  it('lets an explicit format function win over every option', () => {
    // The precedence the call sites depend on: reporting.ts passes its own
    // scaled-percent function and must not have `kind` applied on top of it.
    const fn = makeFormatter((v) => `<${v}>`, { kind: 'currency', currency: 'EUR' });
    expect(fn(42)).toBe('<42>');
  });

  it('distinguishes a fraction basis from an already-scaled percent — 0.42 vs 42', () => {
    // Both branches are reachable from real call sites (the trend chart feeds
    // fractions, the bar chart feeds scaled percents), and getting the basis
    // wrong is a silent 100x: the pair is asserted together so neither branch
    // can be collapsed into the other.
    const fraction = makeFormatter(undefined, { kind: 'percent' });
    const scaled = makeFormatter(undefined, { kind: 'percent', percentBasis: 'scaled' });
    expect(fraction(0.42)).toBe('42%');
    expect(scaled(42)).toBe('42%');
    // The absence twin: neither formatter may agree with the other's input, or
    // the basis is not actually being honoured.
    expect(fraction(42)).not.toBe('42%');
    expect(scaled(0.42)).not.toBe('42%');
  });

  it('honours maximumFractionDigits on the percent branches', () => {
    // The project's 2-decimal rule reaches chart labels too, so the knob that
    // enforces it has to work on both percent bases.
    expect(makeFormatter(undefined, { kind: 'percent', maximumFractionDigits: 2 })(0.4267)).toBe(
      '42.67%',
    );
    expect(
      makeFormatter(undefined, {
        kind: 'percent',
        percentBasis: 'scaled',
        maximumFractionDigits: 2,
      })(42.6712),
    ).toBe('42.67%');
  });

  it('rounds a raw float to whole units by default rather than printing 14 decimals', () => {
    // A chart label is on-screen output, so the same rule as the CSV exports:
    // 83.48936835522201 must never reach an axis.
    expect(makeFormatter(undefined, {})(83.48936835522201)).toBe('83');
    expect(makeFormatter(undefined, { kind: 'number' })(83.48936835522201)).not.toMatch(/\.\d{3,}/);
  });

  it('formats currency in the requested ISO code, not a hardcoded default', () => {
    const eur = makeFormatter(undefined, { kind: 'currency', currency: 'EUR', locale: 'en-US' });
    expect(eur(1200)).toContain('1,200');
    expect(eur(1200)).toMatch(/€/);
    // Absence: the USD default must not leak through when a code is supplied.
    expect(eur(1200)).not.toContain('$');
  });
});

describe('seriesColor — the themed palette assignment', () => {
  it('maps index 0..6 onto the seven distinct series tokens', () => {
    const first7 = [0, 1, 2, 3, 4, 5, 6].map(seriesColor);
    expect(first7).toEqual([
      'var(--color-series-1)',
      'var(--color-series-2)',
      'var(--color-series-3)',
      'var(--color-series-4)',
      'var(--color-series-5)',
      'var(--color-series-6)',
      'var(--color-series-7)',
    ]);
    // Absence of a collision: seven series must never share a swatch, since the
    // legend swatch is the only thing identifying a line.
    expect(new Set(first7).size).toBe(7);
  });

  it('wraps at 7 so an eighth series is still themed, and sends a negative index to accent', () => {
    expect(seriesColor(7)).toBe('var(--color-series-1)');
    expect(seriesColor(13)).toBe('var(--color-series-7)');
    expect(seriesColor(-1)).toBe('var(--color-accent)');
  });
});
