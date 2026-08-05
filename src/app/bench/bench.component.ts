import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { forkJoin, map } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { fteOf, standardMonthlyHours } from '../services/capacity.util';
import { EMPTY_BENCH_ROLLUP, type AvailabilityDate, type BenchRollup, type BenchRow } from '../services/bench.util';
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
  imports: [DecimalPipe, ListStateComponent],
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
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of internalRows(); track row.resourceId) {
                      <tr>
                        <td class="font-semibold text-[var(--cc-ink)]">{{ row.resourceName }}</td>
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="text-center text-[var(--cc-muted)]">No internal resources in the shown window.</td></tr>
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
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of subcoRows(); track row.resourceId) {
                      <tr>
                        <td class="font-semibold text-[var(--cc-ink)]">{{ row.resourceName }}</td>
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="text-center text-[var(--cc-muted)]">No subcontractors in the shown window.</td></tr>
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
  private readonly currentMonth = computed(() => this.rollup().months[0] ?? '');
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
