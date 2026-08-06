import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  Assignment,
  Resource,
  ResourceRequest,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ListStateComponent } from '../shared/list-state.component';
import {
  buildSchedule,
  ResourceLane,
  ScheduleBooking,
  ScheduleModel,
} from '../services/schedule.util';
import { todayLocalUtcMs } from '../services/local-date.util';

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
/** A booking can never be shorter than one whole week (resize floor). */
const MIN_DURATION_DAYS = 7;
/**
 * Pointer travel (px, in any direction) below which a gesture counts as a
 * click/tap rather than a drag, so nothing is previewed. Load-bearing now that
 * the bar is `touch-action: pan-x`: a tap or a small nudge must never preview a
 * week shift, and must never reassign the booking to whichever lane the finger
 * happened to drift over.
 */
const DRAG_THRESHOLD_PX = 3;

/**
 * What kind of drag is in flight.
 *  - 'move'         : translate the whole booking (both dates shift together).
 *  - 'resize-start' : drag the left edge; only startDate moves.
 *  - 'resize-end'   : drag the right edge; only endDate moves.
 */
type DragMode = 'move' | 'resize-start' | 'resize-end';

/** Live drag state, browser-only; null when idle. */
interface DragState {
  mode: DragMode;
  assignmentId: string;
  /** The lane the booking started in (for vertical-reassign detection). */
  fromResourceId: string;
  /** pointerId so we only react to the captured pointer's moves. */
  pointerId: number;
  /** Client-X where the drag began (px). */
  originClientX: number;
  /**
   * Client-Y where the drag began (px). Only the movement threshold uses it: a
   * reassign drag can be purely VERTICAL, so a horizontal-only threshold would
   * refuse to start it.
   */
  originClientY: number;
  /** Pre-drag snapshot of the dragged assignment (for rollback + no-op check). */
  before: Assignment;
  /** Whole-week delta currently previewed (move + resize). */
  weekDelta: number;
  /** Resource lane the pointer is currently over (move only); null = unchanged. */
  hoverResourceId: string | null;
  /** True once the pointer has moved enough to count as a drag (vs a click). */
  moved: boolean;
}

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
  /** True while THIS bar is the one being dragged/resized (visual elevation). */
  dragging: boolean;
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
 * Interactive resource SCHEDULE timeline (Approach C).
 *
 * Builds on the read-only Approach B timeline: loads resources + assignments +
 * requests (keyed on auth.authReady, mirroring the other principal-gated
 * screens) and computes a {@link buildSchedule} model. The model is purely
 * date-based; this component layers the pixel/grid geometry on top — each
 * booking is mapped to a CSS-grid column span across a fixed visible horizon of
 * {@link HORIZON_WEEKS} weeks, with prev/next paging.
 *
 * Approach C adds DRAG-TO-SCHEDULE on top of that exact geometry:
 *  - A writable {@link working} copy of the loaded assignments (a `linkedSignal`
 *    re-seeded on every reload). The schedule model derives from this copy, so
 *    an optimistic local edit re-renders bars AND re-runs conflict detection
 *    instantly.
 *  - Dragging a bar BODY translates the booking by whole weeks (snap to the
 *    same `--week-col` pixel width the layout uses); dropping over a different
 *    lane also reassigns (changes resourceId). Dragging the edge handles
 *    resizes start/end (min 1 week). Keyboard arrows do the same by ±1 week.
 *  - On release, if anything changed, the optimistic edit is kept AND committed
 *    via `api.updateAssignment`; on error the working copy reverts to the
 *    pre-drag snapshot and an error toast is shown.
 *
 * SSR safety is unchanged: the horizon anchor is `null` on the server (no
 * Date.now), geometry is derived from data + the anchor signal (no DOM
 * measurement), and all pointer/keyboard handlers are template-bound so they
 * never run during SSR. The single piece of DOM measurement the drag needs (the
 * px width of one week column) is read browser-only, after first render, and
 * falls back to the known `--week-col` rem value parsed against the root font
 * size — so drag math matches rendering without a getBBox during SSR.
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
          <!-- Drag affordance hint (interactive timeline). Every pointer gesture
               named here has a key equivalent, and the hint states them all. -->
          <p class="mt-2 inline-flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <mat-icon class="text-[16px] w-[16px] h-[16px]">drag_indicator</mat-icon>
            Drag a booking to reschedule, drop it on another resource to reassign, or drag its
            edges to resize. Or focus a bar: arrows move it by a week, Shift+arrows resize the
            end, Alt+Shift+arrows resize the start, up/down reassign it to the resource above or
            below.
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

      <!-- ONE READ-STATE BOUNDARY OWNS THE SUMMARY STRIP AND THE TIMELINE.
           The strip used to render ABOVE this wrapper, so for the whole duration
           of the three-endpoint read the page asserted — in bold, behind a green
           'verified' badge — "No over-allocation detected" across "0 resources
           and 0 bookings": a reassuring claim about data that had not been
           fetched. If a leg then failed, model() threw out of that same strip and
           aborted the change-detection pass, which made the error panel below
           unreachable code, so the false all-clear became the TERMINAL state of
           the screen. Moving the strip inside the ng-template lets one wrapper
           own loading, error and content, instead of a second copy of the state
           machine that would drift.

           The header above stays where it is on purpose: rangeLabel()/anchorMs()
           never touch data.value(), so it is safe there — and it must remain
           visible in the error state so the user can see WHICH screen failed.

           [loading] folds auth readiness — see scheduleLoading(). -->
      <app-list-state
        [loading]="scheduleLoading()"
        [error]="data.status() === 'error'"
        label="the schedule"
        skeleton="table-rows"
        [rows]="6"
        (retry)="data.reload()">
        <ng-template>
        <!-- Summary strip: over-allocation pressure across the whole roster. -->
        <div class="command-card mb-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
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
              <!-- Timeline grid: a leading lane-label column + one column per visible week.

                   role="group", NOT role="table": an ARIA table is only valid when
                   its headers and cells are owned by role="row" elements, and the
                   geometry here is ONE flat grid (a single grid-template-columns
                   spanning lane + every week), so there is no element that could
                   own a row without a restructure. Wrapping in display:contents
                   rows is not a way out either — such elements generate no box and
                   are unreliably exposed to AT, which would re-issue the same false
                   promise. So the structural roles are dropped: the week labels and
                   lane text are ordinary content, and each booking carries its own
                   full name via barAriaLabel(), which is where the per-bar
                   semantics actually live. -->
              <div
                class="command-schedule-grid"
                role="group"
                aria-label="Resource schedule timeline"
                [class.is-dragging]="drag() !== null"
                [style.--lane-col]="laneColWidth"
                [style.--week-col]="weekColWidth"
                [style.grid-template-columns]="gridTemplate()">
                <!-- Header strip: empty corner + week labels. -->
                <div class="command-schedule-corner">Resource</div>
                @for (col of weekColumns(); track col.index) {
                  <div class="command-schedule-weekhead">
                    <span class="font-mono tabular-nums">{{ col.label }}</span>
                  </div>
                }

                <!-- One lane per resource: sticky lane label + a bar track spanning all weeks. -->
                @for (row of rows(); track row.resourceId) {
                  <div class="command-schedule-lane" [class.is-conflict]="row.hasConflict">
                    <div class="min-w-0">
                      <div class="truncate font-semibold text-ink">{{ row.resourceName }}</div>
                      <div class="truncate text-[11px] uppercase tracking-wide text-ink-muted">{{ row.role }}</div>
                      <div class="mt-0.5 font-mono tabular-nums text-[11px] text-ink-muted">{{ row.capacity | number:'1.0-2' }}h/wk</div>
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

                  <!-- Bar track: an inner grid of the visible weeks; bars are placed by column span.
                       data-resource-id lets a move-drop detect which lane the pointer is over. -->
                  <div
                    class="command-schedule-track"
                    [class.is-drop-target]="drag()?.hoverResourceId === row.resourceId && drag()?.mode === 'move'"
                    [attr.data-resource-id]="row.resourceId"
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
                        role="button"
                        tabindex="0"
                        [class.is-conflict]="bar.conflict"
                        [class.is-dragging]="bar.dragging"
                        [style.grid-column]="bar.colStart + ' / ' + bar.colEnd"
                        [style.--bar-color]="bar.color"
                        [attr.aria-label]="barAriaLabel(row, bar)"
                        [title]="bar.label + ' · ' + bar.booking.startDate + ' → ' + bar.booking.endDate"
                        (pointerdown)="onBarPointerDown($event, row.resourceId, bar)"
                        (pointermove)="onPointerMove($event)"
                        (pointerup)="onPointerUp($event)"
                        (pointercancel)="onPointerCancel($event)"
                        (keydown)="onBarKeydown($event, bar)">
                        <!-- Left resize handle. -->
                        <span
                          class="command-schedule-handle command-schedule-handle--start"
                          aria-hidden="true"
                          (pointerdown)="onHandlePointerDown($event, row.resourceId, bar, 'resize-start')"></span>
                        <span class="truncate">{{ bar.label }}</span>
                        <!-- Right resize handle. -->
                        <span
                          class="command-schedule-handle command-schedule-handle--end"
                          aria-hidden="true"
                          (pointerdown)="onHandlePointerDown($event, row.resourceId, bar, 'resize-end')"></span>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          </div>
        }
        </ng-template>
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
      /* While a drag is in flight, suppress text selection across the whole grid. */
      .command-schedule-grid.is-dragging {
        user-select: none;
        -webkit-user-select: none;
        cursor: grabbing;
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
      /* Lane the pointer is hovering as a move-reassign drop target. */
      .command-schedule-track.is-drop-target {
        background: color-mix(in oklch, var(--color-accent) 10%, transparent);
        outline: 1px dashed color-mix(in oklch, var(--color-accent) 55%, transparent);
        outline-offset: -1px;
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
        position: relative;
        display: flex;
        align-items: center;
        overflow: hidden;
        margin: 0 2px;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        white-space: nowrap;
        /* CONTRAST: the label is the only per-bar identification, and the fill is
           a project-cycled --color-series-N. White on those solid fills measures
           3.19:1 (light, series-4) down to 2.05:1 (dark) — under AA for 12px
           semibold text. So the series colour becomes a 22% TINT of the surface
           and carries the identity as a left edge stripe, while the label uses the
           body ink token: 10.7–14.8:1 for all seven series in both themes.
           Note --color-ink is theme-aware (near-black on light, near-white on
           dark), which is why keeping the solid fill and only swapping the ink
           would NOT have worked — dark ink on a dark series fill is 1.83–2.58:1. */
        color: var(--color-ink);
        background: color-mix(in oklch, var(--bar-color, var(--color-accent)) 22%, var(--color-surface));
        box-shadow: inset 3px 0 0 var(--bar-color, var(--color-accent));
        /* The bar body itself moves the booking. */
        cursor: grab;
        /* pan-x, not none: press-and-hold still starts the drag (pointermove is
           what drives it), but a horizontal swipe that begins on a bar reaches
           the timeline's own x-scroller — at narrow widths a bar can cover the
           whole visible strip, and touch-action:none made those lanes
           unpannable by touch. */
        touch-action: pan-x;
        transition: box-shadow 120ms ease, transform 120ms ease, opacity 120ms ease;
      }
      .command-schedule-bar:active {
        cursor: grabbing;
      }
      /* The bar currently being dragged/resized: slight lift + translucency.
         The inset stripe is repeated so the lift shadow does not erase the
         project's identity colour mid-drag. */
      .command-schedule-bar.is-dragging {
        z-index: 3;
        opacity: 0.92;
        transform: translateY(-1px);
        box-shadow: inset 3px 0 0 var(--bar-color, var(--color-accent)), 0 6px 16px rgb(0 0 0 / 0.28);
        cursor: grabbing;
      }
      .command-schedule-bar.is-conflict {
        color: var(--color-critical-text);
        background: var(--color-critical-tint);
        outline: 2px solid var(--color-critical);
        outline-offset: -2px;
        box-shadow: none;
      }
      /* Edge grab handles: the resize hit-target is 24px wide (WCAG 2.2 SC 2.5.8
         minimum pointer target — these handles are the only way to change a
         booking's start/end with a pointer), while the visible grip stays the
         original 9px and is painted by ::before, so the look is unchanged. */
      .command-schedule-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 24px;
        cursor: col-resize;
        touch-action: none;
        background: transparent;
        z-index: 2;
      }
      .command-schedule-handle::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        width: 9px;
        /* The grip reads against the bar's own tint (a white wash would be
           invisible on it), so it is a stronger mix of the same series colour. */
        background: color-mix(in oklch, var(--bar-color, var(--color-accent)) 55%, transparent);
      }
      .command-schedule-bar.is-conflict .command-schedule-handle::before {
        background: color-mix(in oklch, var(--color-critical) 35%, transparent);
      }
      .command-schedule-handle--start {
        left: 0;
      }
      .command-schedule-handle--start::before {
        left: 0;
        border-top-left-radius: 6px;
        border-bottom-left-radius: 6px;
      }
      .command-schedule-handle--end {
        right: 0;
      }
      .command-schedule-handle--end::before {
        right: 0;
        border-top-right-radius: 6px;
        border-bottom-right-radius: 6px;
      }
      .command-schedule-offscreen {
        grid-row: 1;
        text-align: center;
        font-size: 11px;
        font-style: italic;
        color: var(--cc-muted);
      }
      /* Narrow viewports: shrink the week column so at least one whole week fits
         beside the (already viewport-capped) lane column. At 320px that gives
         288 − 144 = 144px of track, i.e. two full 4rem weeks instead of 80px of
         a 5.5rem one. The !important is load-bearing, not laziness: the template
         sets --week-col as an INLINE custom property (it is also the value the
         drag math parses), and an inline declaration otherwise beats this rule. */
      @media (max-width: 480px) {
        .command-schedule-grid {
          --week-col: 4rem !important;
        }
      }
      /* Honour reduced-motion: drop the snap/lift animation entirely. */
      @media (prefers-reduced-motion: reduce) {
        .command-schedule-bar {
          transition: none;
        }
        .command-schedule-bar.is-dragging {
          transform: none;
        }
      }
    `,
  ],
})
export class ScheduleComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notify = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  // Visible-horizon configuration surfaced to the template.
  protected readonly horizonWeeks = HORIZON_WEEKS;
  /**
   * Sticky lane column width. Viewport-aware on purpose: a flat 13rem pinned 208
   * of the 288px content box at a 320px viewport, leaving 80px — less than one
   * week column — so no week label and its bar were ever visible together. The
   * lane's inner block already truncates (`min-w-0`), so it takes the squeeze.
   */
  protected readonly laneColWidth = 'min(13rem, 45vw)';
  /**
   * Default week-column width. Stays a plain rem value because
   * {@link fallbackWeekColPx} parses it for the drag's px→week math; the narrow
   * viewport override lives in the styles block below (a media query), which
   * `measureWeekColumn()` reads back from the rendered track.
   */
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

  /**
   * Measured pixel width of one week column. The drag converts a horizontal px
   * delta into a whole-week delta by dividing by this. It is the SAME width the
   * layout uses (`--week-col`): we measure a rendered week gridline once after
   * first paint, and fall back to parsing the rem value against the root font
   * size. Never measured on the server (drag handlers never fire there).
   */
  private weekColPx = 0;

  /** Live drag state (browser-only); null when nothing is being dragged. */
  protected readonly drag = signal<DragState | null>(null);

  constructor() {
    // Browser-only: seed the anchor to the Monday of the user's CURRENT LOCAL
    // week (P2-21 — see currentWeekAnchorMs), expressed in UTC ms so it matches
    // the util's UTC date math. afterNextRender never runs on the server, so the
    // server output is the deterministic placeholder.
    afterNextRender(() => {
      this.anchorMs.set(currentWeekAnchorMs());
      this.measureWeekColumn();
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

  /**
   * Whether the schedule has nothing truthful to render yet. `isLoading()` alone
   * is NOT that question: `params()` above is false until the OIDC bootstrap
   * settles and the stream answers that with `of(<empty>)` — a RESOLVED empty,
   * not a pending one — so isLoading() was FALSE for the whole afterNextRender ->
   * /api/storage-status -> OIDC discovery window (auth.service.ts 154, 191-249)
   * *and* in the SSR HTML shipped to the browser. Bound bare, the wrapper showed
   * the resolved-empty timeline — "No resources to schedule", and the summary
   * strip's green all-clear across zero resources — for a read not yet made.
   *
   * Not-ready counts as loading, never as ready-and-empty — the same rule
   * resources.component.ts's `listLoading()` applies, whose shape this mirrors.
   */
  protected readonly scheduleLoading = computed<boolean>(
    () => !this.auth.authReady() || this.data.isLoading(),
  );

  /**
   * EDITABLE WORKING COPY of the loaded assignments. `linkedSignal` gives us a
   * writable signal that RE-SEEDS to a fresh copy whenever the loaded resource
   * changes (a reload), while letting us mutate it locally in between. The whole
   * schedule model is derived from this copy, so optimistic edits (drag preview
   * + commit) re-render bars and re-run conflict detection instantly — and a
   * reload cleanly discards any uncommitted local state.
   */
  private readonly working = linkedSignal({
    // READ-FAILURE GUARD. `data.value()` THROWS while the resource is in its
    // error state, and a linkedSignal's SOURCE is evaluated outside the template
    // — no template reordering or ng-template deferral protects it, so this
    // throw would abort the change-detection pass on its own and make the
    // "Couldn't load the schedule" panel and its Retry unreachable code.
    // Emptiness is never this screen's ANSWER: `data.status() === 'error'` drives
    // the wrapper's [error] in the same pass, so the user gets the panel, not a
    // bookingless timeline. (Hence not the banned error-to-empty accessor.)
    source: (): Assignment[] =>
      this.data.status() === 'error' ? [] : this.data.value().assignments,
    // Shallow-clone each assignment so per-field optimistic writes never mutate
    // the loaded resource's objects (which would defeat re-seeding/rollback).
    computation: (assignments: Assignment[]): Assignment[] => assignments.map(a => ({ ...a })),
  });

  /**
   * The pure, date-based schedule model (lanes + conflicts), derived from the
   * WORKING copy of assignments (not the raw load) so local edits flow through.
   */
  private readonly model = computed<ScheduleModel>(() => {
    // Same read-failure guard, and the same reasoning, as `working` above: this
    // is reached from rows()/overAllocatedCount()/totalBookings(), and the
    // summary strip that reads those now lives inside the wrapper's ng-template
    // — but `projectColor` and the drag handlers reach it from outside, so the
    // short-circuit belongs here rather than relying on template placement.
    if (this.data.status() === 'error') return { lanes: [], conflicts: [] };
    const d = this.data.value();
    return buildSchedule(d.resources, this.working(), d.requests);
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
    const draggingId = this.drag()?.assignmentId ?? null;

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
          dragging: b.assignmentId === draggingId,
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

  // --- accessibility -------------------------------------------------------

  /**
   * Descriptive aria-label for a bar: who/what, dates, allocation, conflict —
   * then the FULL key list, since these keys are the only pointer-free route to
   * each edit and nothing else on the screen announces them.
   */
  protected barAriaLabel(row: TimelineRow, bar: PositionedBar): string {
    const b = bar.booking;
    const conflict = bar.conflict ? ', over-allocated' : '';
    return (
      `${b.label}, ${Math.round(b.allocationPct)}% allocation, assigned to ${row.resourceName}, ` +
      `${b.startDate} to ${b.endDate}${conflict}. ` +
      `Drag to reschedule; left and right arrows move by one week, ` +
      `Shift plus arrows resize the end, Alt plus Shift plus arrows resize the start, ` +
      `up and down arrows reassign to the previous or next resource.`
    );
  }

  // =========================================================================
  // DRAG / RESIZE / REASSIGN
  //
  // px↔week snapping: every interaction is quantised to WHOLE weeks. A pointer
  // drag accumulates a client-X delta; dividing by the measured px width of one
  // week column ({@link weekColPx}) and rounding gives a whole-week delta. The
  // booking is then previewed shifted by that many weeks using PURE ISO date
  // arithmetic (parse YYYY-MM-DD → add delta*7 days → format) — never Date.now.
  // Because the preview is written into the working copy, buildSchedule() re-runs
  // and conflict styling updates live. On release we keep the optimistic change
  // and PUT it; on error we restore the pre-drag snapshot and toast.
  // =========================================================================

  /** Begin a MOVE drag from the bar body. */
  protected onBarPointerDown(event: PointerEvent, resourceId: string, bar: PositionedBar): void {
    // Ignore non-primary buttons (right-click / middle-click).
    if (event.button !== 0) return;
    this.beginDrag(event, resourceId, bar, 'move');
  }

  /** Begin a RESIZE drag from one of the edge handles. */
  protected onHandlePointerDown(
    event: PointerEvent,
    resourceId: string,
    bar: PositionedBar,
    mode: 'resize-start' | 'resize-end',
  ): void {
    if (event.button !== 0) return;
    // Stop the bar-body pointerdown from also firing a 'move'.
    event.stopPropagation();
    this.beginDrag(event, resourceId, bar, mode);
  }

  /** Shared drag-initiation: snapshot the assignment and capture the pointer. */
  private beginDrag(event: PointerEvent, resourceId: string, bar: PositionedBar, mode: DragMode): void {
    if (!this.isBrowser) return;
    if (this.drag() !== null) return; // one drag at a time

    const before = this.working().find(a => a.id === bar.booking.assignmentId);
    if (!before) return;

    // Make sure we have a fresh, accurate week-column width for the math.
    if (this.weekColPx <= 0) this.measureWeekColumn();

    // Capture the pointer on the BAR element (the one that owns the
    // pointermove/up listeners) so we keep receiving events even when the
    // pointer leaves the bar — whether the gesture started on the body or on an
    // edge handle. Captured events still bubble from the handle up to the bar.
    const barEl = (event.target as Element | null)?.closest<HTMLElement>('.command-schedule-bar');
    barEl?.setPointerCapture?.(event.pointerId);

    this.drag.set({
      mode,
      assignmentId: before.id,
      fromResourceId: resourceId,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originClientY: event.clientY,
      before: { ...before },
      weekDelta: 0,
      hoverResourceId: resourceId,
      moved: false,
    });
    event.preventDefault();
  }

  /** Track a drag in flight: recompute the whole-week delta and preview it live. */
  protected onPointerMove(event: PointerEvent): void {
    const d = this.drag();
    if (!d || event.pointerId !== d.pointerId) return;

    // Movement threshold FIRST: below it nothing is previewed at all — neither the
    // week shift nor the lane hover. Measured as total travel (not just X) because
    // a reassign drag can be purely vertical, and a horizontal-only threshold
    // would silently disable it.
    const dx = event.clientX - d.originClientX;
    const dy = event.clientY - d.originClientY;
    if (!d.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;

    // px → whole-week delta using the SAME column width the layout renders with.
    const px = this.weekColPx > 0 ? this.weekColPx : this.fallbackWeekColPx();
    const weekDelta = Math.round(dx / px);

    // For a MOVE, also figure out which lane the pointer is currently over so a
    // drop can reassign. Uses elementFromPoint (browser-only) + the lane's
    // data-resource-id; no getBBox / layout measurement of the bar itself.
    let hoverResourceId = d.hoverResourceId;
    if (d.mode === 'move') {
      hoverResourceId = this.laneUnderPointer(event) ?? d.fromResourceId;
    }

    if (d.moved && weekDelta === d.weekDelta && hoverResourceId === d.hoverResourceId) {
      return; // nothing meaningfully changed since the last move
    }

    this.drag.set({ ...d, weekDelta, hoverResourceId, moved: true });
    // Preview the change in the working copy so the model + conflicts re-render.
    this.applyPreview({ ...d, weekDelta, hoverResourceId, moved: true });
  }

  /** Commit (or no-op) on release. */
  protected onPointerUp(event: PointerEvent): void {
    const d = this.drag();
    if (!d || event.pointerId !== d.pointerId) return;
    this.finishDrag(d);
  }

  /** Pointer cancelled (e.g. OS gesture): treat as an abort + rollback. */
  protected onPointerCancel(event: PointerEvent): void {
    const d = this.drag();
    if (!d || event.pointerId !== d.pointerId) return;
    this.rollback(d.before);
    this.drag.set(null);
  }

  /**
   * Keyboard scheduling — the pointer-free route to EVERY edit the drag offers,
   * because reassigning a booking to another person exists nowhere else in the
   * app, and a booking entered on the wrong resource would otherwise be
   * uncorrectable without a mouse:
   *  - ←/→               move the whole booking by ∓1 week
   *  - Shift+←/→         resize the END by ∓1 week
   *  - Alt+Shift+←/→     resize the START by ∓1 week (the end stays put)
   *  - ↑/↓               REASSIGN to the adjacent resource lane
   *
   * Alt+←/→ alone is deliberately NOT used: it is Back/Forward on Windows and
   * Linux browsers, so it is a hostile binding even with preventDefault().
   */
  protected onBarKeydown(event: KeyboardEvent, bar: PositionedBar): void {
    const key = event.key;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    if (!horizontal && !vertical) return;

    const before = this.working().find(a => a.id === bar.booking.assignmentId);
    if (!before) return;
    const snapshot: Assignment = { ...before };

    let next: Assignment | null;
    if (vertical) {
      // REASSIGN: step to the neighbouring lane in roster order. At either end of
      // the roster there is nowhere to go — return WITHOUT preventDefault so the
      // key keeps its normal scrolling behaviour instead of dying silently.
      const neighbour = this.neighbourResourceId(before.resourceId, key === 'ArrowDown' ? 1 : -1);
      if (neighbour === null) return;
      event.preventDefault();
      next = { ...before, resourceId: neighbour };
    } else {
      event.preventDefault();
      const dir = key === 'ArrowRight' ? 1 : -1;
      if (event.altKey && event.shiftKey) {
        // Resize the START (Alt+Shift+arrows), enforcing the 1-week floor.
        next = this.resizedStart(before, dir);
      } else if (event.shiftKey) {
        // Resize the END by ±1 week (Shift+arrows), enforcing the 1-week floor.
        next = this.resizedEnd(before, dir);
      } else {
        // Move the whole booking by ±1 week.
        next = this.movedBy(before, dir);
      }
    }
    if (!next || !this.changed(snapshot, next)) return;

    // Optimistic write, then commit with rollback on failure. `commit` adds
    // resourceId to the payload exactly when it moved, so the reassign travels
    // through the same PUT the drop does.
    this.writeWorking(next);
    this.commit(next, snapshot);
  }

  /**
   * The resource id one lane above (-1) or below (+1) `resourceId` in the
   * rendered roster order, or null when there is no such lane (top/bottom, or the
   * lane is not currently rendered). Reads `rows()` so keyboard reassign lands on
   * the same neighbour the eye sees, including when the roster is filtered.
   */
  private neighbourResourceId(resourceId: string, step: -1 | 1): string | null {
    const ids = this.rows().map(r => r.resourceId);
    const idx = ids.indexOf(resourceId);
    if (idx < 0) return null;
    return ids[idx + step] ?? null;
  }

  // --- preview + commit helpers -------------------------------------------

  /** Apply the in-flight drag's previewed change into the working copy. */
  private applyPreview(d: DragState): void {
    const base = d.before;
    let next: Assignment | null = null;

    if (d.mode === 'move') {
      next = this.movedBy(base, d.weekDelta);
      // Reassign if dropped over a different lane.
      if (next && d.hoverResourceId && d.hoverResourceId !== d.fromResourceId) {
        next = { ...next, resourceId: d.hoverResourceId };
      }
    } else if (d.mode === 'resize-start') {
      next = this.resizedStart(base, d.weekDelta);
    } else {
      next = this.resizedEnd(base, d.weekDelta);
    }
    if (next) this.writeWorking(next);
  }

  /** Resolve a drag on release: commit if changed, otherwise quietly reset. */
  private finishDrag(d: DragState): void {
    const snapshot = d.before;

    // Recompute the final intended assignment from the snapshot + final delta so
    // the committed payload matches exactly what's previewed in the working copy.
    let next: Assignment | null = null;
    if (d.mode === 'move') {
      next = this.movedBy(snapshot, d.weekDelta);
      if (next && d.hoverResourceId && d.hoverResourceId !== d.fromResourceId) {
        next = { ...next, resourceId: d.hoverResourceId };
      }
    } else if (d.mode === 'resize-start') {
      next = this.resizedStart(snapshot, d.weekDelta);
    } else {
      next = this.resizedEnd(snapshot, d.weekDelta);
    }

    this.drag.set(null);

    // No-op drag (no real change): make sure the working copy holds the snapshot
    // and DON'T hit the API.
    if (!next || !this.changed(snapshot, next)) {
      this.writeWorking(snapshot);
      return;
    }

    // Keep the optimistic working-copy change (already applied during preview,
    // but re-assert from the final computed value to be safe) and commit it.
    this.writeWorking(next);
    this.commit(next, snapshot);
  }

  /**
   * PUT the changed assignment. The working copy already holds `next`
   * (optimistic). On success we keep it; on error we restore `snapshot` and
   * surface an error toast. Subscription is torn down with the component.
   */
  private commit(next: Assignment, snapshot: Assignment): void {
    if (!this.isBrowser) return;
    const payload: Partial<Assignment> = {
      startDate: next.startDate,
      endDate: next.endDate,
    };
    // Only include resourceId when it actually moved lanes (a reassign).
    if (next.resourceId !== snapshot.resourceId) {
      payload.resourceId = next.resourceId;
    }

    this.api
      .updateAssignment(next.id, payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: saved => {
          // The server validates/recomputes; fold its canonical record back into
          // the working copy so any server-side adjustment (e.g. clamped dates)
          // is reflected without a full reload.
          this.writeWorking({ ...next, ...saved });
        },
        error: () => {
          // Optimistic update failed — revert and tell the user.
          this.rollback(snapshot);
          this.notify.error(
            `Couldn't save the booking change for ${this.labelFor(snapshot.id)}. Reverted.`,
          );
        },
      });
  }

  /** Replace a single assignment in the working copy by id (immutable update). */
  private writeWorking(next: Assignment): void {
    this.working.update(list => list.map(a => (a.id === next.id ? next : a)));
  }

  /** Restore a single assignment to its pre-change snapshot (rollback). */
  private rollback(snapshot: Assignment): void {
    this.working.update(list => list.map(a => (a.id === snapshot.id ? { ...snapshot } : a)));
  }

  // --- pure date math (ISO; never Date.now) --------------------------------

  /**
   * Shift BOTH dates of a booking by `weeks` whole weeks (preserves duration).
   * Resolves the booking window first (assignment dates, else nothing to move),
   * so the move is well-defined even when the assignment had no own dates.
   */
  private movedBy(base: Assignment, weeks: number): Assignment | null {
    if (weeks === 0) return { ...base };
    const win = this.resolveDates(base);
    if (!win) return null;
    const days = weeks * 7;
    return {
      ...base,
      startDate: addDaysIso(win.start, days),
      endDate: addDaysIso(win.end, days),
    };
  }

  /**
   * Resize by moving the START by `weeks` weeks, clamped so the booking keeps at
   * least a 1-week duration (start can never reach/pass end - MIN_DURATION).
   */
  private resizedStart(base: Assignment, weeks: number): Assignment | null {
    if (weeks === 0) return { ...base };
    const win = this.resolveDates(base);
    if (!win) return null;
    const endMs = Date.parse(win.end);
    let startMs = Date.parse(win.start) + weeks * MS_PER_WEEK;
    // Enforce endDate >= startDate + 1 week (min duration).
    const maxStart = endMs - MIN_DURATION_DAYS * MS_PER_DAY;
    if (startMs > maxStart) startMs = maxStart;
    return { ...base, startDate: isoFromMs(startMs), endDate: win.end };
  }

  /**
   * Resize by moving the END by `weeks` weeks, clamped so the booking keeps at
   * least a 1-week duration (end can never reach/precede start + MIN_DURATION).
   */
  private resizedEnd(base: Assignment, weeks: number): Assignment | null {
    if (weeks === 0) return { ...base };
    const win = this.resolveDates(base);
    if (!win) return null;
    const startMs = Date.parse(win.start);
    let endMs = Date.parse(win.end) + weeks * MS_PER_WEEK;
    // Enforce endDate >= startDate + 1 week (min duration).
    const minEnd = startMs + MIN_DURATION_DAYS * MS_PER_DAY;
    if (endMs < minEnd) endMs = minEnd;
    return { ...base, startDate: win.start, endDate: isoFromMs(endMs) };
  }

  /**
   * The booking's own ISO dates if usable, else its linked request's dates —
   * mirroring the util's `resolveWindow`. We need concrete dates to mutate; if
   * neither pair resolves the booking is not draggable (returns null).
   */
  private resolveDates(a: Assignment): { start: string; end: string } | null {
    const aStart = Date.parse(a.startDate ?? '');
    const aEnd = Date.parse(a.endDate ?? '');
    if (Number.isFinite(aStart) && Number.isFinite(aEnd) && aEnd >= aStart) {
      return { start: a.startDate!, end: a.endDate! };
    }
    const req = this.data.value().requests.find(r => r.id === a.requestId);
    const rStart = Date.parse(req?.startDate ?? '');
    const rEnd = Date.parse(req?.endDate ?? '');
    if (Number.isFinite(rStart) && Number.isFinite(rEnd) && rEnd >= rStart) {
      return { start: isoFromMs(rStart), end: isoFromMs(rEnd) };
    }
    return null;
  }

  /** True iff dates or resource differ between two assignment snapshots. */
  private changed(a: Assignment, b: Assignment): boolean {
    return (
      a.startDate !== b.startDate ||
      a.endDate !== b.endDate ||
      a.resourceId !== b.resourceId
    );
  }

  /** Human label for an assignment (its request name) for toast copy. */
  private labelFor(assignmentId: string): string {
    const a = this.working().find(x => x.id === assignmentId);
    const req = a ? this.data.value().requests.find(r => r.id === a.requestId) : undefined;
    return req?.name ?? 'this booking';
  }

  // --- browser-only geometry helpers --------------------------------------

  /**
   * Measure the rendered px width of one week column. Reads the width of the
   * first week header cell (a real grid track) so the drag's px→week conversion
   * matches the layout exactly. Browser-only; falls back to the rem value.
   */
  private measureWeekColumn(): void {
    if (!this.isBrowser) return;
    const cell = this.host.nativeElement.querySelector<HTMLElement>(
      '.command-schedule-weekhead',
    );
    const w = cell?.getBoundingClientRect().width ?? 0;
    this.weekColPx = w > 0 ? w : this.fallbackWeekColPx();
  }

  /** Parse the `--week-col` rem value against the root font size (browser-only). */
  private fallbackWeekColPx(): number {
    const rem = parseFloat(this.weekColWidth); // '5.5rem' -> 5.5
    const rootPx =
      typeof getComputedStyle === 'function' && typeof document !== 'undefined'
        ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
        : 16;
    return rem * rootPx;
  }

  /**
   * Which resource lane is under the pointer right now (move-reassign target).
   * Walks up from elementFromPoint to the nearest [data-resource-id] track.
   * Browser-only; returns null when over no lane.
   */
  private laneUnderPointer(event: PointerEvent): string | null {
    if (typeof document === 'undefined' || !document.elementFromPoint) return null;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const lane = el?.closest<HTMLElement>('[data-resource-id]');
    return lane?.dataset['resourceId'] ?? null;
  }
}

/**
 * P2-21 — the anchor of "this week", as the USER's week rather than UTC's.
 *
 * `mondayUtcMs(Date.now())` was wrong by a whole week for part of every day:
 * Date.now() carries a time of day, so late on a Sunday evening in a positive
 * offset (or early on a Monday morning in a negative one) its UTC calendar date
 * falls on the other side of the week boundary, and the grid opened on the
 * PREVIOUS (or next) week while the user's own calendar said otherwise.
 *
 * Only the civil date changes; the Monday walk below is still UTC arithmetic.
 * Exported and clock-injectable so the rule is testable without a component.
 */
export function currentWeekAnchorMs(now: () => Date = () => new Date()): number {
  return mondayUtcMs(todayLocalUtcMs(now));
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

/** YYYY-MM-DD for a UTC epoch-ms instant; stable across time zones. */
function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure ISO date arithmetic: parse a YYYY-MM-DD (or full ISO) string to UTC ms,
 * add `days` whole days, and re-format as YYYY-MM-DD. No Date.now; the result
 * depends only on the inputs, so move/resize math is deterministic and SSR-safe.
 */
function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(iso);
  return isoFromMs(ms + days * MS_PER_DAY);
}
