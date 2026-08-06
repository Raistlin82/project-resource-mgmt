import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { forkJoin, of, map } from 'rxjs';
import { ApiService, Resource, ResourceRequest, Project } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { todayLocalIso } from '../services/local-date.util';
import {
  ForecastData,
  CapacityPeriod,
  SkillGapEntry,
  UtilizationBand,
  capacityForecast,
  forecastUtilizationBand,
  skillGap,
  isCompleteForecastWindow,
  utilizationChangeTone,
} from '../services/forecast.util';
import { notFullyAllocatedAt } from '../services/bench.util';
import { DEFAULT_HOURS_PER_DAY } from '../services/sell-rate.util';
import {
  CommandBarChartComponent,
  CommandTrendChartComponent,
  BarSeries,
  TrendSeries,
} from '../shared/charts';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { ListStateComponent } from '../shared/list-state.component';

/** Rolling horizon (weeks) for the sandbox forecast. Fixed: this is a comparison, not a tuning, surface. */
const HORIZON_WEEKS = 12;

/**
 * A single headline metric compared base-vs-scenario, with a signed delta.
 *
 * `base`/`scenario`/`delta` are nullable because Avg Utilization can be
 * UNANSWERABLE: with no supply in any period of the horizon there is no
 * utilisation to average, and a 0% there would be a confident claim of idleness
 * where the honest answer is "no capacity to measure". A null side renders "n/a"
 * and carries NO tone (see `deltaIsGood`/`deltaIsBad`) — colouring a comparison
 * against an unknown baseline is the same defect as the header badge that used
 * to affirm parity it could not know.
 */
interface KpiDelta {
  label: string;
  /** Short explanation of what the number means. */
  note: string;
  base: number | null;
  scenario: number | null;
  /** scenario − base, or null when either side is unknown. */
  delta: number | null;
  /** How to render the value (percent vs plain count) and how to colour the delta. */
  format: 'pct' | 'count';
  /** Direction that should read as "good" (green). 'down' ⇒ lower is better. */
  better: 'up' | 'down';
}

/** One scenario timeline row: scenario capacity figures plus the delta vs base demand. */
interface TimelineRow {
  /** Short label for the period start (e.g. "12 May"). */
  label: string;
  supply: number;
  demand: number;
  /** null when the scenario period has no supply — rendered "n/a", never 0%. */
  utilizationPct: number | null;
  /** Scenario demand − base demand for the same period (hours). */
  demandDelta: number;
  /** Committed-demand hours for the period (scenario). */
  committed: number;
  /** Pipeline-demand hours for the period (scenario). */
  pipeline: number;
  /** Utilisation band driving the cell colour (`forecastUtilizationBand`). */
  band: UtilizationBand;
}

/**
 * What-If — a CLIENT-ONLY capacity scenario sandbox.
 *
 * Loads resources / requests / assignments once into an immutable BASE, then keeps
 * a writable SCENARIO (a deep copy, seeded from the base via `linkedSignal` so it
 * re-seeds whenever the base reloads). Three levers mutate only the in-memory
 * scenario — nothing is ever persisted:
 *
 *   • Win deal     — append a synthetic open ResourceRequest (new pipeline demand).
 *   • Hire         — append N synthetic Resources with capacity + one skill (new supply).
 *   • Slip project — shift a project's requests' start/end by W weeks (re-timed demand).
 *
 * `capacityForecast`, `skillGap` and `notFullyAllocatedAt` (bench.util.ts — the
 * pure Block F layer, NOT the retired `Resource.utilization` heuristic) are
 * recomputed on BOTH the base and the scenario and shown as side-by-side delta
 * KPIs plus a scenario capacity timeline. Recomputing bench on the scenario is
 * exactly what makes a lever's effect on bench figures VISIBLE here — the base
 * loads once from the server, but every lever (`hire`, `winDeal`, `slipProject`)
 * mutates only `scenario`, and `scenarioBenchCount` reads `this.scenario()`, so a
 * hire with no bookings shows up as bench in the scenario figure immediately,
 * without a round trip. "Reset scenario" re-seeds the scenario from the base,
 * discarding all changes.
 */
