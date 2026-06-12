/**
 * Ledger SVG chart library — reusable, SSR-safe, zero-dependency charts themed
 * purely with Ledger design tokens.
 *
 * @example
 * import { CommandBarChartComponent, BarSeries } from 'src/app/shared/charts';
 */
export { CommandBarChartComponent } from './command-bar-chart.component';
export type { BarSeries } from './command-bar-chart.component';

export { CommandTrendChartComponent } from './command-trend-chart.component';
export type { TrendSeries } from './command-trend-chart.component';

export { CommandDonutChartComponent } from './command-donut-chart.component';

export {
  makeFormatter,
  niceScale,
  seriesColor,
} from './chart-format';
export type {
  ChartFormatFn,
  ChartFormatKind,
  ChartFormatOptions,
} from './chart-format';
