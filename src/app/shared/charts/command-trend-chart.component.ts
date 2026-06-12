import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ChartFormatFn,
  ChartFormatKind,
  makeFormatter,
  niceScale,
  seriesColor,
} from './chart-format';

/** One line/area series over the shared ordered category axis. */
export interface TrendSeries {
  /** Series name (legend + a11y table header). */
  readonly name: string;
  /** One value per category, index-aligned with {@link CommandTrendChartComponent.categories}. */
  readonly values: readonly number[];
  /**
   * Optional explicit stroke color. When omitted the series gets
   * `--color-series-N` by index (single series defaults to `--color-accent`).
   */
  readonly color?: string;
}

interface SeriesPath {
  name: string;
  color: string;
  line: string; // SVG path `d` for the stroke
  area: string; // SVG path `d` for the filled area (empty when mode='line')
  points: { x: number; y: number; value: number; label: string; category: string }[];
}

interface AxisTick {
  value: number;
  label: string;
  pos: number;
}

/**
 * Ledger trend chart — line or area over an ordered category/time axis, 1–3
 * series, straight or smooth (monotone-ish cubic). SSR-safe: paths are computed
 * from inputs + a fixed viewBox, no DOM measurement. Use for utilization trend,
 * recognized-revenue trend, etc.
 */
