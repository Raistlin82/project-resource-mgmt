import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Resource, Assignment, ResourceOrganization } from '../services/api.service';
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
import { dimensionsOf, isTerminatedAsOf } from '../services/org-scope.util';
import { todayLocalIso } from '../services/local-date.util';
import { ListStateComponent } from '../shared/list-state.component';
import { ResourceKindBadgeComponent } from '../shared/resource-kind-badge.component';

interface DimensionMeter {
  key: MatchDimension;
  label: string;
  short: string;
  value: number;
  weight: number;
  pct: number;
}

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
  imports: [MatIconModule, DecimalPipe, FormsModule, ListStateComponent, ResourceKindBadgeComponent],
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
    this.pool().requests.filter(r => r.status === 'Open' || r.status === 'Published')
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

  /** Every read the LEFT (Open Requests) panel derives from. */
  private requestInputs() {
    return [this.res];
  }

  /** Every read the RIGHT (candidate) panel derives from — one shared list, so
   *  the gate, the skeleton and the Retry cannot drift from what feeds them. */
  private candidateInputs() {
    return [this.res, this.orgsRes];
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
   * Resources after applying the free-text search box (name / role / skills)
   * AND the D (Task 8) capability/practice/competence/People Manager filters —
   * the single filtering computed both `rankedCandidates` and
   * `displayedResources` derive from, so a filter narrows the pool the same
   * way whether or not a request is selected.
   */
  private searchedResources = computed(() => {
    const resources = this.staffableResources();
    const query = this.searchQuery().trim().toLowerCase();
    const cap = this.capabilityFilter();
    const pra = this.practiceFilter();
    const com = this.competenceFilter();
    const mgr = this.managerFilter();
    const nodes = this.orgOptions();
    return resources.filter(r => {
      const dims = dimensionsOf(r, nodes);
      if (cap && dims.capability !== cap) return false;
      if (pra && dims.practice !== pra) return false;
      if (com && dims.competence !== com) return false;
      if (mgr && r.managerId !== mgr) return false;
      if (!query) return true;
      return (
        r.name.toLowerCase().includes(query) ||
        r.role.toLowerCase().includes(query) ||
        r.skills.some(s => s.name.toLowerCase().includes(query))
      );
    });
  });

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