@Component({
  selector: 'app-what-if',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ReactiveFormsModule, CommandBarChartComponent, CommandTrendChartComponent, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Capacity Control</div>
          <h1 class="command-title">What-If Scenario Sandbox</h1>
          <p class="command-subtitle">
            Model deals, hires and slips against live capacity without touching any data. Every
            change is in-memory only; compare the {{ horizonWeeks }}-week outlook against today's
            baseline and reset whenever you like.
          </p>
        </div>
        <div class="flex flex-col items-stretch gap-2 sm:items-end">
          <span class="command-section-label">Scenario</span>
          <div class="flex items-center gap-2">
            <!--
              CRITICAL FIX (round 1 review): this badge/button sit OUTSIDE the
              body's loading/error gate below, so they used to render even when
              dataRes had errored — and with baseData() falling back to an empty
              stand-in, dirty() read false/false and showed a green "Matches
              baseline" (parity affirmed) when no baseline had actually loaded
              (parity unknown). Gated on the SAME dataState() the body uses
              (mirrors contract-details.ts's moneyFiguresState() /
              billing.ts's financialDataError()/financialDataLoading()): dirty()
              and changeCount() are only read once dataState() is 'ready', so
              they never compute over the synthetic empty baseline in the
              first place.
            -->
            @if (dataState() === 'error') {
              <span class="command-status" role="status">Unavailable</span>
            } @else if (dataState() === 'loading') {
              <span class="command-status" aria-busy="true">Loading&hellip;</span>
            } @else if (dirty()) {
              <span class="command-status amber">{{ changeCount() }} change{{ changeCount() === 1 ? '' : 's' }}</span>
            } @else {
              <span class="command-status green">Matches baseline</span>
            }
            <button
              type="button"
              class="command-button secondary"
              [disabled]="dataState() !== 'ready' || !dirty()"
              (click)="resetScenario()">
              Reset scenario
            </button>
          </div>
        </div>
      </header>

      <app-list-state [loading]="dataState() === 'loading'" [error]="dataState() === 'error'"
                      label="what-if data" (retry)="reloadData()">
        <ng-template>
        @if (!hasData()) {
          <div class="command-card">
            <div class="command-empty">
              <div class="command-empty-title">No capacity data yet</div>
              <p class="command-empty-note">
                Add resources with capacity, then create resource requests and assignments to model
                what-if scenarios against a baseline.
              </p>
            </div>
          </div>
        } @else {
        <!-- Delta KPI strip -->
        <section class="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 xl:grid-cols-4" aria-label="Scenario versus baseline metrics">
          @for (k of kpis(); track k.label) {
            <div class="command-kpi"
                 [class.green]="deltaIsGood(k)"
                 [class.danger]="deltaIsBad(k)">
              <p class="command-kpi-label">{{ k.label }}</p>
              <p class="command-kpi-value">{{ formatMetric(k, k.scenario) }}</p>
              <p class="command-kpi-note">
                <span class="font-mono tabular-nums">{{ deltaText(k) }}</span>
                vs base {{ formatMetric(k, k.base) }}
                <span class="block">{{ k.note }}</span>
              </p>
            </div>
          }
        </section>

        <!-- Levers -->
        <section class="grid grid-cols-1 gap-6 xl:grid-cols-3" aria-label="Scenario controls">
          <!-- Win deal -->
          <form class="command-card flex flex-col" [formGroup]="dealForm" (ngSubmit)="winDeal()">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Win deal</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Add an open request to the pipeline.</p>
              </div>
            </div>
            <div class="space-y-4 p-5">
              <div>
                <label for="dealRole" class="block text-sm font-semibold text-ink-secondary mb-1.5">Required role *</label>
                <input id="dealRole" type="text" formControlName="requiredRole" class="command-input" placeholder="e.g. Senior Developer">
              </div>
              <div>
                <label for="dealEffort" class="block text-sm font-semibold text-ink-secondary mb-1.5">Required effort (h) *</label>
                <input id="dealEffort" type="number" min="1" formControlName="requiredEffort" class="command-input" placeholder="e.g. 320">
              </div>
              <div>
                <label for="dealSkills" class="block text-sm font-semibold text-ink-secondary mb-1.5">Skills (comma-separated)</label>
                <input id="dealSkills" type="text" formControlName="skills" class="command-input" placeholder="e.g. Java, AWS, Kafka">
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label for="dealStart" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start *</label>
                  <input id="dealStart" type="date" formControlName="startDate" class="command-input">
                </div>
                <div>
                  <label for="dealEnd" class="block text-sm font-semibold text-ink-secondary mb-1.5">End *</label>
                  <input id="dealEnd" type="date" formControlName="endDate" class="command-input">
                </div>
              </div>
              @if ((dealForm.controls.startDate.touched || dealForm.controls.endDate.touched) && dealForm.hasError('invalidDateWindow')) {
                <p role="alert" class="text-xs text-critical-text">Enter a complete date range with end on or after start.</p>
              }
            </div>
            <div class="mt-auto flex justify-end border-t border-[var(--cc-line)] p-4">
              <button type="submit" class="command-button" [disabled]="dealForm.invalid">Add deal</button>
            </div>
          </form>

          <!-- Hire -->
          <form class="command-card flex flex-col" [formGroup]="hireForm" (ngSubmit)="hire()">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Hire</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Add resources with spare capacity.</p>
              </div>
            </div>
            <div class="space-y-4 p-5">
              <div>
                <label for="hireRole" class="block text-sm font-semibold text-ink-secondary mb-1.5">Role *</label>
                <input id="hireRole" type="text" formControlName="role" class="command-input" placeholder="e.g. Developer">
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label for="hireCount" class="block text-sm font-semibold text-ink-secondary mb-1.5">Headcount *</label>
                  <input id="hireCount" type="number" min="1" max="50" formControlName="count" class="command-input" placeholder="e.g. 3">
                </div>
                <div>
                  <label for="hireCapacity" class="block text-sm font-semibold text-ink-secondary mb-1.5">Capacity (h/wk) *</label>
                  <input id="hireCapacity" type="number" min="1" formControlName="capacity" class="command-input" placeholder="e.g. 40">
                </div>
              </div>
              <div>
                <label for="hireSkill" class="block text-sm font-semibold text-ink-secondary mb-1.5">Skill</label>
                <input id="hireSkill" type="text" formControlName="skill" class="command-input" placeholder="e.g. Java">
              </div>
            </div>
            <div class="mt-auto flex justify-end border-t border-[var(--cc-line)] p-4">
              <button type="submit" class="command-button" [disabled]="hireForm.invalid">Add hires</button>
            </div>
          </form>

          <!-- Slip project -->
          <form class="command-card flex flex-col" [formGroup]="slipForm" (ngSubmit)="slipProject()">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Slip project</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Shift a project's request dates.</p>
              </div>
            </div>
            <div class="space-y-4 p-5">
              <div>
                <label for="slipProjectId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project *</label>
                <select id="slipProjectId" formControlName="projectId" class="command-select">
                  <option value="">Select a project…</option>
                  @for (p of slippableProjects(); track p.id) {
                    <option [value]="p.id">{{ p.name }} ({{ requestCountFor(p.id) }} req)</option>
                  }
                </select>
                @if (!slippableProjects().length) {
                  <p class="mt-1.5 text-xs text-[var(--cc-muted)]">No projects have dated requests to shift.</p>
                }
              </div>
              <div>
                <label for="slipWeeks" class="block text-sm font-semibold text-ink-secondary mb-1.5">Shift by (weeks) *</label>
                <input id="slipWeeks" type="number" formControlName="weeks" class="command-input" placeholder="e.g. 4 (negative pulls in)">
                <p class="mt-1.5 text-xs text-[var(--cc-muted)]">Positive delays the project; negative pulls it earlier.</p>
              </div>
            </div>
            <div class="mt-auto flex justify-end border-t border-[var(--cc-line)] p-4">
              <button type="submit" class="command-button" [disabled]="slipForm.invalid">Apply slip</button>
            </div>
          </form>
        </section>

        <!-- Scenario capacity timeline -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Scenario Capacity Timeline</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">
                Weekly supply versus demand under the scenario, with the demand delta against baseline.
              </p>
            </div>
          </div>

          <!-- Scenario supply vs the committed + pipeline demand STACK, per week. Same
               wiring as /forecast: Supply is an [overlay], never a [series] entry, because
               [stacked] stacks every series and a stacked Supply would be added on top of
               the demand it is the yardstick for. The overlay still widens the y-domain, so
               a scenario that hires capacity above the stack raises the axis instead of
               drawing a flat clipped line along the top gridline — which is exactly the
               lever this screen exists to evaluate. -->
          <div class="px-5 pt-4">
            <command-bar-chart
              [categories]="weekLabels()"
              [series]="scenarioDemandSeries()"
              [overlay]="scenarioSupplyOverlay()"
              [stacked]="true"
              [height]="300"
              formatKind="number"
              ariaLabel="Scenario supply versus committed and pipeline demand by week"
              caption="Scenario weekly supply, committed and pipeline demand in hours" />
          </div>

          <!-- Base vs scenario demand trend, so the scenario's demand delta reads at a glance. -->
          <div class="px-5 pb-2">
            <command-trend-chart
              [categories]="weekLabels()"
              [series]="demandTrendSeries()"
              mode="line" [smooth]="true"
              formatKind="number"
              ariaLabel="Baseline versus scenario weekly demand"
              caption="Baseline versus scenario weekly demand in hours" />
          </div>

          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col" class="num">Supply</th>
                  <th scope="col" class="num">Demand</th>
                  <th scope="col" class="num">Util %</th>
                  <th scope="col" class="num">Δ Demand</th>
                </tr>
              </thead>
              <tbody>
                @for (row of timeline(); track row.label) {
                  <tr>
                    <td class="font-mono whitespace-nowrap">{{ row.label }}</td>
                    <td class="num">{{ row.supply | number: '1.0-0' }}</td>
                    <td class="num">{{ row.demand | number: '1.0-0' }}</td>
                    <!-- Same 'forecastUtilizationBand' as /forecast: the two Capacity
                         Control screens must not encode two different opinions about
                         what a healthy week looks like. 'spare' (below healthy) is
                         amber, and a period with no supply renders "n/a" untinted. -->
                    <td class="num">
                      <span class="command-status"
                            [class.green]="row.band === 'healthy'"
                            [class.amber]="row.band === 'spare'"
                            [class.red]="row.band === 'over'">
                        @if (row.utilizationPct === null) { n/a } @else { {{ row.utilizationPct | number: '1.0-0' }}% }
                      </span>
                    </td>
                    <!-- --cc-red-text, not --cc-red: a 14px delta is small text, so the
                         AA floor is 4.5:1 and the raw fill tone reads 4.47:1 on the dark
                         surface. The green branch beside it already uses the -text
                         shade; a signed pair has to be measured on the same footing. -->
                    <td class="num font-semibold"
                        [style.color]="row.demandDelta > 0 ? 'var(--cc-red-text)' : (row.demandDelta < 0 ? 'var(--cc-green-text)' : 'var(--cc-muted)')">
                      {{ row.demandDelta > 0 ? '+' : '' }}{{ row.demandDelta | number: '1.0-0' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- Skill gap: base vs scenario -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Skill Coverage — Base vs Scenario</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">
                Open-request demand against covering resources. Rows present in either view are shown.
              </p>
            </div>
            <span class="command-status"
                  [class.red]="scenarioShortages() > baseShortages()"
                  [class.green]="scenarioShortages() < baseShortages()">
              {{ scenarioShortages() }} shortage{{ scenarioShortages() === 1 ? '' : 's' }}
              <span aria-hidden="true">·</span>
              base {{ baseShortages() }}
            </span>
          </div>
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col" class="num">Base demand (h)</th>
                  <th scope="col" class="num">Scenario demand (h)</th>
                  <th scope="col" class="num">Base covered by</th>
                  <th scope="col" class="num">Scenario covered by</th>
                  <th scope="col">Scenario status</th>
                </tr>
              </thead>
              <tbody>
                @for (row of skillRows(); track row.skill) {
                  <tr>
                    <td class="font-semibold text-[var(--cc-ink)]">{{ row.skill }}</td>
                    <td class="num">{{ row.baseDemandHours | number: '1.0-0' }}</td>
                    <td class="num">{{ row.scenarioDemandHours | number: '1.0-0' }}</td>
                    <td class="num">{{ row.baseSupplyCount }}</td>
                    <td class="num">{{ row.scenarioSupplyCount }}</td>
                    <td>
                      <span class="command-status"
                            [class.red]="row.scenarioShortage"
                            [class.amber]="!row.scenarioShortage && row.scenarioThin"
                            [class.green]="!row.scenarioShortage && !row.scenarioThin">
                        {{ row.scenarioShortage ? 'No coverage' : (row.scenarioThin ? 'Thin' : 'Covered') }}
                      </span>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="6" class="text-center text-[var(--cc-muted)]">No open requests demand specific skills.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
        }
        </ng-template>
      </app-list-state>
    </div>
  `,
})
export class WhatIf {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  /** Fixed comparison horizon, in weeks. */
  readonly horizonWeeks = HORIZON_WEEKS;

  /** Monotonic counter for synthetic, client-only entity ids (never sent to the server). */
  private syntheticSeq = 0;

  // --- BASE: loaded once, treated as immutable -------------------------------

  private static readonly EMPTY_DATA: ForecastData = {
    resources: [], requests: [], assignments: [], assignmentDays: [], assignmentMonths: [], holidays: [], hoursPerDay: DEFAULT_HOURS_PER_DAY,
  };

  // resources is principal-gated server-side: key the forkJoin on auth readiness
  // so it fires only AFTER the OAuth bootstrap has settled and the bearer token is
  // attached; firing earlier (e.g. on a reload/deep-link) sent an unauthenticated
  // request that 401'd and forkJoin's fail-fast collapsed the baseline to empty.
  // `protected` (not `private`): the template reads `dataRes.status()`/`.reload()`
  // directly for the error-state branch, per this repo's established pattern.
  protected readonly dataRes = rxResource<ForecastData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            requests: this.api.getRequests(),
            assignments: this.api.getAssignments(),
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            holidays: this.api.getHolidays(),
            hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
          })
        : of<ForecastData>(WhatIf.EMPTY_DATA),
    defaultValue: WhatIf.EMPTY_DATA,
  });

  private readonly projectsRes = authGatedResource<Project[]>(() => this.api.getProjects(), []);

  /**
   * The ONE gate every scenario-derived figure — the header's dirty()/
   * changeCount() badge and Reset button, AND the body — must check before
   * rendering, mirroring `contract-details.ts`'s `moneyFiguresState()` /
   * `billing.ts`'s `financialDataError()`+`financialDataLoading()` shape.
   * `!authReady()` counts as 'loading', NOT as ready-and-empty: pre-authReady
   * `dataRes`/`projectsRes` resolve SUCCESSFULLY with their empty defaults
   * (that's how the auth-gated `forkJoin`/`authGatedResource` pattern avoids
   * an unauthenticated request), so treating that as 'ready' would render a
   * confident "no data"/"matches baseline" for a baseline that was never
   * actually loaded yet — the same P1-10-shaped defect this repo has shipped
   * (and fixed) twice this week, just for a different trigger (auth timing
   * instead of a failed read).
   *
   * ROUND-1 FIX: previously only `baseData()` guarded against the error state
   * (falling back to an empty stand-in so `.value()` wouldn't throw), and the
   * header's `dirty()`/`changeCount()` read that empty stand-in UNGATED —
   * "0 resources vs 0 resources" computed to `dirty() === false`, so an
   * errored read rendered a green "Matches baseline" badge next to the "Couldn't
   * load" retry card: parity affirmed as fact when parity is actually unknown.
   * The fix is not a better fallback value — it is never COMPUTING dirty()/
   * changeCount() at all outside the 'ready' state (see the template's header
   * block and `resetScenario`'s disabled binding).
   */
  protected readonly dataState = computed<'error' | 'loading' | 'ready'>(() => {
    if (this.dataRes.status() === 'error' || this.projectsRes.status() === 'error') return 'error';
    if (!this.auth.authReady() || this.dataRes.isLoading() || this.projectsRes.isLoading()) return 'loading';
    return 'ready';
  });

  /** Reloads every input `dataState()` depends on — the header/body Retry target. */
  protected reloadData(): void {
    this.dataRes.reload();
    this.projectsRes.reload();
  }

  /**
   * Immutable baseline forecast inputs. Falls back to `EMPTY_DATA` on a failed
   * read purely as defense-in-depth against `dataRes.value()` THROWING while
   * errored (same non-throwing-accessor shape as `billing.ts`'s `items`/
   * `contracts` getters) — NOT as the mechanism that keeps the header honest.
   * That job belongs to `dataState()`: every consumer of `baseData()` (this
   * file's `hasData`, `dirty`, `changeCount`, `basePeriods`, `baseSkills`,
   * `baseBenchCount`, `slippableProjects`, `resetScenario`) is reached only
   * from a template region gated on `dataState() === 'ready'`, so this
   * fallback's empty value is never actually read as a "settled" figure.
   */
  private readonly baseData = computed<ForecastData>(() =>
    this.dataRes.status() === 'error' ? WhatIf.EMPTY_DATA : this.dataRes.value(),
  );

  readonly hasData = computed<boolean>(() => {
    const d = this.baseData();
    return d.resources.length > 0 || d.requests.length > 0 || d.assignments.length > 0;
  });

  // --- SCENARIO: a deep copy of the base, re-seeded whenever the base reloads --
  // `linkedSignal` gives us a writable signal that resets to a fresh deep copy of
  // the base each time the base changes (the canonical "writable state from a
  // source" primitive) — no effect-writes-signal anti-pattern, and reset is trivial.

  private readonly scenario = linkedSignal<ForecastData, ForecastData>({
    source: this.baseData,
    computation: base => this.clone(base),
  });

  /** True when the scenario diverges from the baseline (drives the badge + reset button). */
  readonly dirty = computed<boolean>(() => {
    const base = this.baseData();
    const s = this.scenario();
    return (
      s.resources.length !== base.resources.length ||
      s.requests.length !== base.requests.length ||
      s.assignments.length !== base.assignments.length ||
      this.requestsShifted(base.requests, s.requests)
    );
  });

  /** Rough count of distinct changes applied (added resources/requests + shifted requests). */
  readonly changeCount = computed<number>(() => {
    const base = this.baseData();
    const s = this.scenario();
    const addedResources = Math.max(0, s.resources.length - base.resources.length);
    const addedRequests = Math.max(0, s.requests.length - base.requests.length);
    const shifted = this.shiftedRequestCount(base.requests, s.requests);
    return addedResources + addedRequests + shifted;
  });

  // --- Horizon + forecasts on BOTH base and scenario --------------------------

  /** Horizon start = today (UTC midnight), so periods line up with calendar weeks. */
  private readonly horizonStartIso = computed<string>(() => todayLocalIso());

  private readonly basePeriods = computed<CapacityPeriod[]>(() =>
    capacityForecast(this.baseData(), this.horizonStartIso(), HORIZON_WEEKS, 'weekly'),
  );
  private readonly scenarioPeriods = computed<CapacityPeriod[]>(() =>
    capacityForecast(this.scenario(), this.horizonStartIso(), HORIZON_WEEKS, 'weekly'),
  );

  // `currentMonth()` is threaded into both sides so coverage counts only people
  // employed now — and, critically, the SAME month on both, or a base-vs-scenario
  // delta would partly reflect a different employment cut-off.
  private readonly baseSkills = computed<SkillGapEntry[]>(() => skillGap(this.baseData(), this.currentMonth()));
  private readonly scenarioSkills = computed<SkillGapEntry[]>(() => skillGap(this.scenario(), this.currentMonth()));

  /** The current calendar month — `notFullyAllocatedAt`'s single-month snapshot,
   * NOT `/bench`'s own 6-month display window (this sandbox only ever needs
   * "right now" for its base-vs-scenario comparison). */
  private readonly currentMonth = computed<string>(() => todayLocalIso().slice(0, 7));

  private toRollupInput(d: ForecastData) {
    return {
      resources: d.resources, assignments: d.assignments, assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths, hoursPerDay: d.hoursPerDay,
      holidays: new Set(d.holidays.map(h => h.id)),
    };
  }
  // Recomputed straight from `this.scenario()` (mutated in-memory by every
  // lever) — NOT memoized off a snapshot taken at load time — so a `hire()`
  // with no bookings, a `winDeal()`, or a `slipProject()` immediately changes
  // this figure on the next read. This IS the "What-If must actually
  // simulate" guarantee: see the "hire adds a bench resource to the scenario
  // only" test in what-if.spec.ts, which fails if this reads a stale snapshot.
  private readonly baseBenchCount = computed<number>(() =>
    notFullyAllocatedAt(this.toRollupInput(this.baseData()), this.currentMonth(), todayLocalIso()).length,
  );
  private readonly scenarioBenchCount = computed<number>(() =>
    notFullyAllocatedAt(this.toRollupInput(this.scenario()), this.currentMonth(), todayLocalIso()).length,
  );

  readonly baseShortages = computed<number>(() => this.baseSkills().filter(s => s.shortage).length);
  readonly scenarioShortages = computed<number>(() => this.scenarioSkills().filter(s => s.shortage).length);

  // --- Delta KPIs -------------------------------------------------------------

  readonly kpis = computed<KpiDelta[]>(() => {
    const baseAvg = this.avgUtil(this.basePeriods());
    const scenAvg = this.avgUtil(this.scenarioPeriods());
    const basePeak = this.peakDemand(this.basePeriods());
    const scenPeak = this.peakDemand(this.scenarioPeriods());
    const baseShort = this.baseShortages();
    const scenShort = this.scenarioShortages();
    const baseBench = this.baseBenchCount();
    const scenBench = this.scenarioBenchCount();

    return [
      {
        label: 'Avg Utilization',
        note: `Mean across ${HORIZON_WEEKS} weeks`,
        base: baseAvg,
        scenario: scenAvg,
        // Unknown either side ⇒ unknown delta. Treating a missing average as 0
        // would manufacture a huge signed swing out of an absent measurement.
        delta: baseAvg === null || scenAvg === null ? null : scenAvg - baseAvg,
        format: 'pct',
        better: 'up',
      },
      {
        label: 'Peak Demand',
        note: 'Busiest weekly hours',
        base: basePeak,
        scenario: scenPeak,
        delta: scenPeak - basePeak,
        format: 'count',
        better: 'down',
      },
      {
        label: 'Skill Shortages',
        note: 'Skills with zero coverage',
        base: baseShort,
        scenario: scenShort,
        delta: scenShort - baseShort,
        format: 'count',
        better: 'down',
      },
      {
        label: 'On Bench',
        note: 'Under-allocated resources',
        base: baseBench,
        scenario: scenBench,
        delta: scenBench - baseBench,
        format: 'count',
        better: 'down',
      },
    ];
  });

  // --- Scenario timeline rows -------------------------------------------------

  readonly timeline = computed<TimelineRow[]>(() => {
    const rows = this.scenarioPeriods();
    const baseByPeriod = new Map(this.basePeriods().map(p => [p.period, p]));
    return rows.map(r => ({
      label: this.shortDate(r.period),
      supply: r.supply,
      demand: r.demand,
      utilizationPct: r.utilizationPct,
      demandDelta: r.demand - (baseByPeriod.get(r.period)?.demand ?? 0),
      committed: r.committed,
      pipeline: r.pipeline,
      band: forecastUtilizationBand(r.utilizationPct),
    }));
  });

  /** Week-start labels (e.g. "12 May") shared by the bar + trend charts. */
  readonly weekLabels = computed<string[]>(() =>
    this.scenarioPeriods().map(p => this.shortDate(p.period)),
  );

  /**
   * The scenario DEMAND stack only — Committed (accent) over Pipeline (series-2/teal),
   * in genuinely distinct tones so the two bands and their legend swatches never
   * collapse. Supply is deliberately absent; see {@link scenarioSupplyOverlay}.
   */
  readonly scenarioDemandSeries = computed<BarSeries[]>(() => {
    const rows = this.scenarioPeriods();
    return [
      { name: 'Committed', values: rows.map(r => r.committed), color: 'var(--color-accent)' },
      { name: 'Pipeline', values: rows.map(r => r.pipeline), color: 'var(--color-series-2)' },
    ];
  });

  /**
   * Scenario supply (Σ capacity under the levers) as the chart's reference overlay
   * rather than a third bar, for the reason spelled out at the call site: a stacked
   * chart sums every [series] entry, so supply-as-a-series is added into the demand
   * it is meant to be compared with.
   */
  readonly scenarioSupplyOverlay = computed<BarSeries>(() => ({
    name: 'Supply',
    values: this.scenarioPeriods().map(r => r.supply),
    color: 'var(--color-series-6)',
  }));

  /** Baseline vs scenario weekly demand, aligned on the scenario's period axis. */
  readonly demandTrendSeries = computed<TrendSeries[]>(() => {
    const rows = this.scenarioPeriods();
    const baseByPeriod = new Map(this.basePeriods().map(p => [p.period, p]));
    return [
      { name: 'Base demand', values: rows.map(r => baseByPeriod.get(r.period)?.demand ?? 0) },
      { name: 'Scenario demand', values: rows.map(r => r.demand) },
    ];
  });

  // --- Skill rows: union of base + scenario skills ----------------------------

  readonly skillRows = computed(() => {
    const base = new Map(this.baseSkills().map(s => [s.skill.toLowerCase(), s]));
    const scen = new Map(this.scenarioSkills().map(s => [s.skill.toLowerCase(), s]));
    const keys = new Set([...base.keys(), ...scen.keys()]);
    return [...keys]
      .map(key => {
        const b = base.get(key);
        const s = scen.get(key);
        const scenarioDemandCount = s?.demandCount ?? 0;
        const scenarioSupplyCount = s?.supplyCount ?? 0;
        return {
          skill: s?.skill ?? b?.skill ?? key,
          baseDemandHours: b?.demandHours ?? 0,
          scenarioDemandHours: s?.demandHours ?? 0,
          baseSupplyCount: b?.supplyCount ?? 0,
          scenarioSupplyCount,
          scenarioShortage: s ? s.shortage : false,
          // "Thin" = demanded by more open requests than there are covering resources.
          scenarioThin: scenarioDemandCount > 0 && scenarioSupplyCount < scenarioDemandCount,
        };
      })
      .sort((a, b) => {
        if (a.scenarioShortage !== b.scenarioShortage) return a.scenarioShortage ? -1 : 1;
        return b.scenarioDemandHours - a.scenarioDemandHours;
      });
  });

  // --- "Slip project" support -------------------------------------------------

  /** Projects that have at least one request with usable dates in the (base) data. */
  readonly slippableProjects = computed<Project[]>(() => {
    const datedProjectIds = new Set(
      this.baseData().requests
        .filter(r => r.projectId && isCompleteForecastWindow(r.startDate ?? '', r.endDate ?? ''))
        .map(r => r.projectId as string),
    );
    return this.projectsRes.value().filter(p => datedProjectIds.has(p.id));
  });

  requestCountFor(projectId: string): number {
    return this.scenario().requests.filter(r => r.projectId === projectId).length;
  }

  // --- Typed forms ------------------------------------------------------------

  readonly dealForm = new FormGroup({
    requiredRole: new FormControl('', { nonNullable: true, validators: Validators.required }),
    requiredEffort: new FormControl<number>(0, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    skills: new FormControl('', { nonNullable: true }),
    startDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    endDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
  }, { validators: WhatIf.validDealWindow });

  readonly hireForm = new FormGroup({
    role: new FormControl('', { nonNullable: true, validators: Validators.required }),
    count: new FormControl<number>(1, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(50)],
    }),
    capacity: new FormControl<number>(40, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    skill: new FormControl('', { nonNullable: true }),
  });

  readonly slipForm = new FormGroup({
    projectId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    weeks: new FormControl<number>(4, {
      nonNullable: true,
      validators: [Validators.required, WhatIf.nonZeroWeeks],
    }),
  });

  // --- Lever handlers (mutate the in-memory scenario only) --------------------

  /** Append a synthetic open ResourceRequest to the scenario's pipeline. */
  winDeal(): void {
    if (this.dealForm.invalid) return;
    const v = this.dealForm.getRawValue();
    const skills = this.parseSkills(v.skills);
    const request: ResourceRequest = {
      id: this.nextId('whatif-req'),
      name: `What-If: ${v.requiredRole.trim()}`,
      requiredRole: v.requiredRole.trim(),
      requiredEffort: Math.max(0, v.requiredEffort),
      staffedEffort: 0,
      status: 'Open',
      skills,
      startDate: v.startDate,
      endDate: v.endDate,
    };
    this.scenario.update(s => ({ ...s, requests: [...s.requests, request] }));
    this.notify.show(`Added open request for ${request.requiredRole} (${request.requiredEffort}h).`, 'success');
    this.dealForm.reset({ requiredRole: '', requiredEffort: 0, skills: '', startDate: '', endDate: '' });
  }

  /** Append N synthetic, fully-available Resources (new supply) to the scenario. */
  hire(): void {
    if (this.hireForm.invalid) return;
    const v = this.hireForm.getRawValue();
    const count = Math.floor(Math.max(1, v.count));
    const capacity = Math.max(0, v.capacity);
    const skillName = v.skill.trim();
    const role = v.role.trim();
    const hires: Resource[] = Array.from({ length: count }, (_, i) => ({
      id: this.nextId('whatif-res'),
      name: `New ${role} ${i + 1}`,
      role,
      skills: skillName ? [{ name: skillName, level: 3 }] : [],
      projectRoles: [],
      externalExperience: [],
      utilization: 0,
      capacity,
    }));
    this.scenario.update(s => ({ ...s, resources: [...s.resources, ...hires] }));
    this.notify.show(`Added ${count} ${role}${count === 1 ? '' : 's'} at ${capacity}h/week.`, 'success');
    this.hireForm.reset({ role: '', count: 1, capacity: 40, skill: '' });
  }

  /** Shift every request of the chosen project by W weeks (start + end) in the scenario. */
  slipProject(): void {
    if (this.slipForm.invalid) return;
    const { projectId, weeks } = this.slipForm.getRawValue();
    const deltaMs = weeks * 7 * 86_400_000;
    let shifted = 0;
    this.scenario.update(s => ({
      ...s,
      requests: s.requests.map(r => {
        if (r.projectId !== projectId) return r;
        const start = this.shiftIso(r.startDate, deltaMs);
        const end = this.shiftIso(r.endDate, deltaMs);
        if (start === r.startDate && end === r.endDate) return r;
        shifted++;
        return { ...r, startDate: start, endDate: end };
      }),
    }));
    if (shifted === 0) {
      this.notify.show('That project has no dated requests to shift.', 'info');
      return;
    }
    const dir = weeks >= 0 ? 'later' : 'earlier';
    this.notify.show(`Shifted ${shifted} request${shifted === 1 ? '' : 's'} ${Math.abs(weeks)}w ${dir}.`, 'success');
    this.slipForm.reset({ projectId: '', weeks: 4 });
  }

  /** Discard all scenario changes by re-seeding from the immutable base. */
  resetScenario(): void {
    this.scenario.set(this.clone(this.baseData()));
    this.notify.show('Scenario reset to baseline.', 'info');
  }

  // --- Template formatting helpers --------------------------------------------

  /** 'n/a' for an unmeasurable metric — never a 0 standing in for "unknown". */
  formatMetric(k: KpiDelta, value: number | null): string {
    if (value === null) return 'n/a';
    const rounded = Math.round(value);
    return k.format === 'pct' ? `${rounded}%` : `${rounded}`;
  }

  deltaText(k: KpiDelta): string {
    if (k.delta === null) return 'n/a';
    const rounded = Math.round(k.delta);
    const sign = rounded > 0 ? '+' : '';
    return k.format === 'pct' ? `${sign}${rounded}%` : `${sign}${rounded}`;
  }

  deltaIsGood(k: KpiDelta): boolean {
    // No tone at all when either side is unknown: a green/red card is a claim
    // about a comparison that was never possible to make.
    if (k.base === null || k.scenario === null || k.delta === null) return false;
    if (k.label === 'Avg Utilization') return utilizationChangeTone(k.base, k.scenario) === 'good';
    if (k.delta === 0) return false;
    return k.better === 'up' ? k.delta > 0 : k.delta < 0;
  }

  deltaIsBad(k: KpiDelta): boolean {
    if (k.base === null || k.scenario === null || k.delta === null) return false;
    if (k.label === 'Avg Utilization') return utilizationChangeTone(k.base, k.scenario) === 'bad';
    if (k.delta === 0) return false;
    return k.better === 'up' ? k.delta < 0 : k.delta > 0;
  }

  // --- Pure helpers -----------------------------------------------------------

  /** Structured deep copy so scenario mutations never leak back into the base. */
  private clone(data: ForecastData): ForecastData {
    return {
      resources: data.resources.map(r => ({ ...r, skills: r.skills.map(s => ({ ...s })) })),
      requests: data.requests.map(r => ({ ...r, skills: [...r.skills] })),
      assignments: data.assignments.map(a => ({ ...a })),
      assignmentDays: data.assignmentDays.map(d => ({ ...d })),
      assignmentMonths: data.assignmentMonths.map(m => ({ ...m })),
      holidays: data.holidays.map(h => ({ ...h })),
      hoursPerDay: data.hoursPerDay,
    };
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.syntheticSeq}`;
  }

  private parseSkills(csv: string): string[] {
    return csv
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /** Shift an ISO date by `deltaMs`, preserving YYYY-MM-DD; passes through missing/invalid dates. */
  private shiftIso(iso: string | undefined, deltaMs: number): string | undefined {
    if (!iso) return iso;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    return new Date(ms + deltaMs).toISOString().slice(0, 10);
  }

  /**
   * Mean utilisation over the periods that HAVE one; `null` when none do.
   * Periods with no supply are EXCLUDED rather than counted as 0% — averaging in
   * a fabricated 0 for a week with no capacity drags the whole horizon down and
   * makes a hire lever look like it caused a collapse it did not cause.
   */
  private avgUtil(periods: CapacityPeriod[]): number | null {
    const measured = periods.filter(p => p.utilizationPct !== null);
    if (!measured.length) return null;
    return measured.reduce((acc, p) => acc + (p.utilizationPct as number), 0) / measured.length;
  }

  private peakDemand(periods: CapacityPeriod[]): number {
    return periods.reduce((max, p) => Math.max(max, p.demand), 0);
  }

  /** True when any request shared by both lists has a changed start/end date. */
  private requestsShifted(base: ResourceRequest[], scenario: ResourceRequest[]): boolean {
    return this.shiftedRequestCount(base, scenario) > 0;
  }

  private shiftedRequestCount(base: ResourceRequest[], scenario: ResourceRequest[]): number {
    const baseById = new Map(base.map(r => [r.id, r]));
    let count = 0;
    for (const r of scenario) {
      const original = baseById.get(r.id);
      if (original && (original.startDate !== r.startDate || original.endDate !== r.endDate)) count++;
    }
    return count;
  }

  /** Validator: the slip amount must be a non-zero number of weeks. */
  private static validDealWindow(control: AbstractControl): ValidationErrors | null {
    const value = control.value as { startDate?: unknown; endDate?: unknown } | null;
    const start = typeof value?.startDate === 'string' ? value.startDate : '';
    const end = typeof value?.endDate === 'string' ? value.endDate : '';
    return isCompleteForecastWindow(start, end) ? null : { invalidDateWindow: true };
  }

  /** Validator: the slip amount must be a non-zero number of weeks. */
  private static nonZeroWeeks(control: AbstractControl): ValidationErrors | null {
    return Number(control.value) === 0 ? { zeroWeeks: true } : null;
  }

  /** ISO date → "12 May" style label (UTC, time-zone stable). */
  private shortDate(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
}
