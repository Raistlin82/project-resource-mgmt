import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CommandBarChartComponent, type BarSeries } from './command-bar-chart.component';
import { niceScale } from './chart-format';

/**
 * FIRST spec for the Ledger chart library. Every number and axis the app renders
 * — /reporting's utilization and margin bars, /forecast's supply-vs-demand
 * columns, /dashboard's revenue bars — is produced here and none of it carried
 * an assertion of any kind. The branches pinned below are the ones a cleanup
 * would plausibly delete: the pinned-domain branch that makes a utilization bar
 * read as a percentage of CAPACITY rather than of the busiest resource, and the
 * overlay's contribution to the y-domain that keeps a supply line on the plot.
 */

/** Mirrors reporting.ts's own scaled-percent formatter, the real call site. */
const pctFormat = (v: number): string => `${Math.round(v)}%`;

@Component({
  imports: [CommandBarChartComponent],
  template: `
    <command-bar-chart
      [categories]="categories()"
      [series]="series()"
      [maxValue]="maxValue()"
      [stacked]="stacked()"
      [overlay]="overlay()"
      [height]="height()"
      [format]="format" />
  `,
})
class HostComponent {
  readonly categories = signal<readonly string[]>(['A']);
  readonly series = signal<readonly BarSeries[]>([{ name: 'Utilization', values: [62] }]);
  readonly maxValue = signal<number | undefined>(100);
  readonly stacked = signal(false);
  readonly overlay = signal<BarSeries | undefined>(undefined);
  readonly height = signal(300);
  readonly format = pctFormat;
}

function render() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

/** Value-axis tick labels in DOM order, which is ascending tick value. */
function axisLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.ldg-axis-val')).map(t => (t.textContent ?? '').trim());
}

/** The numeric top of the value axis, read back off its own last tick label. */
function axisTop(host: HTMLElement): number {
  const labels = axisLabels(host);
  expect(labels.length, 'the value axis must render tick labels').toBeGreaterThan(1);
  return Number((labels.at(-1) ?? '').replace('%', ''));
}

/**
 * Plot height in viewBox units, measured from the gridlines themselves (the zero
 * line and the top tick) rather than restated from the component's viewBox
 * constants — so the ratios below measure what actually shipped.
 */
function plotHeight(host: HTMLElement): number {
  const ys = Array.from(host.querySelectorAll('.ldg-grid line')).map(l => Number(l.getAttribute('y1')));
  expect(ys.length, 'the value axis must render gridlines').toBeGreaterThan(1);
  return Math.max(...ys) - Math.min(...ys);
}

function bars(host: HTMLElement): SVGRectElement[] {
  return Array.from(host.querySelectorAll<SVGRectElement>('rect.ldg-bar'));
}

function onlyBarHeight(host: HTMLElement): number {
  const rects = bars(host);
  expect(rects.length, 'the single-series single-category chart must render exactly one bar').toBe(1);
  return Number(rects[0].getAttribute('height'));
}

