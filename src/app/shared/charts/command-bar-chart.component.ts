import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ChartFormatFn,
  ChartFormatKind,
  makeFormatter,
  niceScale,
  seriesColor,
} from './chart-format';

/** One series in a (possibly grouped/stacked) bar chart. */
export interface BarSeries {
  /** Human-readable series name (legend + a11y table header). */
  readonly name: string;
  /** One value per category, index-aligned with {@link CommandBarChartComponent.categories}. */
  readonly values: readonly number[];
  /**
   * Optional explicit color (any CSS color or `var(--color-series-n)`).
   * When omitted, the series gets `--color-series-N` by its index
   * (single-series defaults to `--color-accent`).
   */
  readonly color?: string;
  /**
   * Optional per-datum color override, index-aligned with {@link values}.
   * When present, each bar uses `colors[i]` if it is defined, otherwise falls
   * back to the series {@link color} (or its themed default). Lets a single
   * series tone individual bars (e.g. over-budget bars critical, others
   * positive). Any CSS color or `var(--color-…)` token.
   */
  readonly colors?: readonly (string | undefined)[];
}

type BarOrientation = 'vertical' | 'horizontal';

interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  value: number;
  label: string; // formatted value
  seriesName: string;
  category: string;
  /** label anchor position for the optional value label */
  lx: number;
  ly: number;
  anchor: 'start' | 'middle' | 'end';
}

interface AxisTick {
  value: number;
  label: string;
  /** position along the value axis in px (already mapped) */
  pos: number;
}

/**
 * Ledger bar chart — vertical or horizontal, single / grouped / stacked, with an
 * optional reference {@link CommandBarChartComponent.overlay} line (supply over
 * a demand stack).
 *
 * SSR-safe: every coordinate is derived from inputs + a fixed viewBox; no DOM
 * measurement. Themed purely with design tokens. Use for margin bars, A/R aging
 * buckets, capacity supply vs pipeline, etc.
 *
 * `height` is a BOX height in px, honoured by the figure itself; the drawing
 * keeps its aspect ratio inside that box (`preserveAspectRatio`).
 */