@Component({
  selector: 'command-trend-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="ldg-chart">
      <svg
        [attr.viewBox]="'0 0 ' + VBW + ' ' + VBH"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        [attr.aria-label]="ariaLabel()"
        class="ldg-svg"
      >
        <!-- horizontal gridlines + y ticks -->
        <g class="ldg-grid">
          @for (t of yTicks(); track t.value) {
            <line [attr.x1]="plot().x" [attr.x2]="plot().x + plot().w" [attr.y1]="t.pos" [attr.y2]="t.pos" />
            <text
              class="ldg-axis-val"
              [attr.x]="plot().x - 8"
              [attr.y]="t.pos"
              text-anchor="end"
              dominant-baseline="middle"
            >{{ t.label }}</text>
          }
        </g>

        <!-- series: area fill then line then dots -->
        <g class="ldg-series">
          @for (s of paths(); track s.name) {
            @if (mode() === 'area' && s.area) {
              <path class="ldg-area" [attr.d]="s.area" [style.fill]="areaFill(s.color)" />
            }
            <path
              class="ldg-line"
              [attr.d]="s.line"
              [style.stroke]="s.color"
              [style.stroke-dasharray]="lineLen()"
              [style.stroke-dashoffset]="lineLen()"
            />
            @if (showDots()) {
              @for (p of s.points; track p.category) {
                <circle class="ldg-dot" [attr.cx]="p.x" [attr.cy]="p.y" r="2.5" [style.fill]="s.color">
                  <title>{{ s.name }} · {{ p.category }}: {{ p.label }}</title>
                </circle>
              }
            }
          }
        </g>

        <!-- x category labels (thinned to avoid overlap) -->
        <g class="ldg-xaxis">
          @for (c of xTicks(); track c.label) {
            <text class="ldg-cat" [attr.x]="c.x" [attr.y]="plot().y + plot().h + 18" text-anchor="middle">{{ c.label }}</text>
          }
        </g>
      </svg>

      @if (series().length > 1) {
        <ul class="ldg-legend" aria-hidden="true">
          @for (s of legend(); track s.name) {
            <li><span class="ldg-swatch" [style.background]="s.color"></span>{{ s.name }}</li>
          }
        </ul>
      }

      <figcaption class="ldg-sr">
        {{ ariaLabel() }}
        <table>
          <caption>{{ caption() || 'Trend chart data' }}</caption>
          <thead>
            <tr>
              <th>Period</th>
              @for (s of series(); track s.name) {
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
    }
    .ldg-svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .ldg-grid line {
      stroke: var(--color-line);
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
    .ldg-line {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ldg-area {
      stroke: none;
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
    /* Draw-on animation: paths start fully dashed (offset) and reveal. */
    @media (prefers-reduced-motion: no-preference) {
      .ldg-line {
        animation: ldg-draw 900ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      @keyframes ldg-draw {
        to {
          stroke-dashoffset: 0;
        }
      }
    }
    /* Under reduced motion, force the line fully drawn (offset 0). */
    @media (prefers-reduced-motion: reduce) {
      .ldg-line {
        stroke-dashoffset: 0 !important;
      }
    }
  `,
})
export class CommandTrendChartComponent {
  // ---- public input contract -------------------------------------------------
  /** Ordered category / time-axis labels. Required. */
  readonly categories = input.required<readonly string[]>();
  /** 1–3 trend series. Required. */
  readonly series = input.required<readonly TrendSeries[]>();
  /** `'line'` (default) or `'area'` (subtle color-mix fill under the line). */
  readonly mode = input<'line' | 'area'>('line');
  /** Smooth cubic interpolation (`true`) or straight segments (`false`, default). */
  readonly smooth = input(false);
  /** Render a small dot at each data point. */
  readonly showDots = input(true);
  /** Target number of y-axis tick intervals. */
  readonly tickCount = input(5);
  /** Force the y-axis to start at zero (else it fits the data range). */
  readonly zeroBaseline = input(true);

  readonly formatKind = input<ChartFormatKind>('number');
  readonly locale = input('en-US');
  readonly currency = input('USD');
  /** Custom value formatter; always wins over formatKind/locale/currency. */
  readonly format = input<ChartFormatFn>();

  /** Accessible label for the root `<svg role="img">`. */
  readonly ariaLabel = input('Trend chart');
  /** Caption for the visually-hidden screen-reader data table. */
  readonly caption = input('');

  // ---- fixed viewBox geometry ------------------------------------------------
  protected readonly VBW = 720;
  protected readonly VBH = 300;
  /** Big constant for stroke-dash draw animation (covers any path length). */
  protected readonly lineLen = () => 2000;

  protected readonly plot = computed(() => {
    const left = 56;
    const right = 16;
    const top = 14;
    const bottom = 30;
    return { x: left, y: top, w: this.VBW - left - right, h: this.VBH - top - bottom };
  });

  private readonly fmt = computed(() => {
    const f = this.format();
    if (f) return f;
    return makeFormatter(undefined, {
      kind: this.formatKind(),
      locale: this.locale(),
      currency: this.currency(),
    });
  });

  private readonly domain = computed(() => {
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const s of this.series()) {
      for (const v of s.values) {
        if (!Number.isFinite(v)) continue;
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
    }
    if (!Number.isFinite(max)) {
      max = 1;
      min = 0;
    }
    if (this.zeroBaseline() && min > 0) min = 0;
    return niceScale(min, max, this.tickCount());
  });

  private xAt(i: number): number {
    const p = this.plot();
    const n = this.categories().length;
    if (n <= 1) return p.x + p.w / 2;
    return p.x + (i / (n - 1)) * p.w;
  }

  private yAt(value: number): number {
    const { niceMin, niceMax } = this.domain();
    const p = this.plot();
    const t = niceMax === niceMin ? 0 : (value - niceMin) / (niceMax - niceMin);
    return p.y + p.h - t * p.h;
  }

  protected readonly yTicks = computed<AxisTick[]>(() => {
    const fmt = this.fmt();
    return this.domain().ticks.map((value) => ({ value, label: fmt(value), pos: this.yAt(value) }));
  });

  protected readonly xTicks = computed(() => {
    const cats = this.categories();
    // Thin labels so at most ~8 render; keeps the axis legible without measuring.
    const stride = Math.max(1, Math.ceil(cats.length / 8));
    const out: { label: string; x: number }[] = [];
    for (let i = 0; i < cats.length; i++) {
      if (i % stride === 0 || i === cats.length - 1) {
        out.push({ label: cats[i], x: this.xAt(i) });
      }
    }
    return out;
  });

  private readonly resolvedColors = computed(() =>
    this.series().map((s, i) =>
      s.color ?? (this.series().length === 1 ? 'var(--color-accent)' : seriesColor(i)),
    ),
  );

  protected readonly legend = computed(() =>
    this.series().map((s, i) => ({ name: s.name, color: this.resolvedColors()[i] })),
  );

  protected readonly paths = computed<SeriesPath[]>(() => {
    const colors = this.resolvedColors();
    const fmt = this.fmt();
    const cats = this.categories();
    const p = this.plot();

    return this.series().map((s, si) => {
      const points = cats.map((category, i) => ({
        x: this.xAt(i),
        y: this.yAt(s.values[i] ?? 0),
        value: s.values[i] ?? 0,
        label: fmt(s.values[i] ?? 0),
        category,
      }));
      const line = this.smooth() ? smoothPath(points) : straightPath(points);
      const baseY = p.y + p.h;
      const area =
        this.mode() === 'area' && points.length
          ? `${line} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`
          : '';
      return { name: s.name, color: colors[si], line, area, points };
    });
  });

  protected readonly areaFill = (color: string) =>
    `color-mix(in oklch, ${color} 16%, transparent)`;

  protected readonly srRows = computed(() => {
    const fmt = this.fmt();
    return this.categories().map((category, ci) => ({
      category,
      cells: this.series().map((s) => fmt(s.values[ci] ?? 0)),
    }));
  });
}

// ---- pure path builders (module scope; deterministic, SSR-safe) -------------

function straightPath(pts: { x: number; y: number }[]): string {
  if (!pts.length) return '';
  return pts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${r(pt.x)} ${r(pt.y)}`).join(' ');
}

/** Catmull-Rom → cubic Bézier smoothing (no overshoot tuning needed for trends). */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return straightPath(pts);
  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${r(c1x)} ${r(c1y)}, ${r(c2x)} ${r(c2y)}, ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}

function r(v: number): number {
  return Math.round(v * 100) / 100;
}
