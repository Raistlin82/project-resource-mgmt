import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { forkJoin, map, of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { fteOf, standardMonthlyHours } from '../services/capacity.util';
import {
  EMPTY_BENCH_ROLLUP,
  type AvailabilityDate, type BenchRollup, type BenchRow, type UnallocatedHistory,
} from '../services/bench.util';
import { todayLocalIso } from '../services/local-date.util';
import { ListStateComponent } from '../shared/list-state.component';

interface BenchPageData {
  rollup: BenchRollup;
  hoursPerDay: number;
  holidays: string[];
}

/**
 * Bench / Unchargeable and availability dashboard (Block F, Task 7). Two
 * always-separate sections — Internal and Subcontractors — each with its own
 * "% on bench" figure and never a combined total (design spec: an idle
 * internal gets reallocated, an idle subcontractor does not get renewed and
 * their cost simply stops — the two actions have no common denominator), plus
 * a Hiring Demand table sourced only from dummy placeholders.
 *
 * All figures are gated through one `dataState`-shaped pair (`loading`/
 * `hasError`) computed over the SAME `dataRes` this whole page reads from —
 * mirrors `what-if.ts`'s `dataState()` / `contract-details.ts`'s
 * `moneyFiguresState()` / `reporting.ts`'s `dataLoading`/`dataError`. `loading`
 * explicitly includes `!auth.authReady()` (not just `dataRes.isLoading()`):
 * `authGatedResource`'s stream resolves synchronously to the empty default
 * before readiness, which would otherwise let `loading` go false while the
 * page is still showing the pre-auth empty rollup as if it were a fact.
 */
@Component({
  selector: 'app-bench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgTemplateOutlet, MatIconModule, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Capacity Control</div>
          <h1 class="command-title">Bench</h1>
          <p class="command-subtitle">Unallocated and partially-allocated resources, aging, and the 6-month availability outlook.</p>
        </div>
      </header>

      <app-list-state [loading]="loading()" [error]="hasError()" skeleton="table-rows" [rows]="5" label="bench data" (retry)="reload()">
        <ng-template>
          @if (windowNote()) {
            <p class="text-sm text-[var(--cc-muted)]" data-test="bench-window-note">{{ windowNote() }}</p>
          }
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <section class="command-card overflow-hidden" data-test="internal-section">
              <div class="command-card-header">
                <div>
                  <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Internal</h2>
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ internalBenchCount() }} on bench &middot; {{ internalBenchPct() | number:'1.0-0' }}% of active &middot;
                    <span data-test="internal-away-count" [title]="AWAY_COUNT_HINT">{{ internalAbsentCount() }} away</span></p>
                </div>
                <span class="command-status" [class.red]="internalBenchCount() > 0" [class.green]="internalBenchCount() === 0">{{ internalBenchCount() }}</span>
              </div>
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">Status</th>
                      <th scope="col" class="num">Unallocated</th>
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of internalRows(); track row.resourceId) {
                      <tr>
                        <td><ng-container [ngTemplateOutlet]="nameCell" [ngTemplateOutletContext]="{ row }" /></td>
                        <td><ng-container [ngTemplateOutlet]="stateChip" [ngTemplateOutletContext]="{ state: cellState(row), suffix: agingSuffix(row), key: row.resourceId }" /></td>
                        <td class="num"><ng-container [ngTemplateOutlet]="unallocatedCell" [ngTemplateOutletContext]="{ row }" /></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                      @if (isHistoryOpen(row.resourceId)) {
                        <tr><td colspan="5" class="bg-[var(--cc-surface-muted)]"><ng-container [ngTemplateOutlet]="historyPanel" /></td></tr>
                      }
                    } @empty {
                      <tr><td colspan="5" class="text-center text-[var(--cc-muted)]">No internal resources in the shown window.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            <section class="command-card overflow-hidden" data-test="subco-section">
              <div class="command-card-header">
                <div>
                  <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Subcontractors</h2>
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ subcoBenchCount() }} on bench &middot; {{ subcoBenchPct() | number:'1.0-0' }}% of active &middot;
                    <span data-test="subco-away-count" [title]="AWAY_COUNT_HINT">{{ subcoAbsentCount() }} away</span></p>
                </div>
                <span class="command-status" [class.red]="subcoBenchCount() > 0" [class.green]="subcoBenchCount() === 0">{{ subcoBenchCount() }}</span>
              </div>
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">Status</th>
                      <th scope="col" class="num">Unallocated</th>
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of subcoRows(); track row.resourceId) {
                      <tr>
                        <td><ng-container [ngTemplateOutlet]="nameCell" [ngTemplateOutletContext]="{ row }" /></td>
                        <td><ng-container [ngTemplateOutlet]="stateChip" [ngTemplateOutletContext]="{ state: cellState(row), suffix: agingSuffix(row), key: row.resourceId }" /></td>
                        <td class="num"><ng-container [ngTemplateOutlet]="unallocatedCell" [ngTemplateOutletContext]="{ row }" /></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                      @if (isHistoryOpen(row.resourceId)) {
                        <tr><td colspan="5" class="bg-[var(--cc-surface-muted)]"><ng-container [ngTemplateOutlet]="historyPanel" /></td></tr>
                      }
                    } @empty {
                      <tr><td colspan="5" class="text-center text-[var(--cc-muted)]">No subcontractors in the shown window.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section class="command-card overflow-hidden" data-test="hiring-demand">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Hiring Demand</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Hours still booked on placeholder (dummy) resources, by month and role.</p>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Role</th>
                    <th scope="col" class="num">FTE</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of hiringDemand(); track d.month + d.role) {
                    <tr>
                      <td>{{ d.month }}</td>
                      <td class="text-[var(--cc-muted)]">{{ d.role }}</td>
                      <td class="num font-mono tabular-nums">{{ fteFor(d.month, d.hours) | number:'1.0-2' }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="text-center text-[var(--cc-muted)]">No hiring demand in the shown window.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        </ng-template>
      </app-list-state>

      <!-- Shared row fragments, defined once and used by BOTH sections so the
           Internal and Subcontractor tables cannot drift apart in how they
           present the same three facts. -->
      <ng-template #nameCell let-row="row">
        <button type="button"
                class="flex items-center gap-1 text-left font-semibold text-[var(--cc-ink)] hover:underline"
                (click)="toggleHistory(row.resourceId)"
                [attr.aria-expanded]="isHistoryOpen(row.resourceId)"
                [attr.aria-label]="(isHistoryOpen(row.resourceId) ? 'Hide' : 'Show') + ' monthly unallocated history for ' + row.resourceName"
                [attr.data-test]="'history-toggle-' + row.resourceId">
          <mat-icon class="text-[18px] w-[18px] h-[18px] shrink-0 text-[var(--cc-muted)]">{{ isHistoryOpen(row.resourceId) ? 'expand_more' : 'chevron_right' }}</mat-icon>
          {{ row.resourceName }}
        </button>
      </ng-template>

      <!-- A MISSING percentage is rendered as "n/a", never as 0%: the value is
           absent exactly when the resource has no target for the month, and
           "0% unallocated" would claim they are fully allocated.
           H adds a SECOND reason for a 0 target — a month the person was away
           for entirely (bench.util.ts's own note on BenchCell.unallocatedPct) —
           and noTargetReason() names whichever one applies, because "nobody
           contracted them" and "they were not here" are opposite facts, and one
           tooltip claiming the first for the second is a small lie the reader
           has no way to check. -->
      <ng-template #unallocatedCell let-row="row">
        @if (unallocatedPctOf(row) !== undefined) {
          <span class="font-mono tabular-nums" [attr.data-test]="'unallocated-pct-' + row.resourceId">{{ unallocatedPctOf(row) | number:'1.0-2' }}%</span>
        } @else {
          <span class="text-[var(--cc-muted)]" [attr.data-test]="'unallocated-pct-' + row.resourceId"
                [title]="noTargetReason(row)">n/a</span>
        }
      </ng-template>

      <!-- THE ONE PRESENTATION OF A BENCH STATE ON THIS PAGE — used by both
           section tables AND by the history panel, so /bench cannot render the
           same fact three ways. Three outcomes are kept apart because they are
           three different facts and collapsing any pair is the defect this
           codebase keeps re-paying:
             FREE      — BENCH, the red/amber/green pill with the state spelled out;
             AWAY      — ABSENT, the info tone below;
             NOT KNOWN — no cell in the rollup for this month at all, a grey en
                         dash. It used to render an EMPTY pill, which reads as a
                         rendering bug rather than as "we have nothing for this
                         month", and sat one glance away from ABSENT.

           ABSENT's treatment is COPIED, not invented:
           staffing/availability-strip.component.ts already fixed glyph 'L' (the
           initial of "leave" — 'A' was taken by ALLOCATED) and the label below,
           on tones measured at 6.15:1 light / 7.24:1 dark. Four surfaces
           rendering one state four ways is worse than any one of the four.

           "command-chip is-info" rather than the literal "bg-info-tint
           text-info-text ring-info" the strip carries, and that is a cascade
           fact rather than a preference: those utilities live in Tailwind's
           utilities LAYER while .command-status is UNLAYERED CSS in styles.css,
           and unlayered normal declarations beat layered ones — so the utility
           triplet would sit in the class list, satisfy any class-name
           assertion, and render the accent pill anyway. .command-chip.is-info
           resolves to exactly --color-info-tint / --color-info-text /
           --color-info, is the same pill idiom (styles.css says so where the two
           primitives are defined), and needs no important modifier to win.

           WCAG 1.4.1: colour is never the only signal. The glyph is visible
           text, the state is spelled out beside it, and role="img" plus an
           aria-label give a screen reader the words rather than the letter.

           THE LABEL NAMES NO CAUSE, and that is a privacy requirement (spec
           §7.3), not a style choice: absence reasons are special-category data,
           BenchCell cannot carry one and /bench/monthly does not transmit one.
           Do not add a field to pass it in. -->
      <ng-template #stateChip let-state="state" let-suffix="suffix" let-key="key">
        @switch (state) {
          @case ('ABSENT') {
            <span class="command-chip is-info" [attr.data-test]="'state-' + key"
                  role="img" [attr.aria-label]="ABSENT_LABEL" [title]="ABSENT_LABEL">
              <span aria-hidden="true" class="font-bold">{{ ABSENT_GLYPH }}</span> ABSENT
            </span>
          }
          @case ('') {
            <span class="command-chip is-neutral" [attr.data-test]="'state-' + key"
                  role="img" [attr.aria-label]="UNTRACKED_LABEL" [title]="UNTRACKED_LABEL">{{ UNTRACKED_GLYPH }}</span>
          }
          @default {
            <span class="command-status" [attr.data-test]="'state-' + key"
                  [class.red]="state === 'BENCH'" [class.amber]="state === 'PARTIAL'" [class.green]="state === 'ALLOCATED'">{{ state }}{{ suffix }}</span>
          }
        }
      </ng-template>

      <!-- The four history states are kept apart on purpose: loading, failed,
           tracked-but-empty and populated all read differently. Collapsing any
           pair is the defect this codebase keeps re-fixing — an empty history
           must never stand in for a failed read, and neither may pass for
           "allocated the whole time". The error branch precedes any read of
           historyCells(), which is what keeps a failed read from being
           silently rewritten as an empty one. -->
      <ng-template #historyPanel>
        @if (historyLoading()) {
          <p class="flex items-center gap-1.5 py-2 text-sm text-[var(--cc-muted)]" role="status" aria-busy="true" data-test="history-loading">
            <mat-icon class="text-[16px] w-[16px] h-[16px] shrink-0">schedule</mat-icon>
            Loading monthly history&hellip;
          </p>
        } @else if (historyError()) {
          <p class="flex flex-wrap items-center gap-2 py-2 text-sm text-critical-text" role="alert" data-test="history-error">
            <mat-icon class="text-[16px] w-[16px] h-[16px] shrink-0">warning_amber</mat-icon>
            Couldn't load the monthly unallocated history.
            <button type="button" class="command-button secondary" (click)="reloadHistory()" data-test="history-retry">Retry</button>
          </p>
        } @else if (historyCells().length === 0) {
          <p class="py-2 text-sm text-[var(--cc-muted)]" data-test="history-untracked">
            No tracked months in the last {{ historyMonths }} months for this resource.
          </p>
        } @else {
          <table class="command-data-table" data-test="history-table">
            <caption class="sr-only">Monthly unallocated history for the last {{ historyMonths }} months</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Status</th>
                <th scope="col" class="num">Unallocated days</th>
                <th scope="col" class="num">Unallocated</th>
              </tr>
            </thead>
            <tbody>
              @for (cell of historyCells(); track cell.month) {
                <tr [attr.data-test]="'history-row-' + cell.month">
                  <td class="font-mono tabular-nums">{{ monthLabel(cell.month) }}</td>
                  <td><ng-container [ngTemplateOutlet]="stateChip" [ngTemplateOutletContext]="{ state: cell.state, suffix: cell.agingBucket ? ' (' + cell.agingBucket + ')' : '', key: cell.month }" /></td>
                  <td class="num font-mono tabular-nums">{{ cell.unallocatedDays !== undefined ? (cell.unallocatedDays | number:'1.0-2') : 'n/a' }}</td>
                  <td class="num font-mono tabular-nums">{{ cell.unallocatedPct !== undefined ? (cell.unallocatedPct | number:'1.0-2') + '%' : 'n/a' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </ng-template>
    </div>
  `,
})
export class BenchComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  /**
   * ABSENT's canonical presentation, transcribed from `staffing/
   * availability-strip.component.ts` — the one surface that already shipped it —
   * so /bench and /staffing name the same state with the same word. 'L' for
   * leave, because 'A' was already ALLOCATED's initial. The label deliberately
   * names NO cause (spec §7.3).
   */
  protected readonly ABSENT_GLYPH = 'L';
  protected readonly ABSENT_LABEL = 'Away (on leave) — not staffable';
  /** En dash, not em: the same character and the same words the strip uses for a
   *  month the rollup simply does not cover. */
  protected readonly UNTRACKED_GLYPH = '–';
  protected readonly UNTRACKED_LABEL = 'No bench state for this month (not tracked)';
  /**
   * Why the away count sits beside the percentage rather than instead of it.
   * Q3 (spec §10) put an absent person OUT of the numerator and left them IN the
   * denominator, so the figure only ever falls — but the denominator now contains
   * people nobody could have staffed, and a percentage whose denominator you
   * cannot see is harder to defend, not easier. This is the number that makes it
   * checkable.
   */
  protected readonly AWAY_COUNT_HINT =
    'Away (on leave) this month. Not counted on bench, but still counted in the "% of active" '
    + 'denominator — so the percentage falls while somebody is away, and this is the figure that says by how much.';

  private static readonly EMPTY: BenchPageData = { rollup: EMPTY_BENCH_ROLLUP, hoursPerDay: 8, holidays: [] };
  private static readonly DATE_FMT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  private readonly dataRes = authGatedResource<BenchPageData>(
    () => forkJoin({
      rollup: this.api.getBenchMonthly(),
      hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
      holidays: this.api.getHolidays().pipe(map(hs => hs.map(h => h.id))),
    }),
    BenchComponent.EMPTY,
  );

  // Explicitly folds in !authReady() rather than trusting isLoading() alone —
  // see the class doc comment; this is the same shape as reporting.ts's
  // `dataLoading`/`dataError` pair, computed over the one shared `dataRes`.
  readonly loading = computed(() => !this.auth.authReady() || this.dataRes.isLoading());
  readonly hasError = computed(() => this.dataRes.status() === 'error');
  reload(): void { this.dataRes.reload(); }

  private readonly rollup = computed(() => this.dataRes.value().rollup);

  /**
   * The month whose cells the Status / Freeing up / Available columns describe:
   * TODAY's month, and only if the fetched window actually contains it.
   *
   * It used to be `months[0]`, but the server anchors the bench window on the OLDEST
   * Open planning period — four months in the past with the shipped seed — so every
   * present-tense figure on this page described a four-month-old snapshot with nothing
   * saying so: somebody booked solid for the next two months read "BENCH (D)" in red,
   * "Available: today", and counted toward the "% of active on bench" a delivery
   * executive reallocates against.
   *
   * The month comes from `todayLocalIso()` — the repo's one clock helper — NOT from
   * `new Date().toISOString()`, which names the previous month for anyone east of UTC
   * during the first hours of the 1st and the next month for anyone west of it on the
   * last evening. When the window genuinely excludes the present, `''` selects the
   * existing empty state (no state, no aging suffix, zero counts, guarded
   * percentages) and {@link windowNote} says so instead of leaving a blank column
   * that reads as missing data.
   */
  private readonly currentMonth = computed(() => {
    const now = todayLocalIso().slice(0, 7);
    return this.rollup().months.includes(now) ? now : '';
  });

  /**
   * Names the month the present-tense columns describe — or, when the fetched window
   * has no present tense at all, says that explicitly and names the window's bounds.
   * A window that legitimately excludes today must announce it; that is the whole
   * difference between "nobody is on the bench" and "we are not looking at now".
   */
  readonly windowNote = computed<string>(() => {
    const months = this.rollup().months;
    if (months.length === 0) return '';
    const shown = this.currentMonth();
    if (shown) return `Status shown for ${this.monthLabel(shown)}.`;
    return `This window (${this.monthLabel(months[0])} – ${this.monthLabel(months[months.length - 1])}) `
      + `does not include the current month (${this.monthLabel(todayLocalIso().slice(0, 7))}), so no current status is shown.`;
  });

  monthLabel(month: string): string {
    return BenchComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  // --- Monthly unallocated history (RPT comparison row 51) -------------------

  /**
   * How many months of history to ask for. Sent EXPLICITLY rather than relying on
   * the server's own default, so the "No tracked months in the last N months" copy
   * names the span actually requested instead of a number duplicated on both sides
   * that could silently drift apart. The server refuses anything above 24.
   */
  readonly historyMonths = 12;

  /** The one expanded row, or '' for none — an accordion, so expanding a row cannot
   *  leave a dozen per-resource reads in flight at once. */
  private readonly openHistoryFor = signal('');

  isHistoryOpen(resourceId: string): boolean { return this.openHistoryFor() === resourceId; }
  toggleHistory(resourceId: string): void {
    this.openHistoryFor.update(open => (open === resourceId ? '' : resourceId));
  }

  private static readonly EMPTY_HISTORY: UnallocatedHistory = { resourceId: '', resourceName: '', cells: [] };

  /**
   * Keyed on `authReady` AND the expanded row (the house `rxResource` shape, cf.
   * `integrations.component.ts`'s outbox): a principal-gated read must not fire
   * before OIDC bootstrap settles, and with no row open the stream resolves to the
   * empty default synchronously rather than calling the API at all.
   */
  private readonly historyRes = rxResource<UnallocatedHistory, { ready: boolean; resourceId: string }>({
    params: () => ({ ready: this.auth.authReady(), resourceId: this.openHistoryFor() }),
    stream: ({ params }) => (params.ready && params.resourceId !== ''
      ? this.api.getUnallocatedHistory(params.resourceId, this.historyMonths)
      : of(BenchComponent.EMPTY_HISTORY)),
    defaultValue: BenchComponent.EMPTY_HISTORY,
  });

  readonly historyLoading = computed(() => this.historyRes.isLoading());
  readonly historyError = computed(() => this.historyRes.status() === 'error');
  /** Only ever read from the template's LAST branch, after `historyError()` has been
   *  ruled out — an errored resource's `value()` throws, and turning that throw into
   *  an empty list is exactly how a failed read starts looking like good news. */
  readonly historyCells = computed(() => this.historyRes.value().cells);
  reloadHistory(): void { this.historyRes.reload(); }

  /**
   * The current month's unallocated share for a row, or `undefined` when the rollup
   * has no answer (no contracted target that month) — NOT 0, which would read as
   * "fully allocated". Also undefined when the row has no cell for the current
   * month at all, the same case {@link cellState} renders as blank.
   */
  unallocatedPctOf(row: BenchRow): number | undefined {
    return row.monthly[this.currentMonth()]?.unallocatedPct;
  }

  /**
   * Which of the TWO reasons a share is unanswerable applies to this row, for the
   * "n/a" cell's tooltip. `bench.util.ts` documents both on
   * `BenchCell.unallocatedPct`: no contracted target at all, or (H) a month spent
   * entirely away, in which case none of it was staffable and "how much of it is
   * unfilled" has no answer. Naming the wrong one would be a claim the reader
   * cannot check — and the away case is now the more common of the two.
   */
  noTargetReason(row: BenchRow): string {
    return this.cellState(row) === 'ABSENT'
      ? 'Away for the whole month, so there was no staffable target to take a share of.'
      : 'No contracted target for this month, so the unallocated share cannot be computed.';
  }

  readonly internalRows = computed<BenchRow[]>(() => this.rollup().internalRows);
  readonly subcoRows = computed<BenchRow[]>(() => this.rollup().subcoRows);
  readonly hiringDemand = computed(() => this.rollup().hiringDemand);

  /**
   * The two "% on bench" figures, under product decision Q3 (spec §10): somebody
   * away is OUT of the numerator and IN the denominator.
   *
   * NEITHER line below changes for that, and the fact that they do not is the
   * whole argument for 'ABSENT' being a fourth STATE rather than a flag beside a
   * three-valued one (spec §4.3):
   *   - the numerator tests `state === 'BENCH'`, which an `'ABSENT'` cell simply
   *     is not, so it drops out by itself — the headline correction;
   *   - the denominator tests that a cell EXISTS, and `benchRollup` deliberately
   *     still emits a cell for a fully-away month (B11: disappearing "would put
   *     her back among the missing data"), so she stays counted as active.
   * The correction is therefore monodirectional — the percentage can only fall —
   * which is what makes it explainable. A boolean flag beside a 3-valued state
   * would have left both lines silently unchanged AND wrong: the signature of C1.
   *
   * Because nothing here moved, only a DIFFERENTIAL test can show the decision is
   * implemented at all: the same fixture, with the away rows kept in and taken out
   * of the denominator, has to disagree. That test is in the spec beside this
   * file; asserting 20% on its own would pass under either rule.
   */
  readonly internalBenchCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly internalActiveCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly internalBenchPct = computed(() => (this.internalActiveCount() > 0 ? (this.internalBenchCount() / this.internalActiveCount()) * 100 : 0));

  readonly subcoBenchCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly subcoActiveCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly subcoBenchPct = computed(() => (this.subcoActiveCount() > 0 ? (this.subcoBenchCount() / this.subcoActiveCount()) * 100 : 0));

  /**
   * The count Q3 makes MANDATORY beside each percentage — see {@link AWAY_COUNT_HINT}.
   *
   * DERIVED from the rows, never read from the payload. `BenchRollup` gains no
   * total for this on purpose (`bench.util.ts`'s note on `EMPTY_BENCH_ROLLUP`):
   * a second number that can disagree with the first is worse than no number, and
   * four states make the count derivable by any consumer.
   */
  readonly internalAbsentCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()]?.state === 'ABSENT').length);
  readonly subcoAbsentCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()]?.state === 'ABSENT').length);

  cellState(row: BenchRow): string {
    return row.monthly[this.currentMonth()]?.state ?? '';
  }
  agingSuffix(row: BenchRow): string {
    const bucket = row.monthly[this.currentMonth()]?.agingBucket;
    return bucket ? ` (${bucket})` : '';
  }
  /**
   * Forward-looking "about to free up" signal for the CURRENT month's cell.
   * Deliberately independent of `row.availabilityDate` (see `availabilityLabel`)
   * — a row can legitimately show "Beyond <month>" (never bench within the 6
   * shown months) while ALSO being flagged here (the look-ahead 7th month, not
   * part of the display window, is bench). Both are correct simultaneously;
   * this method never reads `availabilityDate` and so can never suppress one
   * signal based on the other.
   */
  isFreeingUp(row: BenchRow): boolean {
    return row.monthly[this.currentMonth()]?.upcomingUnallocated ?? false;
  }
  /**
   * Never blank (design spec): a free-now cell shows today's date, a
   * beyond-the-horizon cell says so explicitly — a blank cell would read as
   * "missing data" and hide exactly the people who need reallocating.
   */
  availabilityLabel(a: AvailabilityDate): string {
    return a.kind === 'date'
      ? BenchComponent.DATE_FMT.format(new Date(a.date + 'T00:00:00Z'))
      : `Beyond ${BenchComponent.MONTH_FMT.format(new Date(a.horizonEndMonth + '-01T00:00:00Z'))}`;
  }
  /** FTE conversion is a rendering-only step — `hours` stays raw upstream. */
  fteFor(month: string, hours: number): number {
    const holSet = new Set(this.dataRes.value().holidays);
    return fteOf(hours, standardMonthlyHours(month, this.dataRes.value().hoursPerDay, holSet));
  }
}
