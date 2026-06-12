import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartFormatFn, ChartFormatKind, makeFormatter } from './chart-format';

type DonutTone = 'accent' | 'positive' | 'caution' | 'critical' | 'info';

/**
 * Ledger donut / radial gauge — a single ratio rendered as a progress ring with
 * a centered mono value label. SSR-safe: the arc is computed analytically from
 * the ratio (no DOM, no getBBox). Use for concentration HHI (normalized), a KPI
 * ratio, utilization, etc.
 *
 * The ring sweeps clockwise from 12 o'clock. The track is a full ring; the
 * value arc covers `clamp(value/max, 0..1)` of it.
 */
@Component({
  selector: 'command-donut-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="ldg-donut" [style.--ldg-size.px]="size()">
      <svg
        [attr.viewBox]="'0 0 ' + BOX + ' ' + BOX"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        [attr.aria-label]="ariaLabel()"
        class="ldg-svg"
      >
        <!-- track -->
        <circle
          class="ldg-track"
          [attr.cx]="C"
          [attr.cy]="C"
          [attr.r]="radius()"
          fill="none"
          [attr.stroke-width]="thickness()"
        />
        <!-- value arc (rotated so 0 starts at top, sweeps clockwise) -->
        <circle
          class="ldg-arc"
          [attr.cx]="C"
          [attr.cy]="C"
          [attr.r]="radius()"
          fill="none"
          stroke-linecap="round"
          [attr.stroke-width]="thickness()"
          [style.stroke]="arcColor()"
          [attr.stroke-dasharray]="circumference()"
          [attr.stroke-dashoffset]="dashOffset()"
          [attr.transform]="'rotate(-90 ' + C + ' ' + C + ')'"
        />
        <!-- centered value -->
        <text class="ldg-value" [attr.x]="C" [attr.y]="C" text-anchor="middle" dominant-baseline="central">
          {{ displayValue() }}
        </text>
        @if (label()) {
          <text class="ldg-sublabel" [attr.x]="C" [attr.y]="C + labelOffset()" text-anchor="middle">
            {{ label() }}
          </text>
        }
      </svg>

      <figcaption class="ldg-sr">
        {{ ariaLabel() }}
        <table>
          <caption>{{ caption() || 'Ratio gauge' }}</caption>
          <tbody>
            <tr>
              <th>{{ label() || 'Value' }}</th>
              <td>{{ displayValue() }}</td>
            </tr>
            <tr>
              <th>Of maximum</th>
              <td>{{ srMax() }}</td>
            </tr>
          </tbody>
        </table>
      </figcaption>
    </figure>
  `,
  styles: `
    .ldg-donut {
      margin: 0;
      display: inline-flex;
      width: var(--ldg-size, 160px);
      max-width: 100%;
    }
    .ldg-svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .ldg-track {
      stroke: var(--color-line);
    }
    .ldg-value {
      fill: var(--color-ink);
      font-family: var(--font-mono);
      font-size: 26px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .ldg-sublabel {
      fill: var(--color-ink-muted);
      font-family: var(--font-sans);
      font-size: 11px;
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
    @media (prefers-reduced-motion: no-preference) {
      .ldg-arc {
        transition: stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1);
      }
    }
  `,
})
export class CommandDonutChartComponent {
  // ---- public input contract -------------------------------------------------
  /** The measured value. Required. */
  readonly value = input.required<number>();
  /** Maximum value the ring represents (the value fills `value/max`). Default 1. */
  readonly max = input(1);
  /** Ring outer "size" in px (the rendered box is square; width caps at 100%). */
  readonly size = input(160);
  /** Stroke width of both track and arc, in viewBox units (box is 120). */
  readonly thickness = input(14);
  /** Sub-label rendered under the centered value. */
  readonly label = input('');
  /** Semantic tone for the value arc; ignored if {@link color} is set. */
  readonly tone = input<DonutTone>('accent');
  /** Explicit arc color (any CSS color / token); wins over {@link tone}. */
  readonly color = input<string>();

  readonly formatKind = input<ChartFormatKind>('percent');
  readonly locale = input('en-US');
  readonly currency = input('USD');
  /**
   * Custom formatter for the centered value; always wins. By default the value
   * is formatted with {@link formatKind} (percent uses the `value/max` ratio).
   */
  readonly format = input<ChartFormatFn>();
  /** Override the centered text entirely (e.g. a pre-formatted "0.42" HHI). */
  readonly displayText = input<string>();

  /** Accessible label for the root `<svg role="img">`. */
  readonly ariaLabel = input('Ratio gauge');
  /** Caption for the visually-hidden screen-reader data table. */
  readonly caption = input('');

  // ---- fixed viewBox geometry ------------------------------------------------
  protected readonly BOX = 120;
  protected readonly C = 60;

  protected readonly radius = computed(() => this.C - this.thickness() / 2 - 2);
  protected readonly circumference = computed(() => 2 * Math.PI * this.radius());
  protected readonly labelOffset = () => 22;

  /** Fraction of the ring filled, clamped 0..1. */
  private readonly ratio = computed(() => {
    const max = this.max();
    if (!Number.isFinite(max) || max === 0) return 0;
    return Math.min(1, Math.max(0, this.value() / max));
  });

  protected readonly dashOffset = computed(() => this.circumference() * (1 - this.ratio()));

  protected readonly arcColor = computed(() => {
    const c = this.color();
    if (c) return c;
    switch (this.tone()) {
      case 'positive':
        return 'var(--color-positive)';
      case 'caution':
        return 'var(--color-caution)';
      case 'critical':
        return 'var(--color-critical)';
      case 'info':
        return 'var(--color-info)';
      default:
        return 'var(--color-accent)';
    }
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

  protected readonly displayValue = computed(() => {
    const override = this.displayText();
    if (override != null) return override;
    // For percent, the natural thing is the ratio (value/max); for number/currency
    // we format the raw value.
    if (this.formatKind() === 'percent') return this.fmt()(this.ratio());
    return this.fmt()(this.value());
  });

  protected readonly srMax = computed(() => this.fmt()(this.formatKind() === 'percent' ? 1 : this.max()));
}
