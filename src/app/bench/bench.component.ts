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
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ internalBenchCount() }} on bench &middot; {{ internalBenchPct() | number:'1.0-0' }}% of active</p>
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
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
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
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ subcoBenchCount() }} on bench &middot; {{ subcoBenchPct() | number:'1.0-0' }}% of active</p>
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
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
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

      <!-- An ABSENT percentage is rendered as "n/a", never as 0%: the value is
           absent exactly when the resource has no contracted target for the
           month, and "0% unallocated" would claim they are fully allocated. -->
      <ng-template #unallocatedCell let-row="row">
        @if (unallocatedPctOf(row) !== undefined) {
          <span class="font-mono tabular-nums" [attr.data-test]="'unallocated-pct-' + row.resourceId">{{ unallocatedPctOf(row) | number:'1.0-2' }}%</span>
        } @else {
          <span class="text-[var(--cc-muted)]" [attr.data-test]="'unallocated-pct-' + row.resourceId"
                title="No contracted target for this month, so the unallocated share cannot be computed.">n/a</span>
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
                  <td><span class="command-status" [class.red]="cell.state === 'BENCH'" [class.amber]="cell.state === 'PARTIAL'" [class.green]="cell.state === 'ALLOCATED'">{{ cell.state }}{{ cell.agingBucket ? ' (' + cell.agingBucket + ')' : '' }}</span></td>
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

  readonly internalRows = computed<BenchRow[]>(() => this.rollup().internalRows);
  readonly subcoRows = computed<BenchRow[]>(() => this.rollup().subcoRows);
  readonly hiringDemand = computed(() => this.rollup().hiringDemand);

  readonly internalBenchCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly internalActiveCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly internalBenchPct = computed(() => (this.internalActiveCount() > 0 ? (this.internalBenchCount() / this.internalActiveCount()) * 100 : 0));

  readonly subcoBenchCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly subcoActiveCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly subcoBenchPct = computed(() => (this.subcoActiveCount() > 0 ? (this.subcoBenchCount() / this.subcoActiveCount()) * 100 : 0));

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
