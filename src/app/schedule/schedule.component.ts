import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  Assignment,
  Resource,
  ResourceRequest,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ListStateComponent } from '../shared/list-state.component';
import {
  buildSchedule,
  ResourceLane,
  ScheduleBooking,
} from '../services/schedule.util';

/** The three principal-gated reads the timeline is built from. */
interface ScheduleData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
}

/** Number of week-columns visible at once before prev/next paging. */
const HORIZON_WEEKS = 12;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** A single bar positioned within the visible horizon (grid-column geometry). */
interface PositionedBar {
  booking: ScheduleBooking;
  /** 1-based inclusive grid-column-start within the horizon (the +1 lane-label offset is added in CSS). */
  colStart: number;
  /** Exclusive grid-column-end (CSS grid lines: end = start + span). */
  colEnd: number;
  /** Series colour for the project, as a CSS var() string. */
  color: string;
  /** Short label e.g. "Acme Migration · 60%". */
  label: string;
  /** Whether the booking is over-allocated at some instant (conflict styling). */
  conflict: boolean;
}

/** A resource row resolved to its visible bars + roll-ups for the view. */
interface TimelineRow {
  resourceId: string;
  resourceName: string;
  role: string;
  capacity: number;
  bars: PositionedBar[];
  hasConflict: boolean;
  peakAllocationPct: number;
  /** True when the lane has bookings but none land inside the visible horizon. */
  offscreen: boolean;
}

/** A visible week column: its Monday-anchored start and a short header label. */
interface WeekColumn {
  index: number;
  startMs: number;
  label: string;
}

/**
 * Read-only resource SCHEDULE timeline (Approach B).
 *
 * Loads resources + assignments + requests (keyed on auth.authReady, mirroring
 * the other principal-gated screens) and computes a {@link buildSchedule}
 * model. The model is purely date-based; this component layers the pixel/grid
 * geometry on top — each booking is mapped to a CSS-grid column span across a
 * fixed visible horizon of {@link HORIZON_WEEKS} weeks, with prev/next paging.
 *
 * SSR-safe "today": the date math runs in pure UTC, but "this week" cannot be
 * known on the server without `Date.now`. We seed the horizon anchor to `null`
 * (server renders a deterministic empty-but-structured shell) and set the real
 * week start only in the browser via `afterNextRender`. All geometry is derived
 * from data + the anchor signal — no DOM measurement, no getBBox.
 */