@Component({
  selector: 'command-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="ldg-chart" [style.--ldg-h.px]="height()">
      <svg
        [attr.viewBox]="'0 0 ' + VBW + ' ' + VBH"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        [attr.aria-label]="ariaLabel()"
        class="ldg-svg"
      >
        <!-- gridlines + value-axis ticks -->
        <g class="ldg-grid">
          @for (t of ticks(); track t.value) {
            @if (orientation() === 'vertical') {
              <line
                [attr.x1]="plot().x"
                [attr.x2]="plot().x + plot().w"
                [attr.y1]="t.pos"
                [attr.y2]="t.pos"
              />
              <text
                class="ldg-axis-val"
                [attr.x]="plot().x - 8"
                [attr.y]="t.pos"
                text-anchor="end"
                dominant-baseline="middle"
              >{{ t.label }}</text>
            } @else {
              <line
                [attr.x1]="t.pos"
                [attr.x2]="t.pos"
                [attr.y1]="plot().y"
                [attr.y2]="plot().y + plot().h"
              />
              <text
                class="ldg-axis-val"
                [attr.x]="t.pos"
                [attr.y]="plot().y + plot().h + 16"
                text-anchor="middle"
              >{{ t.label }}</text>
            }
          }
        </g>

        <!-- baseline (zero) axis -->
        <line
          class="ldg-axis"
          [attr.x1]="baseline().x1"
          [attr.y1]="baseline().y1"
          [attr.x2]="baseline().x2"
          [attr.y2]="baseline().y2"
        />

        <!-- bars -->
        <g class="ldg-bars">
          @for (b of bars(); track b.seriesName + '|' + b.category) {
            <rect
              class="ldg-bar"
              [attr.x]="b.x"
              [attr.y]="b.y"
              [attr.width]="b.w"
              [attr.height]="b.h"
              [attr.rx]="radius()"
              [attr.fill]="b.color"
            >
              <title>{{ b.seriesName }} · {{ b.category }}: {{ b.label }}</title>
            </rect>
            @if (showValues()) {
              <text
                class="ldg-val"
                [attr.x]="b.lx"
                [attr.y]="b.ly"
                [attr.text-anchor]="b.anchor"
                dominant-baseline="middle"
              >{{ b.label }}</text>
            }
          }
        </g>

        <!-- reference overlay (e.g. supply capacity over a demand stack) -->
        @if (overlayPoints(); as pts) {
          <polyline
            class="ldg-overlay"
            [attr.points]="pts"
            [attr.stroke]="overlayColor()"
            fill="none"
          >
            <title>{{ overlay()?.name }}</title>
          </polyline>
        }

        <!-- category labels -->
        <g class="ldg-cats">
          @for (c of categoryTicks(); track c.label) {
            <text
              class="ldg-cat"
              [attr.x]="c.x"
              [attr.y]="c.y"
              [attr.text-anchor]="orientation() === 'vertical' ? 'middle' : 'end'"
              dominant-baseline="middle"
            >{{ c.label }}</text>
          }
        </g>
      </svg>

      <!-- legend (multi-series, or whenever an overlay needs identifying) -->
      @if (legend().length > 1) {
        <ul class="ldg-legend" aria-hidden="true">
          @for (s of legend(); track s.name) {
            <li>
              <span class="ldg-swatch" [class.is-line]="s.isOverlay" [style.background]="s.color"></span>{{ s.name }}
            </li>
          }
        </ul>
      }

      <!-- a11y fallback table -->
      <figcaption class="ldg-sr">
        {{ ariaLabel() }}
        <table>
          <caption>{{ caption() || 'Bar chart data' }}</caption>
          <thead>
            <tr>
              <th>Category</th>
              @for (s of srSeries(); track s.name) {
                <th>{{ s.name }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of srRows(); track row.category) {
              <tr>
                <th>{{ row.category }}</th>
                @for (cell of row.cells; track $index) {
                  <td>{{ cell }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </figcaption>
    </figure>
  `,
  styles: `
    .ldg-chart {
      margin: 0;
      width: 100%;
      /* The figure OWNS its box height. --ldg-h (written by the [style] binding
         from height()) used to be read by nothing at all, so the fixed 720x360
         viewBox alone decided the box and every [height] call site — 200, 256,
         300, 300, 320 — was silently discarded.
         Not max-height on the svg instead: an svg with a viewBox is a replaced
         element with an intrinsic 2:1 ratio, so capping its height shrinks its
         WIDTH proportionally (CSS 2.1 section 10.4) and the chart would stop
         filling its card. Constraining the non-replaced figure is exact, and
         preserveAspectRatio="xMidYMid meet" keeps the drawing undistorted
         inside whatever box it is given. */
      display: flex;
      flex-direction: column;
      height: var(--ldg-h, 260px);
      /* .ldg-sr is position:absolute; now that the figure is the sizing box it
         must also be the containing block, or the caption escapes to whatever
         positioned ancestor the host page happens to have. */
      position: relative;
    }
    .ldg-svg {
      display: block;
      width: 100%;
      /* flex-basis 0 + min-height 0: take exactly the space left after the
         legend, and stay shrinkable below the intrinsic aspect-ratio height
         instead of overflowing the figure. */
      flex: 1 1 0;
      min-height: 0;
      overflow: visible;
    }
    .ldg-grid line {
      stroke: var(--color-line);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .ldg-axis {
      stroke: var(--color-line-strong);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .ldg-axis-val {
      fill: var(--color-ink-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .ldg-cat {
      fill: var(--color-ink-secondary);
      font-family: var(--font-sans);
      font-size: 11px;
    }
    .ldg-val {
      fill: var(--color-ink-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .ldg-bar {
      transition: opacity 160ms ease;
    }
    @media (prefers-reduced-motion: no-preference) {
      .ldg-bar {
        transform-box: fill-box;
        transform-origin: var(--ldg-grow-origin, bottom);
        animation: ldg-bar-grow 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      @keyframes ldg-bar-grow {
        from {
          transform: scaleY(0);
        }
        to {
          transform: scaleY(1);
        }
      }
    }
    .ldg-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
      margin: 0.5rem 0 0;
      padding: 0;
      list-style: none;
    }
    .ldg-legend li {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--color-ink-secondary);
      font-size: 0.75rem;
    }
    .ldg-swatch {
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 3px;
      flex: none;
    }
    /* The overlay is a line, not a filled band — its key must say so. */
    .ldg-swatch.is-line {
      height: 0.2rem;
      border-radius: 999px;
    }
    .ldg-overlay {
      fill: none;
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .ldg-sr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class CommandBarChartComponent {
  // ---- public input contract -------------------------------------------------
  /** Category labels for the non-value axis (e.g. months, buckets). Required. */
  readonly categories = input.required<readonly string[]>();
  /** One or more data series. A single series renders in accent. Required. */
  readonly series = input.required<readonly BarSeries[]>();
  /** `'vertical'` (columns, default) or `'horizontal'` (bars). */
  readonly orientation = input<BarOrientation>('vertical');
  /** Stack multiple series into one bar per category instead of grouping. */
  readonly stacked = input(false);
  /**
   * A reference series drawn as a step LINE over the bars instead of as another
   * bar — e.g. supply capacity over a committed+pipeline demand stack.
   *
   * It is a separate input rather than a flagged member of {@link series}
   * because `stacked` stacks EVERY entry of that list: a supply series left in
   * there would be added on top of the demand it is supposed to be compared
   * with. It DOES contribute to the value-axis domain, so a supply above the
   * tallest stack raises the axis instead of being clipped off the plot — an
   * overlay outside the domain draws a line that stops at the top gridline and
   * makes the chart understate capacity while looking correct.
   */
  readonly overlay = input<BarSeries | undefined>(undefined);
  /** Render the formatted value next to/inside each bar. */
  readonly showValues = input(false);
  /** Target number of value-axis tick intervals. */
  readonly tickCount = input(5);
  /**
   * Pin the value-axis domain maximum to this absolute value instead of
   * deriving it from the data max. Useful for fixed-scale charts (e.g. a
   * utilization % chart pinned to `100`, so bars read as an absolute % of 100
   * rather than a % of the busiest bar). When `undefined` (default), the
   * maximum is derived from the data as before. Ticks span `[min, maxValue]`.
   */
  readonly maxValue = input<number | undefined>(undefined);
  /** Bar corner radius in px. */
  readonly radius = input(2);
  /** Rendered pixel height of the chart box (width is always 100%). */
  readonly height = input(260);

  /** Built-in value formatting kind. Ignored if {@link format} is provided. */
  readonly formatKind = input<ChartFormatKind>('number');
  /** BCP-47 locale for built-in formatting. */
  readonly locale = input('en-US');
  /** ISO-4217 currency code (only used when formatKind === 'currency'). */
  readonly currency = input('USD');
  /** Custom value formatter; always wins over formatKind/locale/currency. */
  readonly format = input<ChartFormatFn>();

  /** Accessible label for the root `<svg role="img">`. Falls back to caption. */
  readonly ariaLabel = input('Bar chart');
  /** Caption for the visually-hidden screen-reader data table. */
  readonly caption = input('');

  // ---- fixed viewBox geometry (SSR-safe; no measurement) ---------------------
  protected readonly VBW = 720;
  protected readonly VBH = 360;

  private readonly fmt = computed(() => {
    const f = this.format();
    if (f) return f;
    return makeFormatter(undefined, {
      kind: this.formatKind(),
      locale: this.locale(),
      currency: this.currency(),
    });
  });

  /** Plot inset — leaves room for value axis (left/bottom) + labels. */
  protected readonly plot = computed(() => {
    const horizontal = this.orientation() === 'horizontal';
    // Horizontal charts need a wider left gutter for the category names.
    const left = horizontal ? 120 : 56;
    const right = 16;
    const top = 16;
    const bottom = horizontal ? 28 : 44;
    return {
      x: left,
      y: top,
      w: this.VBW - left - right,
      h: this.VBH - top - bottom,
    };
  });

  /** Domain max across stacked totals or grouped maxima (min always ≤ 0 floor). */
  private readonly domain = computed(() => {
    const series = this.series();
    const cats = this.categories();
    const overlay = this.overlay();
    let max = 0;
    let min = 0;
    for (let i = 0; i < cats.length; i++) {
      if (this.stacked()) {
        let pos = 0;
        let neg = 0;
        for (const s of series) {
          const v = s.values[i] ?? 0;
          // A single non-finite datum would poison the accumulator and, through
          // it, the whole axis — see the rationale on the grouped branch below.
          if (!Number.isFinite(v)) continue;
          if (v >= 0) pos += v;
          else neg += v;
        }
        max = Math.max(max, pos);
        min = Math.min(min, neg);
      } else {
        for (const s of series) {
          const v = s.values[i] ?? 0;
          /*
           * Skip non-finite data instead of folding it into the bounds. A NaN (a
           * 0/0 ratio, a JSON null coerced by a caller's `map`) makes
           * Math.max(0, NaN) NaN, and in the PINNED branch below that becomes
           * top = Math.max(pinned, NaN) = NaN -> spacing NaN -> EVERY tick NaN,
           * so the gridlines and the entire value axis vanish rather than one
           * bar. (Unpinned it is survivable: niceScale's own degenerate branch
           * absorbs non-finite bounds and merely collapses to a 0..1 axis.)
           */
          if (!Number.isFinite(v)) continue;
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
      }
      // The overlay is NOT a bar, but it is inside the plot: if it did not widen
      // the domain the line would be clipped at the top gridline and the chart
      // would understate capacity while still looking well-formed.
      if (overlay) {
        const v = overlay.values[i] ?? 0;
        if (Number.isFinite(v)) {
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
      }
    }

    // When `maxValue` is pinned, the value axis must end exactly at it (so bars
    // read as an absolute fraction of `maxValue`, never re-normalised to a nice
    // number). Generate evenly spaced ticks across [niceMin, maxValue] without
    // letting niceScale round the top up. The lower bound still gets a nice
    // floor so any negative data keeps a sensible baseline.
    const pinned = this.maxValue();
    if (pinned != null && Number.isFinite(pinned)) {
      const top = Math.max(pinned, max); // never clip data above the pin
      const { niceMin } = niceScale(min, top, this.tickCount());
      const steps = Math.max(1, this.tickCount());
      const spacing = (top - niceMin) / steps;
      const ticks: number[] = [];
      for (let i = 0; i <= steps; i++) {
        // Round to kill float noise, mirroring chart-format's buildTicks.
        ticks.push(Math.round((niceMin + i * spacing + Number.EPSILON) * 1e6) / 1e6);
      }
      return { niceMin, niceMax: top, ticks };
    }

    return niceScale(min, max, this.tickCount());
  });

  protected readonly ticks = computed<AxisTick[]>(() => {
    const { ticks } = this.domain();
    const fmt = this.fmt();
    return ticks.map((value) => ({
      value,
      label: fmt(value),
      pos: this.valueToPos(value),
    }));
  });

  /** Map a domain value to a pixel position along the value axis. */
  private valueToPos(value: number): number {
    const { niceMin, niceMax } = this.domain();
    const p = this.plot();
    const t = niceMax === niceMin ? 0 : (value - niceMin) / (niceMax - niceMin);
    return this.orientation() === 'vertical'
      ? p.y + p.h - t * p.h // y grows downward
      : p.x + t * p.w;
  }

  private readonly resolvedColors = computed(() =>
    this.series().map((s, i) =>
      s.color ?? (this.series().length === 1 ? 'var(--color-accent)' : seriesColor(i)),
    ),
  );

  /** Overlay stroke: a neutral ink that reads over any series fill, both themes. */
  protected readonly overlayColor = computed(
    () => this.overlay()?.color ?? 'var(--color-ink-secondary)',
  );

  protected readonly legend = computed(() => {
    const entries = this.series().map((s, i) => ({
      name: s.name,
      color: this.resolvedColors()[i],
      isOverlay: false,
    }));
    const overlay = this.overlay();
    if (overlay) entries.push({ name: overlay.name, color: this.overlayColor(), isOverlay: true });
    return entries;
  });

  /**
   * The overlay as a STEP polyline: two points per category (band start, band
   * end) at the same value position, so the connecting verticals fall on the
   * category boundaries. A per-period capacity is flat across its period —
   * sloping between band centres would imply values the data does not carry.
   * `null` when there is no overlay, which is what removes the element.
   */
  protected readonly overlayPoints = computed<string | null>(() => {
    const overlay = this.overlay();
    if (!overlay) return null;
    const horizontal = this.orientation() === 'horizontal';
    const cats = this.categories();
    const p = this.plot();
    const band = (horizontal ? p.h : p.w) / Math.max(1, cats.length);
    const pts: string[] = [];
    for (let ci = 0; ci < cats.length; ci++) {
      const v = overlay.values[ci] ?? 0;
      // A gap in the reference data must not drag the line to zero, and NaN
      // coordinates would silently drop the whole polyline in some renderers.
      if (!Number.isFinite(v)) continue;
      const pos = this.valueToPos(v);
      const start = (horizontal ? p.y : p.x) + ci * band;
      const end = start + band;
      pts.push(horizontal ? `${pos},${start} ${pos},${end}` : `${start},${pos} ${end},${pos}`);
    }
    return pts.length ? pts.join(' ') : null;
  });

  protected readonly bars = computed<BarRect[]>(() => {
    const horizontal = this.orientation() === 'horizontal';
    const cats = this.categories();
    const series = this.series();
    const colors = this.resolvedColors();
    const p = this.plot();
    const fmt = this.fmt();
    const zero = this.valueToPos(0);
    const out: BarRect[] = [];

    const band = (horizontal ? p.h : p.w) / Math.max(1, cats.length);
    const bandPad = band * 0.18; // breathing room around each category group
    const inner = band - bandPad * 2;

    for (let ci = 0; ci < cats.length; ci++) {
      const bandStart = (horizontal ? p.y : p.x) + ci * band + bandPad;

      if (this.stacked()) {
        let posCursor = 0;
        let negCursor = 0;
        for (let si = 0; si < series.length; si++) {
          const v = series[si].values[ci] ?? 0;
          // Same reason as the domain guard: emit NO rect for a non-finite datum
          // rather than one with x/y/height="NaN", which is invalid geometry and
          // would also shift every later bar in the stack via the cursor.
          if (!Number.isFinite(v)) continue;
          const cursorBase = v >= 0 ? posCursor : negCursor;
          const start = this.valueToPos(cursorBase);
          const end = this.valueToPos(cursorBase + v);
          if (v >= 0) posCursor += v;
          else negCursor += v;
          // Per-datum override wins over the series color when defined.
          const color = series[si].colors?.[ci] ?? colors[si];
          out.push(
            this.makeRect(horizontal, bandStart, inner, start, end, color, v, fmt(v), series[si].name, cats[ci]),
          );
        }
      } else {
        const sub = inner / Math.max(1, series.length);
        for (let si = 0; si < series.length; si++) {
          const v = series[si].values[ci] ?? 0;
          // See the stacked branch: a non-finite datum yields no rect at all,
          // never a rect with NaN geometry. The slot it would have occupied is
          // kept (`si * sub`) so the remaining bars stay under their labels.
          if (!Number.isFinite(v)) continue;
          const end = this.valueToPos(v);
          const subStart = bandStart + si * sub;
          // Per-datum override wins over the series color when defined.
          const color = series[si].colors?.[ci] ?? colors[si];
          out.push(
            this.makeGroupedRect(horizontal, subStart, sub, zero, end, color, v, fmt(v), series[si].name, cats[ci]),
          );
        }
      }
    }
    return out;
  });

  private makeRect(
    horizontal: boolean,
    bandStart: number,
    inner: number,
    start: number,
    end: number,
    color: string,
    value: number,
    label: string,
    seriesName: string,
    category: string,
  ): BarRect {
    if (horizontal) {
      const x = Math.min(start, end);
      const w = Math.abs(end - start);
      return {
        x, y: bandStart, w, h: inner, color, value, label, seriesName, category,
        lx: x + w + 4, ly: bandStart + inner / 2, anchor: 'start',
      };
    }
    const y = Math.min(start, end);
    const h = Math.abs(end - start);
    return {
      x: bandStart, y, w: inner, h, color, value, label, seriesName, category,
      lx: bandStart + inner / 2, ly: y - 6, anchor: 'middle',
    };
  }

  private makeGroupedRect(
    horizontal: boolean,
    subStart: number,
    sub: number,
    zero: number,
    end: number,
    color: string,
    value: number,
    label: string,
    seriesName: string,
    category: string,
  ): BarRect {
    const thickness = sub * 0.82;
    const off = (sub - thickness) / 2;
    if (horizontal) {
      const x = Math.min(zero, end);
      const w = Math.abs(end - zero);
      return {
        x, y: subStart + off, w, h: thickness, color, value, label, seriesName, category,
        lx: x + w + 4, ly: subStart + off + thickness / 2, anchor: 'start',
      };
    }
    const y = Math.min(zero, end);
    const h = Math.abs(end - zero);
    return {
      x: subStart + off, y, w: thickness, h, color, value, label, seriesName, category,
      lx: subStart + off + thickness / 2, ly: y - 6, anchor: 'middle',
    };
  }

  protected readonly baseline = computed(() => {
    const p = this.plot();
    const zero = this.valueToPos(0);
    return this.orientation() === 'vertical'
      ? { x1: p.x, y1: zero, x2: p.x + p.w, y2: zero }
      : { x1: zero, y1: p.y, x2: zero, y2: p.y + p.h };
  });

  protected readonly categoryTicks = computed(() => {
    const horizontal = this.orientation() === 'horizontal';
    const cats = this.categories();
    const p = this.plot();
    const band = (horizontal ? p.h : p.w) / Math.max(1, cats.length);
    return cats.map((label, i) => {
      const center = (horizontal ? p.y : p.x) + i * band + band / 2;
      return horizontal
        ? { label, x: p.x - 8, y: center }
        : { label, x: center, y: p.y + p.h + 30 };
    });
  });

  /**
   * Series columns of the screen-reader table — the bars PLUS the overlay. The
   * overlay is the only carrier of the capacity figure a non-sighted user needs
   * to compare the stack against, so leaving it out of the table would make the
   * line sighted-only information.
   */
  protected readonly srSeries = computed<readonly BarSeries[]>(() => {
    const overlay = this.overlay();
    return overlay ? [...this.series(), overlay] : this.series();
  });

  protected readonly srRows = computed(() => {
    const fmt = this.fmt();
    const cols = this.srSeries();
    return this.categories().map((category, ci) => ({
      category,
      cells: cols.map((s) => fmt(s.values[ci] ?? 0)),
    }));
  });
}