describe('CommandBarChartComponent — the pinned value-axis domain', () => {
  afterEach(() => TestBed.resetTestingModule());

  /*
   * The pin and its ABSENCE are asserted in ONE test on purpose. Either half
   * alone is a blind gate: a pinned-only check would pass against a niceScale
   * that happened to round to 100 for this dataset, and an unpinned-only check
   * says nothing about the branch. The pair is what proves the pinned branch is
   * what produces the absolute scale.
   */
  it('ends the axis exactly at maxValue (62 of 100), and re-normalises to 80 when the pin is removed', () => {
    const fixture = render();
    const host = el(fixture);

    // --- pinned: [maxValue]=100 --------------------------------------------
    const pinned = axisLabels(host);
    expect(pinned).toEqual(['0%', '20%', '40%', '60%', '80%', '100%']);
    // Exact equality on the top label, never toContain: '0%' is a substring of
    // '100%', so a substring check could not tell these two axes apart at all.
    expect(pinned.at(-1)).toBe('100%');
    // The bar fills 62% of the plot — the whole point of the pin.
    expect(onlyBarHeight(host) / plotHeight(host)).toBeCloseTo(0.62, 4);

    // --- the same data with the pin REMOVED --------------------------------
    fixture.componentInstance.maxValue.set(undefined);
    fixture.detectChanges();

    const unpinned = axisLabels(host);
    expect(unpinned.at(-1)).toBe('80%');
    expect(unpinned).not.toContain('100%');
    // 62/80: the bar reads as nearly full against a near-capacity ceiling, which
    // is exactly the misreading the pinned branch exists to prevent.
    expect(onlyBarHeight(host) / plotHeight(host)).toBeCloseTo(0.775, 4);
  });

  it('never clips data above the pin: a 130% bar keeps a domain top of at least 130', () => {
    const fixture = render();
    fixture.componentInstance.series.set([{ name: 'Utilization', values: [130] }]);
    fixture.detectChanges();
    const host = el(fixture);

    // `top = Math.max(pinned, max)`. Drop that Math.max and the axis stops at
    // 100 while the bar is mapped past it — an over-allocated resource then
    // renders as merely at-capacity.
    const top = axisTop(host);
    expect(top).toBeGreaterThanOrEqual(130);
    // Absence twin: the pinned 0..100 axis must NOT be the one in use here.
    expect(axisLabels(host).at(-1)).not.toBe('100%');
    // And the bar still fills the plot exactly once — not more.
    expect(onlyBarHeight(host) / plotHeight(host)).toBeCloseTo(130 / top, 4);
  });

  it('keeps the pinned axis and the bar geometry intact when a series carries NaN or Infinity', () => {
    const fixture = render();
    // A 0/0 ratio, or a JSON null coerced by a caller's `map`, arrives here as a
    // non-finite number. Unguarded, Math.max(0, NaN) is NaN, the pinned branch
    // computes top = Math.max(100, NaN) = NaN, spacing becomes NaN and EVERY
    // tick is NaN — the entire value axis disappears, not one bar.
    fixture.componentInstance.series.set([
      { name: 'Utilization', values: [Number.NaN] },
      { name: 'Target', values: [Number.POSITIVE_INFINITY] },
      { name: 'Real', values: [40] },
    ]);
    fixture.detectChanges();
    const host = el(fixture);

    expect(axisLabels(host)).toEqual(['0%', '20%', '40%', '60%', '80%', '100%']);
    // Stated separately because it is the symptom a reader would recognise on
    // screen, and because an axis of the right LENGTH full of NaN would satisfy
    // a length-only check.
    expect(axisLabels(host).some(l => l.includes('NaN'))).toBe(false);

    // Absence twin on the geometry: no rect may carry a NaN coordinate. This is
    // the half that a domain-only guard leaves red.
    const geometry = bars(host).flatMap(r =>
      ['x', 'y', 'width', 'height'].map(a => r.getAttribute(a) ?? ''),
    );
    expect(geometry.filter(v => !Number.isFinite(Number(v)))).toEqual([]);
    // …and the one finite datum still renders, so "skip non-finite" did not
    // degenerate into "render nothing".
    expect(bars(host)).toHaveLength(1);
    expect(Number(bars(host)[0].getAttribute('height')) / plotHeight(host)).toBeCloseTo(0.4, 4);
  });
});

describe('niceScale — the arithmetic the pinned/unpinned comparison rests on', () => {
  it('rounds an unpinned 0..62 domain up to 80 in steps of 20', () => {
    // range = niceNum(62) = 100, spacing = niceNum(100/5) = 20, ceil(62/20)*20 = 80.
    expect(niceScale(0, 62, 5)).toEqual({ niceMin: 0, niceMax: 80, ticks: [0, 20, 40, 60, 80] });
  });

  it('leaves an already-nice 0..100 domain exactly at 100', () => {
    // The absence twin for the row above: without it, "niceScale rounds up" is
    // indistinguishable from "niceScale always returns 80".
    expect(niceScale(0, 100, 5)).toEqual({ niceMin: 0, niceMax: 100, ticks: [0, 20, 40, 60, 80, 100] });
  });

  it('gives a flat all-equal series a band to render in instead of a zero-height axis', () => {
    const { niceMin, niceMax } = niceScale(7, 7, 5);
    expect(niceMax).toBeGreaterThan(niceMin);
  });
});

