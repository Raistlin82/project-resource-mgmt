import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CommandTrendChartComponent, type TrendSeries } from './command-trend-chart.component';

/**
 * FIRST spec for the trend chart. Its sibling bar chart got one in the previous
 * batch; this half of the library was still unasserted, and it carried the same
 * class of defect in a different place. The bar chart's non-finite hole was in the
 * DOMAIN (a NaN poisoned the pinned axis); the trend chart's `domain` already
 * skipped non-finite bounds, so the hole hid one layer down in `paths`, where
 * `?? 0` catches null and undefined but not NaN and `yAt(NaN)` put a literal
 * "NaN" into the path `d` — invalid geometry that makes a browser discard the
 * WHOLE path. One unmeasurable week deleted an entire trend line while the axis
 * around it still looked perfectly well-formed.
 *
 * /forecast avoids feeding it a gap by dropping unmeasured weeks up front, so
 * nothing on that screen was red; the exposure is the library contract, which is
 * shared and has other callers.
 */

@Component({
  imports: [CommandTrendChartComponent],
  template: `
    <command-trend-chart
      [categories]="categories()"
      [series]="series()"
      [mode]="mode()"
      [smooth]="smooth()"
      [showDots]="showDots()"
      [zeroBaseline]="zeroBaseline()"
      [format]="format" />
  `,
})
class HostComponent {
  readonly categories = signal<readonly string[]>(['w1', 'w2', 'w3']);
  readonly series = signal<readonly TrendSeries[]>([{ name: 'Utilization', values: [10, 20, 30] }]);
  readonly mode = signal<'line' | 'area'>('line');
  readonly smooth = signal(false);
  readonly showDots = signal(true);
  readonly zeroBaseline = signal(true);
  /** Plain integers, so a fabricated 0 is distinguishable from a real one. */
  readonly format = (v: number): string => String(Math.round(v));
}

function render() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

function linePaths(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('path.ldg-line')).map(p => p.getAttribute('d') ?? '');
}

function areaPaths(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('path.ldg-area')).map(p => p.getAttribute('d') ?? '');
}

function dots(host: HTMLElement): SVGCircleElement[] {
  return Array.from(host.querySelectorAll<SVGCircleElement>('circle.ldg-dot'));
}

/** Value-axis tick labels, DOM order = ascending tick value. */
function axisLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.ldg-axis-val')).map(t => (t.textContent ?? '').trim());
}

/** One row of the screen-reader table, as trimmed cell text. */
function srRow(host: HTMLElement, index: number): string[] {
  const row = host.querySelectorAll('figcaption.ldg-sr tbody tr')[index];
  expect(row, `screen-reader row ${index} must exist`).toBeTruthy();
  return Array.from(row.querySelectorAll('th, td')).map(c => (c.textContent ?? '').trim());
}

/** How many sub-paths the `d` is made of — one `M` per contiguous run. */
function subPathCount(d: string): number {
  return (d.match(/M /g) ?? []).length;
}

