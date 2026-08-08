import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import {
  ApiService,
  ResourceRequest,
  Resource,
  Assignment,
  ResourceOrganization,
  type BenchRollup,
  type BenchRow,
  type ProficiencySet,
  type ProjectRole,
  type Skill,
  type SkillCatalog,
  type Vendor,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import {
  rankCandidates,
  requestSkillGap,
  MATCH_WEIGHTS,
  type CandidateScore,
  type MatchDimension,
} from '../services/match.util';
import { isTerminatedAsOf } from '../services/org-scope.util';
import { todayLocalIso } from '../services/local-date.util';
import {
  advancedFacetCount,
  filterCandidates,
  hasAnyFacet,
  type CandidateFacetValues,
} from '../services/candidate-filter.util';
import { RESOURCE_KINDS, RESOURCE_KIND_LABELS, type ResourceKind } from '../services/resource-kind.util';
import { isWorkableUncoveredRequest } from '../services/request-demand.util';
import { ListStateComponent } from '../shared/list-state.component';
import { ResourceKindBadgeComponent } from '../shared/resource-kind-badge.component';
import { AvailabilityStripComponent, type AvailabilityReadState } from './availability-strip.component';

interface DimensionMeter {
  key: MatchDimension;
  label: string;
  short: string;
  value: number;
  weight: number;
  pct: number;
}

/** The reference-data catalogs the facet option lists are drawn from. */
interface FacetCatalogs {
  vendors: Vendor[];
  projectRoles: ProjectRole[];
  skills: Skill[];
  skillCatalogs: SkillCatalog[];
  proficiencySets: ProficiencySet[];
}

const EMPTY_FACET_CATALOGS: FacetCatalogs = {
  vendors: [], projectRoles: [], skills: [], skillCatalogs: [], proficiencySets: [],
};

/** Pre-read default for the bench rollup. Spelled out here rather than imported
 *  from `bench.util.ts`: this screen depends on the TYPES that `api.service`
 *  re-exports, not on that module. */
const EMPTY_BENCH: BenchRollup = { months: [], internalRows: [], subcoRows: [], hiringDemand: [] };

/**
 * The single place the loading / error / ready question is answered on this
 * screen, so its two list regions cannot answer it differently. `!authReady`
 * counts as LOADING, never as ready-and-empty: an rxResource keyed on authReady
 * resolves its pre-auth default synchronously, so `isLoading()` alone reports
 * "settled, nothing here" throughout the OIDC bootstrap window.
 */
function stateOf(
  inputs: readonly { status: () => string; isLoading: () => boolean }[],
  authReady: boolean,
): 'error' | 'loading' | 'ready' {
  if (inputs.some(r => r.status() === 'error')) return 'error';
  if (!authReady || inputs.some(r => r.isLoading())) return 'loading';
  return 'ready';
}

@Component({
  selector: 'app-staffing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule, DecimalPipe, FormsModule, ListStateComponent, ResourceKindBadgeComponent,
    AvailabilityStripComponent,
  ],
  template: `
    <div class="command-page space-y-6">
      <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Staff Resource Requests</h1>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <!-- Requests List -->
        <div class="command-card overflow-hidden flex flex-col h-[min(800px,80vh)]">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Open Requests</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Select a request to find matching resources</p>
            </div>
          </div>
          <div class="overflow-y-auto flex-1">
            <app-list-state [loading]="poolState() === 'loading'" [error]="poolState() === 'error'" label="requests" (retry)="res.reload()">
            <ng-template>
            <div class="divide-y divide-[var(--cc-line)]">
            @for (req of openRequests(); track req.id) {
              <div class="p-6 sm:p-8 hover:bg-surface-muted transition-all cursor-pointer group relative"
                   [class.bg-accent-tint]="selectedRequest()?.id === req.id"
                   role="button"
                   tabindex="0"
                   [attr.aria-label]="'Select request ' + req.name"
                   [attr.aria-pressed]="selectedRequest()?.id === req.id"
                   (keydown.enter)="selectRequest(req)"
                   (keydown.space)="selectRequest(req); $event.preventDefault()"
                   (click)="selectRequest(req)">
                @if (selectedRequest()?.id === req.id) {
                  <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-[var(--cc-primary)] rounded-r-full"></div>
                }
                <div class="flex justify-between items-start mb-3">
                  <h3 class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors">{{ req.name }}</h3>
                  <span class="command-status">{{ req.requiredEffort | number:'1.0-2' }}h</span>
                </div>
                <p class="text-sm font-semibold text-[var(--cc-muted)] mb-4 uppercase tracking-wider">{{ req.requiredRole }}</p>
                <div class="flex gap-2 flex-wrap">
                  @for (skill of req.skills; track skill) {
                    <span class="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold tracking-wide bg-surface-muted text-ink-secondary border border-line">
                      {{ skill }}
                    </span>
                  }
                </div>
              </div>
            }
            @if (openRequests().length === 0) {
              <div class="p-12 text-center text-sm text-[var(--cc-muted)]">No open requests available for staffing.</div>
            }
            </div>
            </ng-template>
            </app-list-state>
          </div>
        </div>

        <!-- Resources List -->
        <div class="command-card overflow-hidden flex flex-col h-[min(800px,80vh)]">
          <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
            <div class="flex items-center justify-between mb-6">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">
                  {{ selectedRequest() ? 'Matching Resources' : 'All Resources' }}
                </h2>
                @if (selectedRequest()) {
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">For <span class="font-bold text-[var(--cc-ink)]">{{ selectedRequest()?.name }}</span></p>
                }
              </div>
              @if (selectedRequest()) {
                <button (click)="clearSelection()" class="command-button secondary">Clear Selection</button>
              }
            </div>

            <div class="relative">
              <mat-icon class="absolute left-4 top-1/2 -translate-y-1/2 text-ink-muted text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input
                type="text"
                [ngModel]="searchQuery()"
                (ngModelChange)="searchQuery.set($event)"
                placeholder="Search by name, role, or skills..."
                aria-label="Search candidate resources"
                class="command-input pl-12"
              >
            </div>

            <!-- Capability / Practice / Competence / People Manager filters (D, Task 8).
                 Derived through dimensionsOf, so a capability filter also matches a
                 resource attached BELOW it (e.g. a competence two levels down) — never
                 a raw equality check against r.organization. These <select>s load their
                 <option>s from an async rxResource, so per the established trap they
                 use (change) + per-option [selected] rather than [value]/[ngModel] on
                 the <select> itself. -->
            <div class="mt-4 flex flex-col sm:flex-row flex-wrap gap-3">
              <select (change)="onCapabilityChange($event)" aria-label="Filter by capability"
                      data-test="capability-filter" class="command-select sm:w-44">
                <option value="" [selected]="capabilityFilter() === ''">All capabilities</option>
                @for (name of capabilityOptions(); track name) {
                  <option [value]="name" [selected]="name === capabilityFilter()">{{ name }}</option>
                }
              </select>
              <select (change)="onPracticeChange($event)" aria-label="Filter by practice"
                      data-test="practice-filter" class="command-select sm:w-44">
                <option value="" [selected]="practiceFilter() === ''">All practices</option>
                @for (name of practiceOptions(); track name) {
                  <option [value]="name" [selected]="name === practiceFilter()">{{ name }}</option>
                }
              </select>
              <select (change)="onCompetenceChange($event)" aria-label="Filter by competence"
                      data-test="competence-filter" class="command-select sm:w-44">
                <option value="" [selected]="competenceFilter() === ''">All competences</option>
                @for (name of competenceOptions(); track name) {
                  <option [value]="name" [selected]="name === competenceFilter()">{{ name }}</option>
                }
              </select>
              <select (change)="onManagerFilterChange($event)" aria-label="Filter by People Manager"
                      data-test="manager-filter" class="command-select sm:w-44">
                <option value="" [selected]="managerFilter() === ''">All people managers</option>
                @for (m of managerFilterOptions(); track m.id) {
                  <option [value]="m.id" [selected]="m.id === managerFilter()">{{ m.name }}</option>
                }
              </select>
            </div>

            <!-- RPT "Ricerca Avanzata", the remaining facets (§3.2.1-§3.2.5).
                 Behind a native <details> so the visible control count stays
                 what it is today: at 320px every control is full-width and
                 stacked (flex-col until sm:), so nine more in the row above
                 would fill the viewport before the first candidate. The summary
                 states how many hidden facets are active, and Clear filters sits
                 OUTSIDE the disclosure, so a collapsed panel can never be
                 filtering invisibly with no way out.
                 Same convention as the four selects above: (change) plus
                 per-option [selected], never [(ngModel)] on a <select> whose
                 <option>s come from an async rxResource. -->
            <div class="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <details class="flex-1 min-w-0" data-test="advanced-filters">
                <summary class="cursor-pointer text-sm font-bold text-[var(--cc-ink)] select-none">
                  Advanced filters
                  @if (advancedActiveCount() > 0) {
                    <span class="command-chip is-info ml-2" data-test="advanced-filters-count">
                      {{ advancedActiveCount() }} active
                    </span>
                  }
                </summary>

                <fieldset class="mt-4 border-0 p-0 m-0">
                  <legend class="text-[10px] font-bold uppercase tracking-wider text-[var(--cc-muted)] mb-2">
                    Registry
                  </legend>
                  <div class="flex flex-col sm:flex-row sm:flex-wrap gap-3">
                    <select (change)="onKindFilterChange($event)" aria-label="Filter by registry type"
                            data-test="kind-filter" class="command-select sm:w-44">
                      <option value="" [selected]="kindFilter() === ''">All registry types</option>
                      @for (k of kindOptions; track k.value) {
                        <option [value]="k.value" [selected]="k.value === kindFilter()">{{ k.label }}</option>
                      }
                    </select>
                    <select (change)="onVendorFilterChange($event)" aria-label="Filter by company"
                            data-test="vendor-filter" class="command-select sm:w-56">
                      <option value="" [selected]="vendorFilter() === ''">All companies</option>
                      @for (v of vendorOptions(); track v.id) {
                        <option [value]="v.id" [selected]="v.id === vendorFilter()">{{ v.name }}</option>
                      }
                    </select>
                  </div>
                </fieldset>

                <fieldset class="mt-4 border-0 p-0 m-0">
                  <legend class="text-[10px] font-bold uppercase tracking-wider text-[var(--cc-muted)] mb-2">
                    Skills and job role
                  </legend>
                  <div class="flex flex-col sm:flex-row sm:flex-wrap gap-3">
                    <select (change)="onJobRoleFilterChange($event)" aria-label="Filter by job role"
                            data-test="job-role-filter" class="command-select sm:w-48">
                      <option value="" [selected]="jobRoleFilter() === ''">All job roles</option>
                      @for (r of jobRoleOptions(); track r.id) {
                        <option [value]="r.name" [selected]="r.name === jobRoleFilter()">{{ r.name }}</option>
                      }
                    </select>
                    <select (change)="onSkillFilterChange($event)" aria-label="Filter by skill"
                            data-test="skill-filter" class="command-select sm:w-44">
                      <option value="" [selected]="skillFilter() === ''">All skills</option>
                      @for (s of skillOptions(); track s.id) {
                        <option [value]="s.name" [selected]="s.name === skillFilter()">{{ s.name }}</option>
                      }
                    </select>
                    <!-- Qualifies the skill above, so it is disabled until one is
                         chosen — and stays disabled for a skill that declares no
                         proficiency scale, rather than offering an invented one. -->
                    <select (change)="onMinLevelChange($event)" aria-label="Filter by minimum proficiency"
                            data-test="min-level-filter" class="command-select sm:w-52"
                            [disabled]="minLevelOptions().length === 0"
                            [title]="minLevelOptions().length === 0 ? 'Pick a skill that has a proficiency scale first' : 'Minimum proficiency for the selected skill'">
                      <option value="" [selected]="minSkillLevel() === null">Any proficiency</option>
                      @for (l of minLevelOptions(); track l.value) {
                        <option [value]="l.value" [selected]="l.value === minSkillLevel()">{{ l.label }}</option>
                      }
                    </select>
                    <select (change)="onSkillCatalogFilterChange($event)" aria-label="Filter by skill capability"
                            data-test="skill-catalog-filter" class="command-select sm:w-52">
                      <option value="" [selected]="skillCatalogFilter() === ''">All skill capabilities</option>
                      @for (c of skillCatalogOptions(); track c.id) {
                        <option [value]="c.id" [selected]="c.id === skillCatalogFilter()">{{ c.name }}</option>
                      }
                    </select>
                  </div>
                </fieldset>

                <fieldset class="mt-4 border-0 p-0 m-0">
                  <legend class="text-[10px] font-bold uppercase tracking-wider text-[var(--cc-muted)] mb-2">
                    Cost rate (&euro;/day)
                  </legend>
                  <div class="flex flex-col sm:flex-row sm:flex-wrap gap-3">
                    <label class="command-field sm:w-40">
                      <span class="command-field-label">From</span>
                      <input type="number" min="0" step="10" data-test="rate-min-filter"
                             class="command-input font-mono tabular-nums"
                             [ngModel]="rateMin()" (ngModelChange)="onRateBoundChange('min', $event)">
                    </label>
                    <label class="command-field sm:w-40">
                      <span class="command-field-label">To</span>
                      <input type="number" min="0" step="10" data-test="rate-max-filter"
                             class="command-input font-mono tabular-nums"
                             [ngModel]="rateMax()" (ngModelChange)="onRateBoundChange('max', $event)">
                    </label>
                  </div>
                  <p class="mt-2 text-xs text-[var(--cc-muted)]">
                    Matches the effective cost rate. A resource whose rate is not resolved yet is excluded
                    while a bound is set.
                  </p>
                </fieldset>
              </details>

              @if (anyFacetActive()) {
                <button type="button" (click)="clearAllFilters()" data-test="clear-filters"
                        class="command-button secondary shrink-0">Clear filters</button>
              }
            </div>

            <!-- Legend for the per-card availability strip: stated once here
                 rather than repeated on every card. -->
            @if (availabilityState() === 'ready' && availabilityMonths().length > 0) {
              <p class="mt-4 text-xs text-[var(--cc-muted)]" data-test="availability-legend">
                Future availability {{ availabilityWindowLabel() }} —
                <span class="font-bold text-positive-text">B</span> bench
                <span class="mx-1">&middot;</span>
                <span class="font-bold text-caution-text">P</span> partially allocated
                <span class="mx-1">&middot;</span>
                <span class="font-bold text-critical-text">A</span> fully allocated
                <span class="mx-1">&middot;</span>
                <span class="font-bold">&ndash;</span> not tracked
              </p>
            }
            @if (availabilityState() === 'error') {
              <p class="mt-4 flex flex-wrap items-center gap-2 text-xs font-semibold text-caution-text"
                 role="status" data-test="availability-error">
                <mat-icon class="text-[16px] w-[16px] h-[16px] shrink-0">warning_amber</mat-icon>
                Future availability could not be loaded. The ranking below is unaffected.
                <button type="button" (click)="reloadAvailability()" data-test="availability-retry"
                        class="command-button secondary">Retry availability</button>
              </p>
            }

            @if (missingSkillGap().length > 0) {
              <div class="mt-6 flex items-start gap-3 rounded-md bg-caution-tint ring-1 ring-caution p-4">
                <mat-icon class="text-caution-text text-[20px] w-[20px] h-[20px] shrink-0 mt-0.5">warning_amber</mat-icon>
                <div>
                  <p class="text-sm font-bold text-caution-text">Skill gap: no available resource covers these skills</p>
                  <div class="flex gap-2 flex-wrap mt-2">
                    @for (skill of missingSkillGap(); track skill) {
                      <span class="command-chip is-caution">
                        {{ skill }}
                      </span>
                    }
                  </div>
                </div>
              </div>
            }
          </div>
          <!-- The candidate list reads the SAME two resources the header above
               does, and used to render with no loading/error state of its own:
               during the pre-authReady window it stated "No resources found
               matching your criteria." about a read not yet made, and a failed
               read left the panel frozen with no message and no Retry. One
               wrapper over both legs owns all three states. -->
          <div class="overflow-y-auto flex-1 divide-y divide-[var(--cc-line)]">
            <app-list-state [loading]="candidateListState() === 'loading'" [error]="candidateListState() === 'error'"
                            label="candidate resources" (retry)="reloadCandidateInputs()">
            <ng-template>
            @if (rankedCandidates(); as candidates) {
              <!-- Ranked candidate mode: a request is selected. -->
              @for (cand of candidates; track cand.resourceId) {
                <div class="p-6 sm:p-8 hover:bg-surface-muted transition-colors group">
                  <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div class="flex items-start gap-5 min-w-0">
                      <div class="relative w-14 h-14 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex items-center justify-center font-display font-bold text-xl text-[var(--cc-ink)] shrink-0">
                        {{ cand.resource.name.charAt(0) }}
                        <span class="absolute -bottom-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-surface ring-1 ring-line text-[10px] font-bold font-mono tabular-nums shadow-sm"
                              [class]="scoreTextClass(cand.score)"
                              [title]="scoreTooltip(cand)">{{ cand.score | number:'1.0-0' }}</span>
                      </div>
                      <div class="min-w-0">
                        <h3 class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors flex items-center gap-2">
                          <span data-test="resource-name">{{ cand.resource.name }}</span>
                          <app-resource-kind-badge [kind]="cand.resource.kind" />
                        </h3>
                        <p class="text-sm font-medium text-[var(--cc-muted)] mt-0.5">{{ cand.resource.role }} <span class="mx-1.5 text-ink-muted">•</span> <span class="font-mono tabular-nums" [class.text-critical-text]="cand.resource.utilization > 100" [class.text-positive-text]="cand.resource.utilization <= 100">{{ cand.resource.utilization | number:'1.0-0' }}% Utilized</span></p>
                        <div class="flex gap-1.5 mt-3 flex-wrap">
                          @for (skill of cand.resource.skills; track skill.name) {
                            <span class="text-[10px] font-bold tracking-wider uppercase bg-surface-muted text-ink-secondary px-2 py-1 rounded-md border border-line">{{ skill.name }}</span>
                          }
                        </div>
                        <!-- RPT §3.2.2's "Disponibilità futura" traffic light,
                             on the card where the choice is actually made. -->
                        <div class="mt-3">
                          <app-availability-strip
                            [state]="availabilityState()"
                            [months]="availabilityMonths()"
                            [row]="benchRowFor(cand.resourceId)"
                            [resourceName]="cand.resource.name" />
                        </div>
                      </div>
                    </div>
                    <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0 w-full sm:w-auto">
                      @if (assigningResourceId() === cand.resourceId) {
                        <!-- The reveal replaces the button that triggered it, so
                             focus had nowhere to go and landed on <body>: the next
                             Tab restarted at the skip link, and a screen-reader
                             user got no signal that a form had appeared at all.
                             role=group + a name makes the reveal announceable;
                             #allocInput is what the render effect focuses. -->
                        <div class="flex flex-col gap-3 w-full sm:w-auto" role="group"
                             data-test="assign-panel"
                             [attr.aria-label]="'Assignment proposal for ' + cand.resource.name">
                          <div class="command-card-muted p-3 text-sm text-[var(--cc-muted)]">
                            This creates an empty assignment. Book hours per day in the Allocation Calendar afterwards.
                          </div>
                          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <label class="command-field">
                              <span class="command-field-label">Allocation %</span>
                              <input #allocInput data-test="assign-allocation" type="number" [ngModel]="assignAllocationPct()" (ngModelChange)="assignAllocationPct.set($event)" class="command-input font-mono tabular-nums" min="0" max="100" step="5">
                            </label>
                            <label class="command-field">
                              <span class="command-field-label">Start date</span>
                              <input type="date" [ngModel]="assignStartDate()" (ngModelChange)="assignStartDate.set($event)" class="command-input font-mono tabular-nums">
                            </label>
                            <label class="command-field">
                              <span class="command-field-label">End date</span>
                              <input type="date" [ngModel]="assignEndDate()" (ngModelChange)="assignEndDate.set($event)" [min]="assignStartDate() || null" class="command-input font-mono tabular-nums">
                            </label>
                          </div>
                          <div class="flex items-center gap-2">
                            <button (click)="confirmAssign(cand.resourceId)" [disabled]="assigning()" class="command-button flex-1 sm:flex-none disabled:opacity-50 disabled:cursor-not-allowed">Create proposal</button>
                            <!-- Cancelling is the mirror of the reveal: the button
                                 the user came from is re-rendered, so focus goes
                                 back to it instead of to <body>. -->
                            <button type="button" (click)="cancelAssign(true)" aria-label="Cancel assignment" title="Cancel assignment" class="command-button secondary"><mat-icon class="text-[20px] w-[20px] h-[20px]">close</mat-icon></button>
                          </div>
                        </div>
                      } @else {
                        <button (click)="startAssign(cand.resourceId)" [attr.data-assign-for]="cand.resourceId" class="command-button secondary w-full sm:w-auto">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">person_add</mat-icon> Assign
                        </button>
                      }
                    </div>
                  </div>

                  <!-- Match score: overall bar + per-dimension breakdown cells -->
                  <div class="mt-5 command-card-muted p-4">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[10px] font-bold tracking-wider uppercase text-[var(--cc-muted)]">Match score</span>
                      <span class="text-sm font-bold font-mono tabular-nums" [class]="scoreTextClass(cand.score)">{{ cand.score | number:'1.0-1' }}<span class="text-[var(--cc-muted)]"> / 100</span></span>
                    </div>
                    <div class="h-2 w-full rounded-full bg-surface-muted overflow-hidden" [title]="scoreTooltip(cand)">
                      <div class="h-full rounded-full transition-all" [class]="scoreBarClass(cand.score)" [style.width.%]="cand.score"></div>
                    </div>

                    <div class="grid grid-cols-5 gap-2 mt-4">
                      @for (m of meters(cand); track m.key) {
                        <div class="flex flex-col items-center text-center" [title]="m.label + ': ' + m.value.toFixed(1) + ' / ' + m.weight">
                          <span class="text-[10px] font-bold tracking-wider uppercase text-[var(--cc-muted)] mb-1.5">{{ m.short }}</span>
                          <div class="h-1.5 w-full rounded-full bg-surface-muted overflow-hidden">
                            <div class="h-full rounded-full bg-[var(--cc-primary)]" [style.width.%]="m.pct"></div>
                          </div>
                          <span class="text-[11px] font-bold font-mono tabular-nums text-ink-secondary mt-1.5">{{ m.value | number:'1.0-1' }}<span class="text-[var(--cc-muted)]">/{{ m.weight }}</span></span>
                        </div>
                      }
                    </div>

                    @if (cand.missingSkills.length > 0) {
                      <div class="flex items-center gap-2 flex-wrap mt-4 pt-3 border-t border-[var(--cc-line)]">
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase text-critical-text">
                          <mat-icon class="text-[14px] w-[14px] h-[14px]">error_outline</mat-icon> Missing
                        </span>
                        @for (skill of cand.missingSkills; track skill) {
                          <span class="command-chip is-critical">{{ skill }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
              @if (candidates.length === 0) {
                <div class="p-12 text-center text-sm text-[var(--cc-muted)]">No resources found matching your criteria.</div>
              }
            } @else {
              <!-- Plain resource list mode: no request selected. -->
              @for (res of displayedResources(); track res.id) {
                <div class="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-surface-muted transition-colors group">
                  <div class="flex items-center gap-5">
                    <div class="w-14 h-14 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex items-center justify-center font-display font-bold text-xl text-[var(--cc-ink)] shrink-0">
                      {{ res.name.charAt(0) }}
                    </div>
                    <div>
                      <h3 class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors flex items-center gap-2">
                        <span data-test="resource-name">{{ res.name }}</span>
                        <app-resource-kind-badge [kind]="res.kind" />
                      </h3>
                      <p class="text-sm font-medium text-[var(--cc-muted)] mt-0.5">{{ res.role }} <span class="mx-1.5 text-ink-muted">•</span> <span class="font-mono tabular-nums" [class.text-critical-text]="res.utilization > 100" [class.text-positive-text]="res.utilization <= 100">{{ res.utilization | number:'1.0-0' }}% Utilized</span></p>
                      <div class="flex gap-1.5 mt-3 flex-wrap">
                        @for (skill of res.skills; track skill.name) {
                          <span class="text-[10px] font-bold tracking-wider uppercase bg-surface-muted text-ink-secondary px-2 py-1 rounded-md border border-line">{{ skill.name }}</span>
                        }
                      </div>
                      <div class="mt-3">
                        <app-availability-strip
                          [state]="availabilityState()"
                          [months]="availabilityMonths()"
                          [row]="benchRowFor(res.id)"
                          [resourceName]="res.name" />
                      </div>
                    </div>
                  </div>
                </div>
              }
              @if (displayedResources().length === 0) {
                <div class="p-12 text-center text-sm text-[var(--cc-muted)]">No resources found matching your criteria.</div>
              }
            }
            </ng-template>
            </app-list-state>
          </div>
        </div>
      </div>
    </div>
  `
})
export class StaffingComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);

  // resources is principal-gated server-side (401 until the Keycloak JWT is
  // restored). On reload the OIDC token restores async, so firing the forkJoin
  // immediately 401s and the rxResource latches on the error. Key the load on
  // auth readiness so it fires only AFTER the OAuth bootstrap has settled.
  protected res = rxResource<{ requests: ResourceRequest[]; resources: Resource[] }, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          requests: this.api.getRequests(),
          resources: this.api.getResources()
        })
      : of({ requests: [] as ResourceRequest[], resources: [] as Resource[] }),
    defaultValue: { requests: [] as ResourceRequest[], resources: [] as Resource[] }
  });

  /**
   * READ-FAILURE GUARD for the combined requests+resources read.
   * `rxResource.value()` THROWS ResourceValueError while its status is 'error',
   * and this envelope is dereferenced from bindings that live ABOVE (and beside)
   * every error affordance on this screen: the candidate search box, the four
   * org/manager filter <select>s and the skill-gap banner all sit in the
   * right-hand card's header, outside any app-list-state. One throw aborts the
   * whole change-detection pass and every later one at the same expression, so
   * the right-hand panel froze at whatever it last rendered — typing in the
   * search box did nothing, and no message or Retry ever appeared. Reordering
   * markup cannot fix that; only not reading a throwing accessor can.
   *
   * This is NOT the banned `status()==='error' ? [] : value()`: emptiness is
   * never this screen's ANSWER about the data. `poolState()`/`candidateListState()`
   * below put both list regions into their error panel in exactly the same
   * state, and `missingSkillGap()` refuses to speak at all — the empty envelope
   * exists only so the signal graph can settle while those panels are what the
   * user sees. The halves are one fix; weakening either re-creates the defect.
   */
  private pool = computed<{ requests: ResourceRequest[]; resources: Resource[] }>(() =>
    this.res.status() === 'error' ? { requests: [], resources: [] } : this.res.value(),
  );

  openRequests = computed(() =>
    this.pool().requests.filter(isWorkableUncoveredRequest)
  );
  allResources = computed(() => this.pool().resources);
  selectedRequest = signal<ResourceRequest | null>(null);
  searchQuery = signal('');

  // D (Task 8): the org tree the capability/practice/competence filters derive
  // from. Gated on authReady like the resources+requests load above.
  private orgsRes = rxResource<ResourceOrganization[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResourceOrganizations() : of<ResourceOrganization[]>([])),
    defaultValue: [] as ResourceOrganization[],
  });
  /** READ-FAILURE GUARD, same contract as `pool` above and for the same reason:
   *  the org tree is a SECOND, independently failing read whose `.value()`
   *  throws at the very same header bindings (the capability/practice/competence
   *  option lists). /requests+/resources succeeding while
   *  /resource-organizations 500s is enough on its own to freeze the panel,
   *  which is why `candidateListState()` covers BOTH legs and Retry reloads both. */
  orgOptions = computed<ResourceOrganization[]>(() =>
    this.orgsRes.status() === 'error' ? [] : this.orgsRes.value(),
  );

  /**
   * The reference-data catalogs the RPT facets (§3.2.1–§3.2.5) are drawn from:
   * vendor ("società"), project role ("job role"), skill ("skill matrix"),
   * skill catalog ("skill capability") and the proficiency scale behind the
   * minimum-level control. One rxResource over one forkJoin, not five: they are
   * all option lists for the SAME control group, so a partial success would
   * offer a half-populated filter panel with no way to say which half.
   *
   * All five reads are open to any authenticated principal (no `READ_RULES`
   * entry narrows them — only their MUTATIONS are admin/delivery-executive), so
   * this adds no role that can see the screen but not its filters.
   */
  private catalogsRes = rxResource<FacetCatalogs, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          vendors: this.api.getVendors(),
          projectRoles: this.api.getProjectRoles(),
          skills: this.api.getSkills(),
          skillCatalogs: this.api.getSkillCatalogs(),
          proficiencySets: this.api.getProficiencySets(),
        })
      : of(EMPTY_FACET_CATALOGS),
    defaultValue: EMPTY_FACET_CATALOGS,
  });
  /** READ-FAILURE GUARD, same contract as `pool`/`orgOptions` above: a THIRD
   *  independently failing read whose `.value()` throws at header bindings that
   *  sit outside every error panel. `candidateListState()` covers this leg too,
   *  so the empty envelope is never what the user is left looking at. */
  private catalogs = computed<FacetCatalogs>(() =>
    this.catalogsRes.status() === 'error' ? EMPTY_FACET_CATALOGS : this.catalogsRes.value(),
  );

  /** Every read the LEFT (Open Requests) panel derives from. */
  private requestInputs() {
    return [this.res];
  }

  /** Every read the RIGHT (candidate) panel derives from — one shared list, so
   *  the gate, the skeleton and the Retry cannot drift from what feeds them.
   *
   *  `benchRes` is deliberately NOT here: the availability strip is an ATTRIBUTE
   *  of a candidate, not the candidate list itself. A failed `/bench/monthly`
   *  must not blank out the ranking (which is this screen's primary answer and
   *  needs no bench data) — it degrades to a per-card "unavailable" plus its own
   *  Retry, which is the honest reduction. Every other leg here is one the
   *  candidate list cannot be computed without. */
  private candidateInputs() {
    return [this.res, this.orgsRes, this.catalogsRes];
  }

  /**
   * Tri-state for the requests pool. `isLoading()` alone is not the question:
   * with `authReady()` false the rxResource resolves its pre-auth default
   * SYNCHRONOUSLY, so isLoading() is false for the entire OIDC bootstrap window
   * and for the SSR HTML — which is how "No open requests available for
   * staffing." came to be rendered as a settled fact before any read had been
   * made. Not-ready counts as loading, never as ready-and-empty.
   */
  protected readonly poolState = computed<'error' | 'loading' | 'ready'>(() =>
    stateOf(this.requestInputs(), this.auth.authReady()),
  );

  /** Same tri-state for the candidate panel, over BOTH of its reads. */
  protected readonly candidateListState = computed<'error' | 'loading' | 'ready'>(() =>
    stateOf(this.candidateInputs(), this.auth.authReady()),
  );

  /** Retry target for the candidate panel: reloads every leg its state watches,
   *  so one Retry can never leave the other leg still failed. */
  protected reloadCandidateInputs(): void {
    for (const r of this.candidateInputs()) r.reload();
  }

  // D (Task 8): Capability / Practice / Competence / People Manager filters. '' =
  // all. Matched via `dimensionsOf`, not a raw equality against r.organization —
  // that is what makes a capability filter also match a resource attached BELOW
  // it (e.g. a competence two levels down).
  capabilityFilter = signal('');
  practiceFilter = signal('');
  competenceFilter = signal('');
  managerFilter = signal('');

  /** Option lists filtered by level, in tree order (node names are unique across the whole tree). */
  capabilityOptions = computed<string[]>(() => this.orgOptions().filter(n => n.level === 'capability').map(n => n.name));
  practiceOptions = computed<string[]>(() => this.orgOptions().filter(n => n.level === 'practice').map(n => n.name));
  competenceOptions = computed<string[]>(() => this.orgOptions().filter(n => n.level === 'competence').map(n => n.name));

  /** Distinct People Managers actually present among the (unfiltered) resource pool, name-sorted. */
  managerFilterOptions = computed<{ id: string; name: string }[]>(() => {
    const all = this.allResources();
    const ids = new Set(all.map(r => r.managerId).filter((id): id is string => !!id));
    return [...ids]
      .map(id => ({ id, name: all.find(r => r.id === id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  onCapabilityChange(event: Event): void {
    this.capabilityFilter.set((event.target as HTMLSelectElement).value);
  }
  onPracticeChange(event: Event): void {
    this.practiceFilter.set((event.target as HTMLSelectElement).value);
  }
  onCompetenceChange(event: Event): void {
    this.competenceFilter.set((event.target as HTMLSelectElement).value);
  }
  onManagerFilterChange(event: Event): void {
    this.managerFilter.set((event.target as HTMLSelectElement).value);
  }

  // ---------------------------------------------------------------------------
  // RPT "Ricerca Avanzata" — the remaining facets (manual §3.2.1–§3.2.5).
  //
  // Grouped behind a collapsed disclosure rather than added to the row above:
  // nine more controls in one flat row is a wall, and at 320px every control is
  // full-width and stacked, so the row above alone would already fill the
  // viewport. The disclosure keeps the visible control count at what it is today
  // (search + 4 dimension selects) and states how many hidden facets are active,
  // so a filter can never narrow the list invisibly.
  //
  // NOT here, and why:
  //   - "Cod. risorsa": there is no readable resource code column yet (a
  //     separate change adds one); a facet over UUIDs would be unusable.
  //   - "Livello professionale": not modelled anywhere — no column, no catalog,
  //     no field. See the header of candidate-filter.util.ts.
  //   - "Nome"/"Cognome" as two facets: `Resource.name` is one column; the free
  //     text box already substring-matches it.
  // ---------------------------------------------------------------------------
  /** RPT "anagrafica". */
  kindFilter = signal<'' | ResourceKind>('');
  /** RPT "società" — the vendor a subco belongs to. */
  vendorFilter = signal('');
  /** RPT "job role". */
  jobRoleFilter = signal('');
  /** RPT "skill matrix" — a skill name. */
  skillFilter = signal('');
  /**
   * Minimum proficiency for `skillFilter`. RESET whenever the skill changes: the
   * levels come from the SELECTED skill's own proficiency set, so a level 4 left
   * over from a skill measured 1-5 would silently filter a skill measured 1-3.
   * That reset is the whole reason this is a linkedSignal and not a signal.
   */
  minSkillLevel = linkedSignal<string, number | null>({
    source: () => this.skillFilter(),
    computation: () => null,
  });
  /** RPT "skill capability" — a skill-catalog id. */
  skillCatalogFilter = signal('');
  /** RPT "tariffa" — inclusive bounds on the effective cost rate in €/day. */
  rateMin = signal<number | null>(null);
  rateMax = signal<number | null>(null);

  /** Every facet value in one place, in the shape the pure filter consumes. */
  protected readonly facets = computed<CandidateFacetValues>(() => ({
    query: this.searchQuery(),
    capability: this.capabilityFilter(),
    practice: this.practiceFilter(),
    competence: this.competenceFilter(),
    managerId: this.managerFilter(),
    kind: this.kindFilter(),
    vendorId: this.vendorFilter(),
    jobRole: this.jobRoleFilter(),
    skill: this.skillFilter(),
    minSkillLevel: this.minSkillLevel(),
    skillCatalogId: this.skillCatalogFilter(),
    costRateDayMin: this.rateMin(),
    costRateDayMax: this.rateMax(),
  }));

  /** How many of the DISCLOSED facets are narrowing the list right now. */
  protected readonly advancedActiveCount = computed(() => advancedFacetCount(this.facets()));
  /** Whether anything at all is filtering — gates the "Clear filters" control. */
  protected readonly anyFacetActive = computed(() => hasAnyFacet(this.facets()));

  /**
   * Option lists come from the CATALOGS, not from the pool: they are the
   * controlled vocabularies a planner recognises (and the same rows the
   * configuration screens maintain). People Manager is the one exception above —
   * there is no manager catalog to read, so it is derived from the pool.
   */
  protected readonly kindOptions = RESOURCE_KINDS.map(k => ({ value: k, label: RESOURCE_KIND_LABELS[k] }));
  protected readonly vendorOptions = computed(() =>
    [...this.catalogs().vendors].sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly jobRoleOptions = computed(() =>
    [...this.catalogs().projectRoles].sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly skillOptions = computed(() =>
    [...this.catalogs().skills].sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly skillCatalogOptions = computed(() =>
    [...this.catalogs().skillCatalogs].sort((a, b) => a.name.localeCompare(b.name)),
  );

  /**
   * Proficiency levels of the SELECTED skill's own scale, ascending. Empty when
   * no skill is selected, or when that skill declares no proficiency set — in
   * both cases the control is disabled rather than offering a scale it invented.
   */
  protected readonly minLevelOptions = computed<{ value: number; label: string }[]>(() => {
    const skillName = this.skillFilter();
    if (skillName === '') return [];
    const skill = this.catalogs().skills.find(s => s.name === skillName);
    if (!skill?.proficiencySetId) return [];
    const set = this.catalogs().proficiencySets.find(p => p.id === skill.proficiencySetId);
    return [...(set?.levels ?? [])]
      .sort((a, b) => a.level - b.level)
      .map(l => ({ value: l.level, label: `${l.level} — ${l.name}` }));
  });

  onKindFilterChange(event: Event): void {
    this.kindFilter.set((event.target as HTMLSelectElement).value as '' | ResourceKind);
  }
  onVendorFilterChange(event: Event): void {
    this.vendorFilter.set((event.target as HTMLSelectElement).value);
  }
  onJobRoleFilterChange(event: Event): void {
    this.jobRoleFilter.set((event.target as HTMLSelectElement).value);
  }
  onSkillFilterChange(event: Event): void {
    this.skillFilter.set((event.target as HTMLSelectElement).value);
  }
  onMinLevelChange(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.minSkillLevel.set(raw === '' ? null : Number(raw));
  }
  onSkillCatalogFilterChange(event: Event): void {
    this.skillCatalogFilter.set((event.target as HTMLSelectElement).value);
  }
  /** A number input yields '' when cleared; '' is "no bound", not 0. */
  onRateBoundChange(bound: 'min' | 'max', raw: unknown): void {
    const target = bound === 'min' ? this.rateMin : this.rateMax;
    const n = typeof raw === 'number' ? raw : Number(raw);
    target.set(raw === null || raw === '' || !Number.isFinite(n) ? null : n);
  }

  /** Reset every facet, disclosed or not — the escape hatch for a filter the
   *  user cannot see because the panel is collapsed. */
  clearAllFilters(): void {
    this.searchQuery.set('');
    this.capabilityFilter.set('');
    this.practiceFilter.set('');
    this.competenceFilter.set('');
    this.managerFilter.set('');
    this.kindFilter.set('');
    this.vendorFilter.set('');
    this.jobRoleFilter.set('');
    this.skillFilter.set('');
    this.minSkillLevel.set(null);
    this.skillCatalogFilter.set('');
    this.rateMin.set(null);
    this.rateMax.set(null);
  }

  // ---------------------------------------------------------------------------
  // RPT "Disponibilità futura" (manual §3.2.2): the 6-month BENCH/PARTIAL/
  // ALLOCATED traffic light, on the card where the choice is made.
  //
  // The rollup, the 3 states and the fixed 6-month window already exist
  // server-side for /bench; this consumes them unchanged. `/bench` reads are
  // gated to exactly the roles that may read `/resources`, so no role can reach
  // this screen's candidate list and be refused its availability.
  // ---------------------------------------------------------------------------
  /** Local civil month: using UTC here advances/retards the window around local
   *  midnight at the month boundary. The API accepts this as its explicit start. */
  private readonly currentAvailabilityMonth = todayLocalIso().slice(0, 7);

  private benchRes = rxResource<BenchRollup, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready
      ? this.api.getBenchMonthly(this.currentAvailabilityMonth)
      : of(EMPTY_BENCH)),
    defaultValue: EMPTY_BENCH,
  });

  /**
   * READ-FAILURE GUARD for the rollup — `.value()` throws while the status is
   * 'error', and it is dereferenced once per candidate card.
   *
   * This is NOT the banned `status()==='error' ? [] : value()`: emptiness is
   * never the ANSWER here. `availabilityState()` below is what the strip reads,
   * and on 'error' it renders "unavailable" with a Retry and draws no dots at
   * all — the empty envelope exists only so the signal graph can settle behind
   * that panel. Six green dots derived from a failed read would be exactly the
   * confident-zero defect this codebase keeps re-fixing.
   */
  private benchRollup = computed<BenchRollup>(() =>
    this.benchRes.status() === 'error' ? EMPTY_BENCH : this.benchRes.value(),
  );

  protected readonly availabilityState = computed<AvailabilityReadState>(() => {
    if (this.benchRes.status() === 'error') return 'error';
    if (!this.auth.authReady() || this.benchRes.isLoading()) return 'loading';
    return 'ready';
  });

  /**
   * The current-forward slice of the rollup. Passing `from` above gives a current
   * six-month window on the modern API; this filter is the defensive half for a
   * stale cache/legacy response still anchored on an old Open planning period.
   * The label and every per-resource strip consume this exact array, so they can
   * never disagree about which months are being described.
   */
  protected readonly availabilityMonths = computed<string[]>(() =>
    [...new Set(this.benchRollup().months)]
      .filter(month => month >= this.currentAvailabilityMonth)
      .sort()
      .slice(0, 6),
  );

  /** Rollup rows by resource id. Internal and subco rows are one lookup: which
   *  half a candidate came from is a /bench grouping, not a fact about their
   *  availability. A DUMMY appears in neither — placeholders are excluded from
   *  the rollup by design — which is exactly the "no row" case the strip renders
   *  as explicitly untracked. */
  private benchRowById = computed<Map<string, BenchRow>>(() => {
    const rollup = this.benchRollup();
    return new Map([...rollup.internalRows, ...rollup.subcoRows].map(r => [r.resourceId, r]));
  });

  protected benchRowFor(resourceId: string): BenchRow | undefined {
    return this.benchRowById().get(resourceId);
  }

  protected reloadAvailability(): void {
    this.benchRes.reload();
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  /** Window label for the exact current-forward months rendered in every strip. */
  protected readonly availabilityWindowLabel = computed(() => {
    const months = this.availabilityMonths();
    if (months.length === 0) return '';
    const fmt = (m: string) => StaffingComponent.MONTH_FMT.format(new Date(m + '-01T00:00:00Z'));
    return `${fmt(months[0])} – ${fmt(months[months.length - 1])}`;
  });

  assigningResourceId = signal<string | null>(null);

  /** Booking window + allocation for the new assignment. Default to the selected request's dates / 100% allocation. */
  assignStartDate = signal<string>('');
  assignEndDate = signal<string>('');
  assignAllocationPct = signal<number>(100);

  /** True while a createAssignment request is in flight, to block duplicate submits (double-staffing). */
  assigning = signal(false);

  /** The Allocation % input of the currently revealed proposal panel (only one
   *  candidate can be open at a time, so this query is single-valued). */
  private allocInput = viewChild<ElementRef<HTMLInputElement>>('allocInput');
  private hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The candidate whose panel focus has already been moved into — so a later
   *  re-render cannot steal focus back from wherever the user has moved it. */
  private focusMovedFor: string | null = null;
  /** The candidate whose Assign button must regain focus once the panel closes.
   *  Set ONLY by an explicit Cancel: the other callers of cancelAssign() change
   *  the selection (and therefore the whole candidate list), where pulling focus
   *  back to a button that may no longer exist would be wrong. */
  private restoreFocusTo: string | null = null;

  constructor() {
    // Focus follows the reveal. `afterRenderEffect` (the allocation-calendar
    // convention in this codebase) re-runs on the signals it reads and NEVER runs
    // on the server, so this reacts to the panel actually being in the DOM
    // instead of guessing when that happens, and stays SSR-safe.
    afterRenderEffect(() => {
      const open = this.assigningResourceId();
      if (open) {
        if (this.focusMovedFor === open) return;
        const input = this.allocInput()?.nativeElement;
        if (!input) return;
        this.focusMovedFor = open;
        this.restoreFocusTo = null;
        input.focus();
        return;
      }
      this.focusMovedFor = null;
      const restore = this.restoreFocusTo;
      if (!restore) return;
      this.restoreFocusTo = null;
      this.hostEl.nativeElement
        .querySelector<HTMLButtonElement>(`[data-assign-for="${restore}"]`)
        ?.focus();
    });
  }

  /**
   * The pool anyone may actually be staffed FROM: everybody minus the people who
   * have already left. A stored `terminationDate` is never revisited elsewhere
   * (there is no DELETE /resources), so a departed employee stayed in this pool
   * and was ranked as a candidate — scored, listed with an "Assign" button and
   * captioned "100% Utilized", which reads "busy", never "left the company".
   * Clicking Assign then either 400s with the server's employment check ("booking
   * date … is after terminationDate …") behind a generic toast, or, on a request
   * with no dates, SUCCEEDS and books a departed employee.
   *
   * Filtered here rather than inside `searchedResources` so BOTH consumers share
   * it: `missingSkillGap` counted a leaver's skills as capability coverage, which
   * suppressed exactly the hire/subcontract signal that panel exists to raise.
   * The employment filter is applied BEFORE the search filter on purpose — the
   * comment on `missingSkillGap` justifies bypassing the SEARCH filter, not this.
   */
  private staffableResources = computed<Resource[]>(() => {
    const today = todayLocalIso();
    return this.allResources().filter(r => !isTerminatedAsOf(r, today));
  });

  /**
   * Resources after applying EVERY facet — the free-text box, the four org/
   * manager dimensions and the RPT advanced facets — the single filtering
   * computed both `rankedCandidates` and `displayedResources` derive from, so a
   * facet narrows the pool the same way whether or not a request is selected.
   *
   * The predicate itself lives in `candidate-filter.util.ts`, unit-tested
   * without a TestBed: with thirteen facets ANDing together, one `||` slipped in
   * between two of them widens the result set in a way that still looks
   * plausible on a small pool.
   */
  private searchedResources = computed(() =>
    filterCandidates(this.staffableResources(), this.facets(), {
      orgNodes: this.orgOptions(),
      skills: this.catalogs().skills,
    }),
  );

  /**
   * When a request is selected, rank the searched resources by match score (desc) using the
   * shared scorer. Returns null when no request is selected (plain resource list mode).
   */
  rankedCandidates = computed<CandidateScore[] | null>(() => {
    const req = this.selectedRequest();
    if (!req) return null;
    return rankCandidates(this.searchedResources(), req);
  });

  /** Plain list of resources shown when no request is selected. */
  displayedResources = computed(() => this.searchedResources());

  /**
   * Skills the request needs that NO STAFFABLE resource can cover.
   * Computed over the whole staffable pool (not the filtered search) so a stray
   * search term can't hide a genuine capability gap that warrants hiring /
   * upskilling — but leavers are excluded, because a skill only a departed
   * employee holds is precisely a gap, not coverage.
   */
  missingSkillGap = computed<string[]>(() => {
    const req = this.selectedRequest();
    if (!req) return [];
    // An unavailable pool covers nothing, so requestSkillGap would report EVERY
    // required skill as missing and the banner would raise a confident
    // "nobody can cover these skills" hiring signal about data we do not have.
    // Saying nothing is the only honest answer here; the panel below says why.
    if (this.poolState() !== 'ready') return [];
    return requestSkillGap(this.staffableResources(), req);
  });

  /** Per-dimension meters for a candidate, in display order, normalised to their own weight. */
  meters(candidate: CandidateScore): DimensionMeter[] {
    const b = candidate.breakdown;
    const order: { key: MatchDimension; label: string; short: string }[] = [
      { key: 'skillCoverage', label: 'Skill coverage', short: 'Skills' },
      { key: 'proficiency', label: 'Proficiency', short: 'Prof' },
      { key: 'roleFit', label: 'Role fit', short: 'Role' },
      { key: 'availability', label: 'Availability', short: 'Avail' },
      { key: 'marginFit', label: 'Margin', short: 'Margin' },
    ];
    return order.map(({ key, label, short }) => {
      const weight = MATCH_WEIGHTS[key];
      const value = b[key];
      return {
        key,
        label,
        short,
        value,
        weight,
        pct: weight > 0 ? Math.round((value / weight) * 100) : 0,
      };
    });
  }

  /** Tailwind bar colour for the overall score. */
  scoreBarClass(score: number): string {
    if (score >= 70) return 'bg-positive';
    if (score >= 40) return 'bg-caution';
    return 'bg-critical';
  }

  /** Tailwind text colour for the overall score number (AA contrast on white). */
  scoreTextClass(score: number): string {
    if (score >= 70) return 'text-positive-text';
    if (score >= 40) return 'text-caution-text';
    return 'text-critical-text';
  }

  /** Human-readable breakdown tooltip for a candidate's overall score. */
  scoreTooltip(candidate: CandidateScore): string {
    return this.meters(candidate)
      .map(m => `${m.label}: ${m.value.toFixed(1)} / ${m.weight}`)
      .join('\n');
  }

  selectRequest(req: ResourceRequest) {
    this.selectedRequest.set(req);
    this.cancelAssign();
  }

  clearSelection() {
    this.selectedRequest.set(null);
    this.cancelAssign();
  }

  startAssign(resourceId: string) {
    const req = this.selectedRequest();
    if (req) {
      this.assigningResourceId.set(resourceId);
      // Seed the booking window from the request; allocation defaults to a full 100%.
      this.assignStartDate.set(req.startDate ?? '');
      this.assignEndDate.set(req.endDate ?? '');
      this.assignAllocationPct.set(100);
    }
  }

  /**
   * Close the proposal panel. `restoreFocus` is opt-in (same shape as app.ts's
   * `closeMenu(restoreFocus = false)`): the dialog's own Cancel control passes
   * true so the keyboard user returns to the Assign button they came from, while
   * the selection-changing callers (selectRequest / clearSelection / a successful
   * create) leave focus alone — the candidate list they rebuild may not even
   * contain that button any more.
   */
  cancelAssign(restoreFocus = false) {
    if (restoreFocus) this.restoreFocusTo = this.assigningResourceId();
    this.assigningResourceId.set(null);
    this.assignStartDate.set('');
    this.assignEndDate.set('');
    this.assignAllocationPct.set(100);
  }

  /**
   * Create a proposal (assignment). `status` is no longer client-settable (B3):
   * the server always derives 'Draft' for a brand-new assignment — it has no
   * month rows yet. Sending it for approval now happens per-month, from the
   * resource's calendar (`POST /assignments/:id/months/:month/submit`), once
   * hours have been booked into an open month.
   */
  confirmAssign(resourceId: string) {
    if (this.assigning()) return;
    const req = this.selectedRequest();
    if (req) {
      this.assigning.set(true);
      const startDate = this.assignStartDate().trim();
      const endDate = this.assignEndDate().trim();
      const allocationPct = this.assignAllocationPct();
      this.api.createAssignment({
        requestId: req.id,
        resourceId: resourceId,
        // Carry the booking window + allocation; omit empty dates so the schedule
        // util falls back to the linked request's dates.
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(Number.isFinite(allocationPct) ? { allocationPct } : {})
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (created) => {
          this.assigning.set(false);
          this.cancelAssign();
          this.selectedRequest.set(null);
          this.res.reload();
          this.notifications.show(this.assignmentResultMessage(created), 'success');
        },
        // The server's refusals here are specific and actionable (an employment
        // window, an overlapping booking, a closed month); the fixed string threw
        // all of them away and left the user with a dead control and no reason.
        // Same shape as project-details.ts's freezeCostBaseline handler.
        error: (err: { error?: { error?: string } }) => {
          this.assigning.set(false);
          this.notifications.show(err.error?.error ?? 'Unable to create the allocation', 'error');
        }
      });
    }
  }

  /**
   * Confirmation toast for the created proposal. `a.status` is always 'Draft'
   * here (B3: status is server-derived and a brand-new assignment has no month
   * rows yet, so create can never yield anything else) — no per-status lookup
   * needed any more. Points the user at where the lifecycle continues next,
   * since creating the proposal no longer opens an approval on its own.
   */
  private assignmentResultMessage(a: Assignment): string {
    const name = this.allResources().find(r => r.id === a.resourceId)?.name ?? 'Resource';
    return `${name}: proposal saved as a draft — submit the month for approval from the allocation calendar`;
  }
}