describe('CommandBarChartComponent — the supply overlay over a demand stack', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** /forecast's real shape: committed + pipeline stacked, supply as the line. */
  function forecastShape(supply: number) {
    const fixture = render();
    fixture.componentInstance.maxValue.set(undefined);
    fixture.componentInstance.categories.set(['W1']);
    fixture.componentInstance.stacked.set(true);
    fixture.componentInstance.series.set([
      { name: 'Committed', values: [100] },
      { name: 'Pipeline', values: [100] },
    ]);
    fixture.componentInstance.overlay.set({ name: 'Supply', values: [supply] });
    fixture.detectChanges();
    return fixture;
  }

  /*
   * The DOMAIN assertion, not the element-presence one, is the load-bearing
   * half: an overlay that renders but is excluded from the y-domain draws a line
   * pinned at the top gridline, so the chart understates capacity while looking
   * perfectly well-formed. Presence alone would pass in exactly that state.
   */
  it('raises the value-axis top to cover a supply above the stack, so the line is not clipped', () => {
    const host = el(forecastShape(320));

    // Stack total is 200; supply is 320. niceScale(0,320,5) -> top 400.
    const top = axisTop(host);
    expect(top).toBeGreaterThanOrEqual(320);

    const line = host.querySelector('polyline.ldg-overlay');
    expect(line, 'the overlay must render as a polyline').not.toBeNull();

    // Every overlay y must sit INSIDE the plot band, which is the geometric
    // statement of "not clipped". Measured against the gridlines, not constants.
    const gridY = Array.from(host.querySelectorAll('.ldg-grid line')).map(l => Number(l.getAttribute('y1')));
    const ys = (line!.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map(p => Number(p.split(',')[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(...gridY));
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(...gridY));
    // Strictly BELOW the top gridline, i.e. 320 < 400 — this is what fails when
    // the overlay is left out of the domain (it would sit exactly on it).
    expect(Math.min(...ys)).toBeGreaterThan(Math.min(...gridY));
  });

  it('is not stacked onto the demand: the bars still total 200, and the overlay is no bar of its own', () => {
    const host = el(forecastShape(320));

    // Absence assertion: `stacked` stacks EVERY entry of `series`, so a supply
    // left in that list would be added on top of the demand it is meant to be
    // compared with. Exactly two rects, and no rect titled Supply.
    const rects = bars(host);
    expect(rects).toHaveLength(2);
    const titles = rects.map(r => r.querySelector('title')?.textContent ?? '');
    expect(titles.some(t => t.includes('Supply'))).toBe(false);

    // The stack still measures its own 200 against the 400 axis (heights sum to
    // half the plot), so admitting the overlay to the domain did not silently
    // rescale the bars relative to each other.
    const total = rects.reduce((sum, r) => sum + Number(r.getAttribute('height')), 0);
    expect(total / plotHeight(host)).toBeCloseTo(200 / axisTop(host), 4);
  });

  it('names the overlay in the legend and gives it a column in the screen-reader table', () => {
    const host = el(forecastShape(320));

    const legend = Array.from(host.querySelectorAll('.ldg-legend li')).map(li => (li.textContent ?? '').trim());
    expect(legend).toEqual(['Committed', 'Pipeline', 'Supply']);

    // The line is the only carrier of the capacity figure, so leaving it out of
    // the a11y table would make it sighted-only information.
    const headers = Array.from(host.querySelectorAll('.ldg-sr thead th')).map(th => (th.textContent ?? '').trim());
    expect(headers).toEqual(['Category', 'Committed', 'Pipeline', 'Supply']);
    const cells = Array.from(host.querySelectorAll('.ldg-sr tbody td')).map(td => (td.textContent ?? '').trim());
    expect(cells).toEqual(['100%', '100%', '320%']);
  });

  it('renders no overlay at all when none is supplied', () => {
    // The absence twin for every assertion above: the element must be driven by
    // the input, not simply always present.
    const host = el(render());
    expect(host.querySelector('polyline.ldg-overlay')).toBeNull();
    // …and with a single series and no overlay there is nothing to key, so the
    // legend stays off (it would otherwise label a one-series chart).
    expect(host.querySelector('.ldg-legend')).toBeNull();
  });
});

describe('CommandBarChartComponent — the rendered height', () => {
  afterEach(() => TestBed.resetTestingModule());

  const SRC = readFileSync(
    resolve(process.cwd(), 'src/app/shared/charts/command-bar-chart.component.ts'),
    'utf8',
  );

  /*
   * jsdom performs NO layout and does not apply a component's `styles` metadata,
   * so NOTHING here can prove the rendered box is 300px tall — this is a
   * source-level assertion and is labelled as one. What it does prove is the
   * thing that was actually broken: the custom property the template writes was
   * read by no rule at all, so all five [height] call sites were discarded.
   * Both names are extracted from the source, so a rename on either side fails.
   */
  it('reads the same custom property it writes (static source assertion — jsdom lays nothing out)', () => {
    const written = /\[style\.(--[\w-]+)\.px\]="height\(\)"/.exec(SRC);
    expect(written, 'the chart root must write height() into a custom property').not.toBeNull();

    const styles = SRC.slice(SRC.indexOf('styles: `'), SRC.indexOf('export class'));
    const consumed = /(?:^|[^-\w])(?:max-)?height:\s*var\((--[\w-]+)/.exec(styles);
    expect(
      consumed,
      'the component stylesheet must READ that property — unread, every [height] is discarded',
    ).not.toBeNull();
    expect(consumed![1]).toBe(written![1]);

    // Vacuity control: the same slice must contain a declaration that was
    // already there, proving the extraction really covers the style block.
    expect(styles).toMatch(/\.ldg-svg \{/);
    // The absolutely-positioned sr caption needs the figure as its containing
    // block once the figure is the sizing box.
    expect(styles).toMatch(/position:\s*relative/);
  });

  it('carries the host-supplied height on the chart root at runtime', () => {
    const fixture = render();
    const figure = el(fixture).querySelector('figure.ldg-chart') as HTMLElement;
    expect(figure.style.getPropertyValue('--ldg-h')).toBe('300px');

    // The absence twin: the property must TRACK the input, not be a constant.
    fixture.componentInstance.height.set(200);
    fixture.detectChanges();
    expect(figure.style.getPropertyValue('--ldg-h')).toBe('200px');
  });
});