describe('CommandTrendChartComponent — a non-finite reading does not erase the series', () => {
  it('keeps the finite points and emits no NaN coordinate when one week is NaN', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [10, Number.NaN, 30] }]);
    fixture.detectChanges();
    const host = el(fixture);

    const [d] = linePaths(host);
    // The defect was total, not partial: the path came out containing "NaN", the
    // browser rejected the whole `d`, and the line vanished. So the assertion is
    // both halves — no NaN anywhere, AND the surviving geometry is really there.
    expect(d).not.toContain('NaN');
    expect(d.length).toBeGreaterThan(0);
    // The two finite weeks still plot, and the gap week does not.
    expect(dots(host).length).toBe(2);
    expect(dots(host).map(c => c.querySelector('title')?.textContent?.trim())).toEqual([
      'Utilization · w1: 10',
      'Utilization · w3: 30',
    ]);
  });

  it('BREAKS the line at the gap instead of joining across it', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [10, Number.NaN, 30] }]);
    fixture.detectChanges();
    // Two runs → two sub-paths. A single sub-path would mean w1 was joined
    // straight to w3, drawing a segment through a value the data never reported —
    // the same fabrication as plotting the gap as 0.
    expect(subPathCount(linePaths(el(fixture))[0])).toBe(2);
  });

  it('emits ONE sub-path for an all-finite series — the break is caused by the gap, not always drawn', () => {
    // The absence twin of the test above. Without it, a `paths` that emitted a
    // fresh `M` at every vertex would satisfy "2 sub-paths" and pass while having
    // no gap logic at all.
    expect(subPathCount(linePaths(el(render()))[0])).toBe(1);
  });

  it('treats Infinity and a short series the same way as NaN', () => {
    const fixture = render();
    // ±Infinity from a divide-by-zero, and a series shorter than the axis (the
    // `undefined` case the old `?? 0` turned into a plotted zero).
    fixture.componentInstance.series.set([
      { name: 'A', values: [10, Number.POSITIVE_INFINITY, 30] },
      { name: 'B', values: [10, 20] },
    ]);
    fixture.detectChanges();
    const host = el(fixture);

    for (const d of linePaths(host)) {
      expect(d).not.toContain('NaN');
      expect(d).not.toContain('Infinity');
    }
    // Series A keeps 2 points around the infinite one; B has 2 of 3 categories.
    expect(dots(host).length).toBe(4);
    // And the value axis is not dragged to infinity by the bad datum.
    expect(axisLabels(host).every(l => /^-?\d+$/.test(l))).toBe(true);
  });

  it('survives a gap in smooth mode, where the Bézier control points also read neighbours', () => {
    const fixture = render();
    fixture.componentInstance.smooth.set(true);
    fixture.componentInstance.categories.set(['w1', 'w2', 'w3', 'w4', 'w5']);
    fixture.componentInstance.series.set([{ name: 'U', values: [10, 20, Number.NaN, 40, 50] }]);
    fixture.detectChanges();
    const d = linePaths(el(fixture))[0];
    expect(d).not.toContain('NaN');
    // Each side of the gap is its own run, so no control point spans it.
    expect(subPathCount(d)).toBe(2);
  });

  it('closes each area run to the baseline separately, and draws no area in line mode', () => {
    const fixture = render();
    fixture.componentInstance.mode.set('area');
    fixture.componentInstance.series.set([{ name: 'U', values: [10, Number.NaN, 30] }]);
    fixture.detectChanges();
    const [area] = areaPaths(el(fixture));
    expect(area).not.toContain('NaN');
    // Two closed sub-areas: an area spanning the gap would shade a region under a
    // reading that does not exist.
    expect(subPathCount(area)).toBe(2);
    expect((area.match(/Z/g) ?? []).length).toBe(2);

    // Absence twin: line mode must emit no area element at all, so the assertion
    // above cannot pass by the area path being unconditionally present.
    fixture.componentInstance.mode.set('line');
    fixture.detectChanges();
    expect(areaPaths(el(fixture))).toEqual([]);
  });
});

describe('CommandTrendChartComponent — the screen-reader table reports a gap as a gap', () => {
  it('renders "n/a" for a non-finite reading, never a fabricated 0', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [10, Number.NaN, 30] }]);
    fixture.detectChanges();
    const host = el(fixture);

    expect(srRow(host, 1)).toEqual(['w2', 'n/a']);
    // Absence: the cell must not read "0". Asserted explicitly because "n/a" is
    // the whole point — a screen-reader user has no plot to cross-check against,
    // so a fabricated zero is invisible to them in a way it is not to a sighted
    // user, who at least sees no dot there.
    expect(srRow(host, 1)).not.toContain('0');
  });

  it('still reports a REAL zero as 0 — the paired positive', () => {
    // Without this, "map every gap to n/a" and "map every zero to n/a" pass the
    // same test, and the fix would have deleted a legitimate reading.
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [10, 0, 30] }]);
    fixture.detectChanges();
    const host = el(fixture);

    expect(srRow(host, 1)).toEqual(['w2', '0']);
    expect(srRow(host, 1)).not.toContain('n/a');
    // A real 0 is a plotted point, so it keeps its dot; the gap above did not.
    expect(dots(host).length).toBe(3);
  });
});