@Component({
  selector: 'app-schedule',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Resource Control</div>
          <h1 class="command-title">Resource Schedule</h1>
          <p class="command-subtitle">
            Date-level booking timeline across the team. Each bar is a booking sized by its
            window and labelled with its allocation; bookings that push a resource past 100%
            in an overlapping window are flagged as conflicts.
          </p>
        </div>
        <div class="flex flex-col items-stretch gap-2 sm:items-end">
          <span class="command-section-label">Horizon · {{ horizonWeeks }} weeks</span>
          <div class="inline-flex items-center gap-2">
            <button
              type="button"
              class="command-button secondary"
              (click)="shiftRange(-1)"
              [disabled]="anchorMs() === null"
              aria-label="Show earlier weeks">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">chevron_left</mat-icon>
              Earlier
            </button>
            <button
              type="button"
              class="command-button secondary"
              (click)="resetRange()"
              [disabled]="anchorMs() === null || rangeOffset() === 0"
              aria-label="Jump to this week">
              Today
            </button>
            <button
              type="button"
              class="command-button secondary"
              (click)="shiftRange(1)"
              [disabled]="anchorMs() === null"
              aria-label="Show later weeks">
              Later
              <mat-icon class="text-[18px] w-[18px] h-[18px]">chevron_right</mat-icon>
            </button>
          </div>
          @if (rangeLabel(); as rl) {
            <span class="font-mono tabular-nums text-xs text-ink-muted">{{ rl }}</span>
          }
        </div>
      </header>

      <!-- Summary strip: over-allocation pressure across the whole roster. -->
      <div class="command-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-3">
          <span
            class="grid size-10 place-items-center rounded-md ring-1"
            [class.bg-critical-tint]="overAllocatedCount() > 0"
            [class.ring-critical]="overAllocatedCount() > 0"
            [class.text-critical-text]="overAllocatedCount() > 0"
            [class.bg-surface-muted]="overAllocatedCount() === 0"
            [class.ring-line]="overAllocatedCount() === 0"
            [class.text-ink-muted]="overAllocatedCount() === 0">
            <mat-icon>{{ overAllocatedCount() > 0 ? 'warning' : 'verified' }}</mat-icon>
          </span>
          <div>
            <div
              class="font-display text-lg font-bold"
              [class.text-critical-text]="overAllocatedCount() > 0"
              [class.text-ink]="overAllocatedCount() === 0">
              @if (overAllocatedCount() > 0) {
                {{ overAllocatedCount() }} {{ overAllocatedCount() === 1 ? 'resource' : 'resources' }} over-allocated
              } @else {
                No over-allocation detected
              }
            </div>
            <p class="text-sm text-ink-muted">
              Across {{ rows().length }} {{ rows().length === 1 ? 'resource' : 'resources' }} and
              {{ totalBookings() }} {{ totalBookings() === 1 ? 'booking' : 'bookings' }}.
            </p>
          </div>
        </div>

        <!-- Legend explaining bar styling. -->
        <div class="flex flex-wrap items-center gap-4 text-xs text-ink-muted">
          <span class="inline-flex items-center gap-2">
            <span class="h-3 w-5 rounded-sm" [style.background]="legendColor"></span>
            Booking (coloured by project)
          </span>
          <span class="inline-flex items-center gap-2">
            <span class="h-3 w-5 rounded-sm bg-critical-tint ring-1 ring-critical"></span>
            Over-allocation conflict
          </span>
        </div>
      </div>

      <app-list-state
        [loading]="data.isLoading()"
        [error]="data.status() === 'error'"
        label="the schedule"
        skeleton="table-rows"
        [rows]="6"
        (retry)="data.reload()">
        @if (anchorMs() === null) {
          <!-- SSR / pre-hydration: the visible week range is browser-derived. -->
          <div class="command-card p-12 text-center text-sm text-ink-muted" aria-busy="true">
            Preparing the timeline…
          </div>
        } @else if (rows().length === 0) {
          <div class="command-card p-12 text-center">
            <div class="mx-auto mb-4 grid size-16 place-items-center rounded-full border border-line bg-surface-muted text-ink-muted">
              <mat-icon class="text-3xl">calendar_view_week</mat-icon>
            </div>
            <h2 class="command-empty-title">No resources to schedule</h2>
            <p class="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
              Once resources are staffed with dated bookings, their timeline appears here.
            </p>
          </div>
        } @else {
          <div class="command-card overflow-hidden">
            <div class="overflow-x-auto">
              <!-- Timeline grid: a leading lane-label column + one column per visible week. -->
              <div
                class="command-schedule-grid"
                role="table"
                aria-label="Resource schedule timeline"
                [style.--lane-col]="laneColWidth"
                [style.--week-col]="weekColWidth"
                [style.grid-template-columns]="gridTemplate()">
                <!-- Header row: empty corner + week labels. -->
                <div class="command-schedule-corner" role="columnheader">Resource</div>
                @for (col of weekColumns(); track col.index) {
                  <div class="command-schedule-weekhead" role="columnheader">
                    <span class="font-mono tabular-nums">{{ col.label }}</span>
                  </div>
                }

                <!-- One row per resource: sticky lane label + a bar track spanning all weeks. -->
                @for (row of rows(); track row.resourceId) {
                  <div class="command-schedule-lane" role="rowheader" [class.is-conflict]="row.hasConflict">
                    <div class="min-w-0">
                      <div class="truncate font-semibold text-ink">{{ row.resourceName }}</div>
                      <div class="truncate text-[11px] uppercase tracking-wide text-ink-muted">{{ row.role }}</div>
                      <div class="mt-0.5 font-mono tabular-nums text-[11px] text-ink-muted">{{ row.capacity }}h/wk</div>
                    </div>
                    @if (row.hasConflict) {
                      <span
                        class="command-schedule-badge"
                        [title]="'Peak allocation ' + (row.peakAllocationPct | number:'1.0-0') + '%'">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">warning</mat-icon>
                        {{ row.peakAllocationPct | number:'1.0-0' }}%
                      </span>
                    }
                  </div>

                  <!-- Bar track: an inner grid of the visible weeks; bars are placed by column span. -->
                  <div
                    class="command-schedule-track"
                    role="cell"
                    [style.grid-template-columns]="'repeat(' + horizonWeeks + ', var(--week-col))'">
                    <!-- Faint week gridlines for readability. -->
                    @for (col of weekColumns(); track col.index) {
                      <div class="command-schedule-cell" [style.grid-column]="(col.index + 1) + ' / span 1'"></div>
                    }
                    @if (row.offscreen) {
                      <div class="command-schedule-offscreen" [style.grid-column]="'1 / -1'">
                        Bookings outside the visible range
                      </div>
                    }
                    @for (bar of row.bars; track bar.booking.assignmentId) {
                      <div
                        class="command-schedule-bar"
                        [class.is-conflict]="bar.conflict"
                        [style.grid-column]="bar.colStart + ' / ' + bar.colEnd"
                        [style.--bar-color]="bar.color"
                        [title]="bar.label + ' · ' + bar.booking.startDate + ' → ' + bar.booking.endDate">
                        <span class="truncate">{{ bar.label }}</span>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          </div>
        }
      </app-list-state>
    </div>
  `,
  styles: [
    `
      .command-schedule-grid {
        display: grid;
        align-items: stretch;
        min-width: max-content;
      }
      .command-schedule-corner {
        position: sticky;
        left: 0;
        z-index: 2;
        padding: 0.5rem 0.75rem;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--cc-muted);
        background: var(--cc-panel-muted);
        border-bottom: 1px solid var(--cc-line);
        border-right: 1px solid var(--cc-line);
      }
      .command-schedule-weekhead {
        padding: 0.5rem 0.5rem;
        text-align: center;
        font-size: 11px;
        color: var(--cc-muted);
        background: var(--cc-panel-muted);
        border-bottom: 1px solid var(--cc-line);
        border-right: 1px solid var(--cc-line);
      }
      .command-schedule-lane {
        /* Each resource claims column 1 of a new grid row; the track (below)
           spans the remaining week columns, so lanes stack vertically. */
        grid-column: 1;
        position: sticky;
        left: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.625rem 0.75rem;
        background: var(--cc-surface);
        border-bottom: 1px solid var(--cc-line);
        border-right: 1px solid var(--cc-line);
      }
      .command-schedule-lane.is-conflict {
        background: var(--color-critical-tint);
      }
      .command-schedule-badge {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
        padding: 1px 6px;
        border-radius: 9999px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--color-critical-text);
        background: var(--color-critical-tint);
        border: 1px solid var(--color-critical);
      }
      .command-schedule-track {
        /* Span every week column (col 2 → last) on the same row as its lane. */
        grid-column: 2 / -1;
        position: relative;
        display: grid;
        grid-auto-rows: minmax(2.75rem, auto);
        align-items: center;
        padding: 0.375rem 0;
        border-bottom: 1px solid var(--cc-line);
      }
      .command-schedule-cell {
        grid-row: 1;
        height: 100%;
        border-right: 1px solid var(--cc-line);
        opacity: 0.45;
      }
      .command-schedule-bar {
        grid-row: 1;
        z-index: 1;
        overflow: hidden;
        margin: 0 2px;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        white-space: nowrap;
        color: #fff;
        background: var(--bar-color, var(--color-accent));
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.18);
      }
      .command-schedule-bar.is-conflict {
        color: var(--color-critical-text);
        background: var(--color-critical-tint);
        outline: 2px solid var(--color-critical);
        outline-offset: -2px;
        box-shadow: none;
      }
      .command-schedule-offscreen {
        grid-row: 1;
        text-align: center;
        font-size: 11px;
        font-style: italic;
        color: var(--cc-muted);
      }
    `,
  ],
})
export class ScheduleComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  // Visible-horizon configuration surfaced to the template.
  protected readonly horizonWeeks = HORIZON_WEEKS;
  protected readonly laneColWidth = '13rem';
  protected readonly weekColWidth = '5.5rem';
  // Legend swatch uses the first series colour as a representative sample.
  protected readonly legendColor = 'var(--color-series-1)';

  /**
   * UTC-ms of the Monday that anchors "this week". `null` on the server and
   * until the first browser render — geometry that depends on it renders a
   * placeholder, keeping SSR deterministic (no Date.now on the server).
   */
  protected readonly anchorMs = signal<number | null>(null);

  /** How many weeks the visible window is shifted from the anchor (prev/next). */
  protected readonly rangeOffset = signal(0);

  constructor() {
    // Browser-only: seed the anchor to the Monday of the current week, computed
    // in UTC so it matches the util's UTC date math. afterNextRender never runs
    // on the server, so the server output is the deterministic placeholder.
    afterNextRender(() => {
      this.anchorMs.set(mondayUtcMs(Date.now()));
    });
  }

  // resources/assignments/requests are principal-gated reads: key on authReady so
  // they fire only after the OAuth bootstrap settles and the bearer is attached
  // (firing earlier 401s and collapses the view — same fix as the other screens).
  protected readonly data = rxResource<ScheduleData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            assignments: this.api.getAssignments(),
            requests: this.api.getRequests(),
          })
        : of<ScheduleData>({ resources: [], assignments: [], requests: [] }),
    defaultValue: { resources: [], assignments: [], requests: [] },
  });

  /** The pure, date-based schedule model (lanes + conflicts). */
  private readonly model = computed(() => {
    const d = this.data.value();
    return buildSchedule(d.resources, d.assignments, d.requests);
  });

  /** Stable per-project colour: index requests/projects by first appearance. */
  private readonly projectColor = computed(() => {
    const map = new Map<string, string>();
    let next = 0;
    for (const lane of this.model().lanes) {
      for (const b of lane.bookings) {
        if (!map.has(b.requestId)) {
          map.set(b.requestId, `var(--color-series-${(next % 7) + 1})`);
          next++;
        }
      }
    }
    return map;
  });

  /** UTC-ms of the first visible week column (anchor shifted by the range offset). */
  private readonly windowStartMs = computed<number | null>(() => {
    const anchor = this.anchorMs();
    if (anchor === null) return null;
    return anchor + this.rangeOffset() * MS_PER_WEEK;
  });

  /** The visible week columns: one per horizon week, with short start labels. */
  protected readonly weekColumns = computed<WeekColumn[]>(() => {
    const start = this.windowStartMs();
    if (start === null) return [];
    const cols: WeekColumn[] = [];
    for (let i = 0; i < HORIZON_WEEKS; i++) {
      const ms = start + i * MS_PER_WEEK;
      cols.push({ index: i, startMs: ms, label: shortDate(ms) });
    }
    return cols;
  });

  /** CSS grid-template-columns: a fixed lane column + N fixed week columns. */
  protected readonly gridTemplate = computed(
    () => `var(--lane-col) repeat(${HORIZON_WEEKS}, var(--week-col))`,
  );

  /** Resolve every lane's bookings to positioned bars within the visible window. */
  protected readonly rows = computed<TimelineRow[]>(() => {
    const start = this.windowStartMs();
    if (start === null) return [];
    const end = start + HORIZON_WEEKS * MS_PER_WEEK;
    const colors = this.projectColor();

    return this.model().lanes.map((lane: ResourceLane) => {
      const bars: PositionedBar[] = [];
      let hasOnscreen = false;

      for (const b of lane.bookings) {
        const bStart = Date.parse(b.startDate);
        const bEnd = Date.parse(b.endDate);
        if (!Number.isFinite(bStart) || !Number.isFinite(bEnd)) continue;

        // Skip bookings entirely outside the visible window (end is exclusive).
        if (bEnd <= start || bStart >= end) continue;
        hasOnscreen = true;

        // Clamp to the window, then map ms -> fractional week columns. Grid lines
        // are 1-based; column 1 is the lane label, so week columns begin at 2.
        const clampedStart = Math.max(bStart, start);
        const clampedEnd = Math.min(bEnd, end);
        const startWeek = (clampedStart - start) / MS_PER_WEEK;
        const endWeek = (clampedEnd - start) / MS_PER_WEEK;
        const colStart = Math.floor(startWeek) + 1; // 1-based within the inner track
        const colEnd = Math.max(colStart + 1, Math.ceil(endWeek) + 1);

        bars.push({
          booking: b,
          colStart,
          colEnd,
          color: colors.get(b.requestId) ?? 'var(--color-accent)',
          label: `${b.label} · ${Math.round(b.allocationPct)}%`,
          conflict: b.conflict,
        });
      }

      return {
        resourceId: lane.resourceId,
        resourceName: lane.resourceName,
        role: lane.role,
        capacity: lane.capacity,
        bars,
        hasConflict: lane.hasConflict,
        peakAllocationPct: lane.peakAllocationPct,
        offscreen: lane.bookings.length > 0 && !hasOnscreen,
      };
    });
  });

  /** Count of resources flagged with at least one over-allocation conflict. */
  protected readonly overAllocatedCount = computed(
    () => this.model().lanes.filter(l => l.hasConflict).length,
  );

  /** Total bookings across all lanes (for the summary strip copy). */
  protected readonly totalBookings = computed(() =>
    this.model().lanes.reduce((acc, l) => acc + l.bookings.length, 0),
  );

  /** "12 May – 03 Aug" label for the visible range; null before hydration. */
  protected readonly rangeLabel = computed<string | null>(() => {
    const start = this.windowStartMs();
    if (start === null) return null;
    const end = start + (HORIZON_WEEKS - 1) * MS_PER_WEEK;
    return `${shortDate(start)} – ${shortDate(end)}`;
  });

  /** Page the visible window by whole weeks (prev = -1 page, next = +1 page). */
  protected shiftRange(direction: -1 | 1): void {
    this.rangeOffset.update(o => o + direction * HORIZON_WEEKS);
  }

  /** Snap the visible window back to the anchor ("this week"). */
  protected resetRange(): void {
    this.rangeOffset.set(0);
  }
}

/**
 * UTC-ms of the Monday at 00:00 UTC for the week containing `ms`. Pure: depends
 * only on its argument, so the caller controls whether `Date.now` is involved
 * (it is invoked browser-only). getUTCDay(): 0=Sun..6=Sat; we shift to Monday.
 */
function mondayUtcMs(ms: number): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(dayStart).getUTCDay();
  const sinceMonday = (dow + 6) % 7; // Mon->0, Sun->6
  return dayStart - sinceMonday * MS_PER_DAY;
}

/** "12 May" for a UTC instant; stable across time zones (uses UTC fields). */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ][d.getUTCMonth()];
  return `${day} ${month}`;
}