describe('CommandTrendChartComponent — the value axis', () => {
  it('spans the data and stays on finite, noise-free tick labels', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'U', values: [10, 20, 62] }]);
    fixture.detectChanges();
    const labels = axisLabels(el(fixture));

    expect(labels.length).toBeGreaterThan(1);
    expect(labels.every(l => /^-?\d+$/.test(l))).toBe(true);
    // The top tick must cover the peak, or the peak is drawn outside the plot.
    expect(Number(labels.at(-1))).toBeGreaterThanOrEqual(62);
  });

  it('pulls the floor to zero for all-positive data so a trend is not visually amplified', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'U', values: [95, 97, 99] }]);
    fixture.detectChanges();
    // zeroBaseline exists so 95→99 does not read as a fourfold climb on a
    // 95..99 axis. Asserted on the rendered bottom tick, not on the input.
    expect(Number(axisLabels(el(fixture))[0])).toBe(0);
  });

  it('keeps a negative floor for signed data even with zeroBaseline on — the case that must still be ALLOWED', () => {
    // The guard-that-always-refuses trap: a zeroBaseline that clamped the floor
    // to 0 unconditionally would pass the test above and silently clip every
    // negative reading off the bottom of the plot.
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Gap', values: [-40, 10, 30] }]);
    fixture.detectChanges();
    const labels = axisLabels(el(fixture));
    expect(Number(labels[0])).toBeLessThanOrEqual(-40);
  });

  it('falls back to a renderable band when every reading is non-finite', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'U', values: [Number.NaN, Number.NaN, Number.NaN] }]);
    fixture.detectChanges();
    const host = el(fixture);

    // No plottable point, but the axis must still exist rather than collapse to
    // NaN gridlines — an empty plot reads as "no data", NaN gridlines read as a
    // broken page.
    expect(axisLabels(host).every(l => /^-?\d+(\.\d+)?$/.test(l))).toBe(true);
    expect(dots(host)).toEqual([]);
    expect(linePaths(host)).toEqual(['']);
  });
});

describe('CommandTrendChartComponent — axis labels and legend', () => {
  it('thins the category axis but always keeps the last period', () => {
    const fixture = render();
    const cats = Array.from({ length: 26 }, (_, i) => `w${i + 1}`);
    fixture.componentInstance.categories.set(cats);
    fixture.componentInstance.series.set([{ name: 'U', values: cats.map((_, i) => i) }]);
    fixture.detectChanges();
    const host = el(fixture);
    const shown = Array.from(host.querySelectorAll('.ldg-cat')).map(t => (t.textContent ?? '').trim());

    // Thinned (a 26-week horizon must not print 26 overlapping labels)...
    expect(shown.length).toBeLessThanOrEqual(9);
    // ...but the horizon's end is the label a reader needs most, so it is kept
    // regardless of where the stride lands.
    expect(shown.at(-1)).toBe('w26');
    expect(shown[0]).toBe('w1');
  });

  it('names every series in the legend once there is more than one, and omits it for a single series', () => {
    const fixture = render();
    fixture.componentInstance.series.set([
      { name: 'Utilization', values: [10, 20, 30] },
      { name: 'Capacity', values: [100, 100, 100] },
    ]);
    fixture.detectChanges();
    const host = el(fixture);
    expect(Array.from(host.querySelectorAll('.ldg-legend li')).map(li => (li.textContent ?? '').trim()))
      .toEqual(['Utilization', 'Capacity']);

    // Absence twin: one series needs no legend (the aria-label already names it),
    // so a legend that always rendered would fail here.
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [10, 20, 30] }]);
    fixture.detectChanges();
    expect(el(fixture).querySelectorAll('.ldg-legend li').length).toBe(0);
  });

  it('gives the screen-reader table one column per series and one row per category', () => {
    const fixture = render();
    fixture.componentInstance.series.set([
      { name: 'Utilization', values: [10, 20, 30] },
      { name: 'Capacity', values: [100, 100, 100] },
    ]);
    fixture.detectChanges();
    const host = el(fixture);

    expect(Array.from(host.querySelectorAll('figcaption.ldg-sr thead th')).map(t => t.textContent?.trim()))
      .toEqual(['Period', 'Utilization', 'Capacity']);
    expect(host.querySelectorAll('figcaption.ldg-sr tbody tr').length).toBe(3);
    expect(srRow(host, 2)).toEqual(['w3', '30', '100']);
  });
});
