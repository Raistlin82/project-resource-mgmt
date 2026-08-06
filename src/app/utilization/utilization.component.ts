import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource, Assignment, ResourceRequest, TimeEntry, ResourceOrganization, type BenchRollup } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { DecimalPipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { scopeOf } from '../services/org-scope.util';
import { kindOf, countsTowardInternalCapacity } from '../services/resource-kind.util';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import { todayLocalIso } from '../services/local-date.util';
import { ListStateComponent } from '../shared/list-state.component';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

interface UtilizationData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
  timeEntries: TimeEntry[];
  orgs: ResourceOrganization[];
  benchRollup: BenchRollup;
}

@Component({
  selector: 'app-utilization',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ReactiveFormsModule, ListStateComponent, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Resource Utilization</h1>
        <div class="command-card flex items-center gap-3 px-5 py-3">
          <span class="command-kpi-label">Team Average:</span>
          @if (hasError()) {
            <!-- Task 8: benchRollup joined dataResource's forkJoin as a REQUIRED
                 leg (no catchError — Global Constraint: a failed bench read must
                 surface as an error, never a confident zero). forkJoin is
                 fail-fast, so ANY required leg failing (this one, or the
                 pre-existing resources/assignments/requests/timeEntries legs)
                 now puts dataResource().status()==='error', and every computed
                 below reads dataResource.value() unconditionally — a value that
                 throws while erroring. This branch is the guard: it is never
                 entered together with the @else below, so countedForAverage()/
                 averageUtilization() are never evaluated during an error, the
                 same short-circuiting principle list-state.component.ts's own
                 contentTemplate uses. Deliberately its OWN wording ("Unavailable"),
                 never the "—" dash below: that dash means "legitimately nothing
                 to measure" (spec §4) and must not be reused for "the read
                 failed" — the two are a different fact and collapsing them is
                 exactly the confident-zero-on-failure defect this codebase has
                 hit before. -->
            <span data-test="team-average" class="text-sm font-bold text-critical-text">Unavailable</span>
          } @else {
            <!-- countedForAverage() empty is NOT "0% utilization" — averageUtilization()
                 returns 0 on an empty denominator (spec §4 last row: the value 0 is
                 correct and matches /reporting), but colour-banding that 0 through
                 getUtilizationColorText falls through to the critical/red band, which
                 reads as "my team is completely idle" for what is really "nothing here
                 is measurable" (e.g. a subtree of only pre-staffed dummy/subco rows).
                 /utilization is the only surface that colour-bands this KPI at all
                 (/reporting's equivalent tile uses a fixed colorClass) — show a neutral
                 dash instead of a red 0% when there is nothing to divide by. -->
            <span data-test="team-average" class="text-xl font-black tracking-tight font-mono tabular-nums"
                  [class]="countedForAverage().length ? getUtilizationColorText(averageUtilization()) : 'text-ink-muted'">
              @if (countedForAverage().length) {
                {{ averageUtilization() | number:'1.0-0' }}%
              } @else {
                —
              }
            </span>
            @if (hasUncountedRows()) {
              <!-- command-kpi-note (src/styles.css) carries margin-top: 0.55rem for its
                   usual home stacked under a KPI value in a .command-kpi card. Here it
                   is a flex sibling of the percentage instead, so that top margin would
                   offset it out of vertical alignment; the mt-0! Tailwind v4 important
                   modifier (same pattern as border-critical! on list-state.component.ts)
                   zeroes it for this one usage without a new command-* rule. -->
              <span data-test="kpi-internal-note" class="command-kpi-note mt-0!">internal only</span>
            }
          }
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
        <!-- Left Pane: Managed Resources -->
        <div class="lg:col-span-1 command-card overflow-hidden flex flex-col h-[min(800px,80vh)]">
          <div class="command-card-header">
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">My Team</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Resources you manage</p>
              </div>
              <div class="inline-flex rounded-md border border-[var(--cc-line-strong)] bg-[var(--cc-surface)] p-1"
                   role="group" aria-label="Team scope">
                <button type="button" data-test="team-scope-direct"
                        (click)="teamScope.set('direct')"
                        [attr.aria-pressed]="teamScope() === 'direct'"
                        class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
                        [class]="teamScope() === 'direct' ? 'bg-accent text-white shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
                  Direct reports
                </button>
                <button type="button" data-test="team-scope-org"
                        (click)="teamScope.set('org')"
                        [attr.aria-pressed]="teamScope() === 'org'"
                        class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
                        [class]="teamScope() === 'org' ? 'bg-accent text-white shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
                  All my org
                </button>
              </div>
            </div>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-[var(--cc-line)]">
            <app-list-state [loading]="loading()" [error]="hasError()" skeleton="cards" [rows]="4" label="team utilization" (retry)="dataResource.reload()">
              <ng-template>
                @for (res of managedResources(); track res.id) {
                  <!-- role="button" below makes this card a COMPOSITE: ARIA prunes
                       every descendant from the accessibility tree, so the
                       utilization % and the BENCH/PARTIAL/ALLOCATED badge rendered
                       inside it are never announced — the two facts this list
                       exists to compare. The accessible NAME is therefore their
                       only carrier. Number pipe, not raw interpolation: the
                       ≤2-decimals rule governs the spoken string exactly as it
                       governs the visible one. benchBadgeSuffix() rather than
                       benchBadge() inline, so the ", <state>" separator travels
                       WITH the value and an absent bench row cannot leave the
                       name ending in a dangling comma. -->
                  <div class="p-6 hover:bg-surface-muted transition-all cursor-pointer group relative"
                       [class.bg-accent-tint]="selectedResource()?.id === res.id"
                       role="button"
                       tabindex="0"
                       [attr.aria-label]="'Select ' + res.name + ', utilization ' + (res.utilization | number:'1.0-0') + '%' + benchBadgeSuffix(res)"
                       [attr.aria-pressed]="selectedResource()?.id === res.id"
                       (keydown.enter)="selectResource(res)"
                       (keydown.space)="selectResource(res); $event.preventDefault()"
                       (click)="selectResource(res)">
                    @if (selectedResource()?.id === res.id) {
                      <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-[var(--cc-primary)] rounded-r-full"></div>
                    }
                    <div class="flex items-center justify-between mb-4">
                      <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex items-center justify-center font-display font-bold text-lg text-[var(--cc-ink)] group-hover:scale-105 transition-transform">
                          {{ res.name.charAt(0) }}
                        </div>
                        <div>
                          <h3 data-test="team-member" class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors">{{ res.name }}</h3>
                          <p class="text-xs font-semibold tracking-wide text-[var(--cc-muted)] uppercase mt-0.5">{{ res.role }}</p>
                        </div>
                      </div>
                      <span class="command-status" data-test="bench-badge"
                            [class.neutral]="benchBadge(res) === 'Not applicable'"
                            [class.red]="benchBadge(res) === 'BENCH'"
                            [class.amber]="benchBadge(res) === 'PARTIAL'"
                            [class.green]="benchBadge(res) === 'ALLOCATED'">{{ benchBadge(res) }}</span>
                    </div>
                    <div class="mt-4">
                      <div class="flex items-center justify-between text-xs mb-2">
                        <span class="command-kpi-label">Utilization</span>
                        <span class="font-black text-sm font-mono tabular-nums" [class]="getUtilizationColorText(res.utilization)">{{ res.utilization | number:'1.0-0' }}%</span>
                      </div>
                      <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden">
                        <div class="h-full rounded-full transition-all duration-500 ease-out"
                             [class]="getUtilizationColorClass(res.utilization)"
                             [style.width.%]="res.utilization > 100 ? 100 : res.utilization"></div>
                      </div>
                    </div>
                  </div>
                }
                @if (managedResources().length === 0) {
                  <div data-test="team-empty" class="p-12 text-center text-sm text-[var(--cc-muted)]">
                    @if (teamScope() === 'direct') {
                      Nobody is set up to report directly to you.
                    } @else {
                      You do not manage any organization, and nobody reports to you.
                    }
                  </div>
                }
              </ng-template>
            </app-list-state>
          </div>
        </div>

        <!-- Right Pane: Resource Details & Assignments -->
        <div class="lg:col-span-2 flex flex-col gap-6 sm:gap-8">
          <!-- Round-1 fix (Task 8 CRITICAL): this pane is evaluated on every CD
               pass regardless of which team-list row is showing. selectedResource()
               (below) reads resources(), which dereferences dataResource.value() —
               and once benchRollup became a 5th REQUIRED forkJoin leg, a bench-read
               failure on ANY reload (e.g. after approving a time entry, which
               calls dataResource.reload() on success) flips status() to 'error'
               and .value() throws. Wrapping in app-list-state defers evaluating
               this pane's own @if/@else (and everything selectedResource()-derived
               inside it) until neither loading() nor hasError() — the same
               contentTemplate-deferral list-state.component.ts already documents —
               so a reload failure shows the shared error affordance here too,
               never an uncaught exception that takes the whole page down
               (contract-details.ts:1042-1044 names exactly this failure mode). -->
          <app-list-state [loading]="loading()" [error]="hasError()" skeleton="block" [rows]="3" label="resource details" (retry)="dataResource.reload()">
            <ng-template>
              @if (selectedResource()) {
                <!-- Resource Header -->
                <div class="command-card p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                  <div>
                    <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">{{ selectedResource()?.name }}</h2>
                    <p class="text-[var(--cc-muted)] font-medium mt-2">{{ selectedResource()?.role }} <span class="mx-2 text-ink-muted">•</span> Capacity: <span class="font-bold text-[var(--cc-ink)] font-mono tabular-nums">{{ selectedResource()?.capacity | number:'1.0-2' }}h/week</span></p>
                  </div>
                  <div class="text-left sm:text-right command-card-muted p-4">
                    <div class="text-4xl font-black tracking-tighter font-mono tabular-nums" [class]="getUtilizationColorText(selectedResource()?.utilization || 0)">
                      {{ selectedResource()?.utilization | number:'1.0-0' }}%
                    </div>
                    <div class="text-sm font-bold tracking-wide uppercase mt-1" [class]="getStatusColorText(selectedResource()?.utilization || 0)">
                      {{ getStatusText(selectedResource()?.utilization || 0) }}
                    </div>
                  </div>
                </div>

                <!-- Assignments -->
                <div class="command-card overflow-hidden flex-1 flex flex-col">
                  <div class="p-6 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Assignments</h3>
                    <!-- /utilization's route guard is canReadStaffing(), which admits
                         'finance' — but /assignments mutations are canManageStaffing
                         only, so an unconditional Create/Paste/Edit/Delete cluster
                         offered finance four affordances the server answers with 403
                         and an error toast (the row never moves). The capability is
                         read LIVE through the signal, never snapshot, so a role that
                         resolves after the OIDC bootstrap settles gets the right
                         controls rather than the anonymous default's. The gate is UX
                         only — src/server.ts remains the boundary. -->
                    @if (canManageStaffing()) {
                      <div class="flex flex-wrap gap-3">
                        @if (copiedAssignment()) {
                          <button (click)="pasteAssignment()" class="command-button secondary flex-1 sm:flex-none">
                            <mat-icon class="text-[18px] w-[18px] h-[18px]">content_paste</mat-icon> Paste
                          </button>
                        }
                        <button (click)="openCreateForm()" class="command-button flex-1 sm:flex-none">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create
                        </button>
                      </div>
                    }
                  </div>

                  @if (showForm() && canManageStaffing()) {
                    <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
                      <h4 class="font-display font-bold text-[var(--cc-ink)] text-lg mb-6">{{ editingAssignmentId() ? 'Edit Assignment' : 'New Assignment' }}</h4>
                      <form [formGroup]="assignmentForm" (ngSubmit)="saveAssignment()" class="space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <div class="md:col-span-2">
                            <label for="requestId" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Project / Request *</label>
                            <select id="requestId" formControlName="requestId" class="command-select">
                              <option value="">Select a project...</option>
                              @for (req of allRequests(); track req.id) {
                                <option [value]="req.id">{{ req.name }} ({{ req.requiredRole }})</option>
                              }
                            </select>
                          </div>
                          <div class="command-card-muted p-4 text-sm text-[var(--cc-muted)]">
                            <span class="font-bold text-[var(--cc-ink)]">Hours come from daily bookings.</span>
                            Use the Allocation Calendar on the resource request to add or change them.
                          </div>
                        </div>
                        <div class="flex justify-end gap-3 pt-2">
                          <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                          <button type="submit" [disabled]="!assignmentForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
                        </div>
                      </form>
                    </div>
                  }

                  <div class="divide-y divide-[var(--cc-line)] overflow-y-auto">
                    @for (assignment of resourceAssignments(); track assignment.id) {
                      <div class="p-6 sm:p-8 hover:bg-surface-muted transition-colors flex flex-col sm:flex-row sm:items-center justify-between group gap-4">
                        <div>
                          <h4 class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors">{{ getRequestName(assignment.requestId) }}</h4>
                          <div class="flex items-center gap-3 mt-2">
                            <span class="text-sm font-bold text-ink-secondary bg-surface-muted px-2.5 py-1 rounded-md font-mono tabular-nums">{{ assignment.assignedHours }} hours</span>
                            <span class="command-status uppercase">
                              {{ assignment.status }}
                            </span>
                          </div>
                        </div>
                        @if (canManageStaffing()) {
                          <!-- focus-within:opacity-100 is load-bearing, not cosmetic.
                               From the sm breakpoint up this cluster is opacity-0
                               until hover, so a keyboard user Tabbing into it moved
                               the caret onto three consecutive INVISIBLE stops —
                               including Delete, whose focus ring rendered as nothing
                               — and Enter fired on a control they could not see. The
                               mouse path is unaffected, which is why click-through
                               testing never surfaced it. Revealing the cluster
                               whenever focus is anywhere inside it is the same
                               one-word fix projects.ts:99 already carries. -->
                          <div class="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            <button (click)="copyAssignment(assignment)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-[var(--cc-primary-text)] hover:border-accent hover:bg-accent-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Copy assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Copy assignment for ' + getRequestName(assignment.requestId)">
                              <mat-icon class="text-[20px] w-[20px] h-[20px]">content_copy</mat-icon>
                            </button>
                            <button (click)="openEditForm(assignment)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-[var(--cc-primary-text)] hover:border-accent hover:bg-accent-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Edit assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Edit assignment for ' + getRequestName(assignment.requestId)">
                              <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                            </button>
                            <button (click)="askDeleteAssignment(assignment)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Delete assignment for ' + getRequestName(assignment.requestId)">
                              <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                            </button>
                          </div>
                        }
                      </div>
                    }
                    @if (resourceAssignments().length === 0) {
                      <div class="p-12 text-center text-sm text-[var(--cc-muted)]">No assignments found for this resource.</div>
                    }
                  </div>
                </div>

                <!-- pendingDelete carries the project and resource NAMES captured
                     at arm time rather than the row, and that is what keeps this
                     dialog safe: re-deriving the project name here would call
                     getRequestName() -> allRequests() -> dataResource.value(),
                     which THROWS while status() === 'error' (see the hasError()
                     guard around the Team Average tile above), and a
                     dialog is exactly the kind of markup that outlives the read
                     that armed it. Kept inside @if (selectedResource()) so it
                     shares the lifetime of the pane whose row armed it — a
                     stranded overlay over an error state has no Cancel context. -->
                @if (pendingDelete(); as pending) {
                  <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                       appModal ariaLabelledby="assignmentDeleteTitle" (dismiss)="cancelDeleteAssignment()">
                    <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
                      <div class="p-6 text-center">
                        <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                          <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
                        </div>
                        <h3 id="assignmentDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete assignment on {{ pending.project }}</h3>
                        <!-- Name the DERIVED effects, not just the row: the server
                             recomputes the request's staffed effort and this
                             resource's utilization under a lock as a side effect of
                             the DELETE, so the numbers on /staffing, /bench and this
                             very screen move for reasons the deleted row no longer
                             explains. Neither this screen nor any other can put the
                             assignment back. -->
                        <p class="text-[var(--cc-muted)] text-sm">
                          Removing {{ pending.resource }} from {{ pending.project }} re-opens that share of the
                          request: the server recomputes the request's staffed effort and this resource's
                          utilization. This cannot be undone from this screen.
                        </p>
                      </div>
                      <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
                        <button type="button" (click)="cancelDeleteAssignment()" class="command-button secondary">Cancel</button>
                        <button type="button" (click)="confirmDeleteAssignment()" class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm">Delete assignment</button>
                      </div>
                    </div>
                  </div>
                }

                <div class="command-card overflow-hidden">
                  <div class="command-card-header">
                    <div>
                      <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Actual Time Approval</h3>
                      <p class="mt-1 text-sm text-[var(--cc-muted)]">Approve submitted hours so they become actual delivery cost.</p>
                    </div>
                  </div>
                  <div class="divide-y divide-[var(--cc-line)]">
                    @for (entry of resourceTimeEntries(); track entry.id) {
                      <div class="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <div class="font-bold text-[var(--cc-ink)]">{{ getRequestName(entry.requestId) }}</div>
                          <div class="text-sm text-[var(--cc-muted)] mt-1 font-mono tabular-nums">{{ entry.date }} · {{ entry.hours | number:'1.0-2' }}h · {{ entry.notes || 'No notes' }}</div>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="command-status"
                                [class.amber]="entry.status === 'Submitted'"
                                [class.green]="entry.status === 'Approved'"
                                [class.red]="entry.status === 'Rejected'">
                            {{ entry.status }}
                          </span>
                          @if (entry.status === 'Submitted') {
                            <button (click)="approveTimeEntry(entry)" class="p-2 rounded-md text-positive-text hover:bg-positive-tint" [attr.aria-label]="'Approve ' + entry.hours + ' hours for ' + getRequestName(entry.requestId) + ' on ' + entry.date" [attr.title]="'Approve ' + entry.hours + 'h time entry'">
                              <mat-icon>check_circle</mat-icon>
                            </button>
                            <button (click)="rejectTimeEntry(entry)" class="p-2 rounded-md text-critical-text hover:bg-critical-tint" [attr.aria-label]="'Reject ' + entry.hours + ' hours for ' + getRequestName(entry.requestId) + ' on ' + entry.date" [attr.title]="'Reject ' + entry.hours + 'h time entry'">
                              <mat-icon>cancel</mat-icon>
                            </button>
                          }
                        </div>
                      </div>
                    }
                    @if (!resourceTimeEntries().length) {
                      <div class="p-8 text-center text-sm text-[var(--cc-muted)]">No actual time entries for this resource.</div>
                    }
                  </div>
                </div>
              } @else {
                <div class="command-card h-full flex flex-col items-center justify-center p-12 text-center">
                  <div class="w-20 h-20 rounded-full border border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex items-center justify-center text-[var(--cc-primary)] mb-6">
                    <mat-icon class="text-4xl">people</mat-icon>
                  </div>
                  <h2 class="command-empty-title">Select a Resource</h2>
                  <p class="text-[var(--cc-muted)] mt-3 max-w-sm text-sm leading-relaxed">Choose a resource from your team on the left to view and manage their utilization and assignments.</p>
                </div>
              }
            </ng-template>
          </app-list-state>
        </div>
      </div>
    </div>
  `
})
export class UtilizationComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);

  // Current authenticated user (Resource Manager) id used for authorization.
  // Read LIVE, never snapshot at field-init (see auth.service note): a captured
  // value freezes the anonymous default and scopes the wrong manager on reload.
  private get currentManagerId(): string { return this.auth.userId(); }

  /**
   * This route's guard is `canReadStaffing()`, which admits 'finance' — but every
   * /assignments mutation is `canManageStaffing()`. Exposed as the signal itself
   * (never `this.auth.canManageStaffing()` snapshotted at field-init), so it is
   * re-read on each CD pass and a role resolved after the OIDC bootstrap settles
   * gets the right controls instead of the anonymous default's. UX only: the
   * handlers below re-check it, and src/server.ts is the actual boundary.
   */
  protected readonly canManageStaffing = this.auth.canManageStaffing;

  // resources and time-entries are principal-gated server-side: key the forkJoin
  // on auth readiness so it fires only AFTER the OAuth bootstrap has settled and
  // the bearer token is attached; firing earlier (e.g. on a reload/deep-link) sent
  // unauthenticated requests that 401'd and forkJoin's fail-fast collapsed the
  // whole view to empty (and never recovered).
  // protected (not private): the template calls `dataResource.reload()`
  // directly for the retry affordance, matching the same-file convention
  // used by resourcesRes/dataRes elsewhere in this codebase.
  protected dataResource = rxResource<UtilizationData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            assignments: this.api.getAssignments(),
            requests: this.api.getRequests(),
            timeEntries: this.api.getTimeEntries(),
            // forkJoin is fail-fast: an error on ANY leg throws the whole
            // resource, and dataResource.value() re-throws that, so an
            // isolated failure here would otherwise collapse the Direct
            // reports list, the assignments pane and the time-approval pane —
            // none of which read the org tree at all. Only the 'org' scope
            // view consumes it, and degrades correctly on an empty array:
            // scopeOf(..., []) has no managed org roots, so it falls back to
            // the org-chart axis alone (the same behaviour as "tree not yet
            // loaded" in the design's error table). Confine the catch to this
            // leg — the other four are genuinely required and must still
            // fail fast.
            orgs: this.api.getResourceOrganizations().pipe(catchError(() => of<ResourceOrganization[]>([]))),
            // REQUIRED leg, deliberately no catchError: unlike the 'orgs' leg
            // above, a failed bench read must surface as an error, never
            // silently degrade to "nobody is on bench" (Global Constraint —
            // a failed/forbidden read must never render as a confident zero).
            benchRollup: this.api.getBenchMonthly(),
          })
        : of<UtilizationData>({ resources: [], assignments: [], requests: [], timeEntries: [], orgs: [], benchRollup: EMPTY_BENCH_ROLLUP }),
    defaultValue: { resources: [], assignments: [], requests: [], timeEntries: [], orgs: [], benchRollup: EMPTY_BENCH_ROLLUP }
  });

  resources = computed(() => this.dataResource.value().resources);
  assignments = computed(() => this.dataResource.value().assignments);
  allRequests = computed(() => this.dataResource.value().requests);
  timeEntries = computed(() => this.dataResource.value().timeEntries);
  orgNodes = computed(() => this.dataResource.value().orgs);

  /**
   * Explicitly folds in !authReady() rather than trusting dataResource.isLoading()
   * alone — same shape as bench.component.ts's `loading` (the Task 7 reference):
   * the pre-authReady stream branch resolves synchronously to the empty
   * default, which would otherwise let isLoading() go false while the page is
   * still showing the pre-auth empty rollup/resources as if they were fact.
   */
  protected readonly loading = computed(() => !this.auth.authReady() || this.dataResource.isLoading());
  protected readonly hasError = computed(() => this.dataResource.status() === 'error');

  // --- Bench badge (Task 8) ---
  // BenchRollup's rows are keyed to the SAME dataResource as `resources`/etc.,
  // so the badge can never desynchronise from the rows it decorates: there is
  // no second independent read, hence no way for this page to be "half
  // loaded" with rows present but bench state still in flight.
  /**
   * The month the badge speaks about: TODAY's month, and only if the fetched bench
   * window contains it — the same rule bench.component.ts and the dashboard tile use.
   *
   * It used to be `months[0]`, which the server anchors on the OLDEST Open planning
   * period (four months in the past with the shipped seed), so the badge decorating a
   * row of present-tense utilisation figures reported a state from last spring.
   * `todayLocalIso()`, not `new Date().toISOString()` — the UTC form names the wrong
   * month around midnight on the 1st east of UTC and on the last of the month west
   * of it. When the window has no present tense the badge falls back to '', which
   * this class already documents as "genuinely no bench state here" (see
   * {@link benchBadge}) and never to 'Not applicable'.
   */
  private readonly currentBenchMonth = computed(() => {
    const now = todayLocalIso().slice(0, 7);
    return this.dataResource.value().benchRollup.months.includes(now) ? now : '';
  });
  private readonly benchByResourceId = computed(() => {
    const roll = this.dataResource.value().benchRollup;
    return new Map([...roll.internalRows, ...roll.subcoRows].map(r => [r.resourceId, r]));
  });

  /**
   * Three distinct outcomes per row (design spec §9), never collapsed:
   *  - a dummy is NEVER a bench candidate (§4) — 'Not applicable', regardless
   *    of whatever `benchRollup` happens to contain for that id;
   *  - a real internal/subco resource with a row this month shows its actual
   *    BENCH/PARTIAL/ALLOCATED state;
   *  - a real internal/subco resource with NO row this month (not active in
   *    the display window) renders '' — a genuine "no bench state here", not
   *    an error and not "Not applicable". A failed/forbidden read never
   *    reaches this method at all: `hasError()` gates the whole list via
   *    `app-list-state` before any row (and its badge) is rendered.
   */
  benchBadge(res: Resource): string {
    if (kindOf(res) === 'dummy') return 'Not applicable';
    const row = this.benchByResourceId().get(res.id);
    return row?.monthly[this.currentBenchMonth()]?.state ?? '';
  }

  /**
   * The bench state as it appears in the row's accessible name: ', BENCH' or ''.
   * The separator belongs WITH the value — benchBadge() legitimately returns ''
   * for a real resource with no row in this month's rollup (see above), and
   * concatenating a bare ', ' + '' in the template would end the spoken name in
   * a dangling comma on exactly those rows.
   */
  protected benchBadgeSuffix(res: Resource): string {
    const badge = this.benchBadge(res);
    return badge ? `, ${badge}` : '';
  }

  private selectedResourceId = signal<string | null>(null);
  // Derived from the loaded resources so it always reflects the latest data after a reload.
  selectedResource = computed<Resource | null>(() => {
    const id = this.selectedResourceId();
    if (!id) return null;
    return this.resources().find(r => r.id === id) ?? null;
  });

  showForm = signal(false);
  editingAssignmentId = signal<string | null>(null);
  copiedAssignment = signal<Pick<Assignment, 'requestId'> | null>(null);

  /** Which set 'My Team' means. 'direct' is the pre-D behaviour and stays the default. */
  protected teamScope = signal<'direct' | 'org'>('direct');

  /**
   * 'direct' — people who report to the actor directly (unchanged).
   * 'org'    — the actor's ORGANIZATIONAL SCOPE: the transitive org chart below
   *            them UNION the resources in the org subtrees they manage. Same
   *            `scopeOf` the approval feed uses, so the two cannot drift.
   */
  managedResources = computed(() => {
    const me = this.currentManagerId;
    const all = this.resources();
    if (this.teamScope() === 'direct') return all.filter(r => r.managerId === me);
    const inScope = scopeOf(me, all, this.orgNodes());
    return all.filter(r => inScope.has(r.id));
  });

  /**
   * Only INTERNAL resources carry a meaningful `utilization`: a placeholder is
   * nobody's capacity, and a subco is not internal saturation. `scopeOf` reaches
   * into org subtrees where placeholders live, so without this filter the mean
   * would sink toward zero as the tree grows — the exact defect C1 fixed on
   * /reporting, where the seed alone halved the average. Applies to BOTH views:
   * a placeholder given a manager would otherwise land in the direct one too.
   */
  protected countedForAverage = computed(() =>
    this.managedResources().filter(r => countsTowardInternalCapacity(kindOf(r))));

  averageUtilization = computed(() => {
    const counted = this.countedForAverage();
    if (!counted.length) return 0;
    return counted.reduce((sum, r) => sum + r.utilization, 0) / counted.length;
  });

  /** True when the list shows rows the average deliberately does not count. */
  protected hasUncountedRows = computed(() =>
    this.countedForAverage().length !== this.managedResources().length);

  resourceAssignments = computed(() => {
    const resId = this.selectedResource()?.id;
    if (!resId) return [];
    return this.assignments().filter(a => a.resourceId === resId);
  });

  resourceTimeEntries = computed(() => {
    const resId = this.selectedResource()?.id;
    if (!resId) return [];
    return this.timeEntries().filter(t => t.resourceId === resId).sort((a, b) => b.date.localeCompare(a.date));
  });

  assignmentForm = new FormGroup({
    requestId: new FormControl('', Validators.required),
  });

  selectResource(res: Resource) {
    this.selectedResourceId.set(res.id);
    this.closeForm();
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  // --- Form Handling ---
  // Every write entry point re-checks canManageStaffing(). The template already
  // hides these controls, but a template gate alone is one refactor away from
  // being the only gate: these guards keep a programmatic call (or a leftover
  // armed state) from issuing a request the server will only answer with 403.
  openCreateForm() {
    if (!this.canManageStaffing()) return;
    this.editingAssignmentId.set(null);
    this.assignmentForm.reset({ requestId: '' });
    this.showForm.set(true);
  }

  openEditForm(assignment: Assignment) {
    if (!this.canManageStaffing()) return;
    this.editingAssignmentId.set(assignment.id);
    this.assignmentForm.patchValue({
      requestId: assignment.requestId,
    });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingAssignmentId.set(null);
    this.assignmentForm.reset();
  }

  saveAssignment() {
    if (!this.canManageStaffing()) return;
    if (this.assignmentForm.valid && this.selectedResource()) {
      const val = this.assignmentForm.value;
      const requestId = val.requestId || '';
      const resourceId = this.selectedResource()!.id;

      if (this.editingAssignmentId()) {
        // assignedHours/status are server-derived from assignmentDays/months.
        // This form edits only the unbooked assignment shell.
        const data: Partial<Assignment> = { requestId, resourceId };
        this.api.updateAssignment(this.editingAssignmentId()!, data).subscribe({
          next: () => {
            this.dataResource.reload();
            this.closeForm();
          },
          error: () => this.notifications.error('Failed to update assignment.')
        });
      } else {
        // The server creates a zero-hour Draft shell. Daily bookings are then
        // persisted through the allocation calendar and rolled up server-side.
        const data: Partial<Assignment> = { requestId, resourceId };
        this.api.createAssignment(data).subscribe({
          next: () => {
            this.dataResource.reload();
            this.closeForm();
          },
          error: () => this.notifications.error('Failed to create assignment.')
        });
      }
    }
  }

  // --- Copy / Paste / Delete ---
  copyAssignment(assignment: Assignment) {
    this.copiedAssignment.set({
      requestId: assignment.requestId,
    });
  }

  pasteAssignment() {
    if (!this.canManageStaffing()) return;
    const copied = this.copiedAssignment();
    const resId = this.selectedResource()?.id;
    if (copied && resId) {
      // Always creates a fresh proposal — the source assignment's status (which
      // may be 'Allocated'/'Rejected') is never carried over: `status` is not
      // client-settable at all (B3), so it is never sent here (the server would
      // 400 the request if it were), and the server always derives 'Draft' for
      // a brand-new assignment (it has no month rows yet).
      const newAssignment: Partial<Assignment> = {
        requestId: copied.requestId,
        resourceId: resId,
      };
      this.api.createAssignment(newAssignment).subscribe({
        next: () => {
          this.dataResource.reload();
          // Optional: clear copied assignment after paste
          // this.copiedAssignment.set(null);
        },
        error: () => this.notifications.error('Failed to paste assignment.')
      });
    }
  }

  /**
   * Armed delete. Holds the resource and project NAMES captured at arm time
   * rather than the row: the confirmation copy must not re-derive them through
   * getRequestName()/selectedResource(), which read dataResource.value() — a
   * value that THROWS in the error state (see the hasError() guard around the
   * Team Average tile) — and the row can also vanish under a concurrent reload
   * while the dialog is open.
   */
  protected pendingDelete = signal<{ id: string; project: string; resource: string } | null>(null);

  /**
   * Deleting an assignment is money-adjacent and had NO confirmation: one click
   * on a (until now invisible under keyboard focus) trash icon issued the DELETE,
   * and the server then recomputes the request's staffedEffort and the resource's
   * utilization under a lock. Nothing on this screen, or any other, can put the
   * assignment back — so the click only ARMS the dialog.
   */
  protected askDeleteAssignment(assignment: Assignment) {
    if (!this.canManageStaffing()) return;
    this.pendingDelete.set({
      id: assignment.id,
      project: this.getRequestName(assignment.requestId),
      resource: this.selectedResource()?.name ?? 'this resource',
    });
  }

  protected cancelDeleteAssignment() {
    this.pendingDelete.set(null);
  }

  protected confirmDeleteAssignment() {
    const pending = this.pendingDelete();
    if (!pending || !this.canManageStaffing()) return;
    this.api.deleteAssignment(pending.id).subscribe({
      next: () => {
        this.pendingDelete.set(null);
        this.dataResource.reload();
        // The handler had no feedback at all. Name the derived effects, since
        // they are what actually moved: the row is gone, but so are the
        // request's staffing % and this resource's utilization.
        this.notifications.success(
          `Assignment on ${pending.project} deleted — staffed effort and utilization recomputed.`,
        );
      },
      // Keep the dialog open on failure: the row is still there, so dismissing
      // would report a delete that did not happen.
      error: () => this.notifications.error('Failed to delete assignment.'),
    });
  }

  approveTimeEntry(entry: TimeEntry) {
    this.api.updateTimeEntry(entry.id, {
      status: 'Approved',
      approvedBy: this.currentManagerId,
      approvedAt: new Date().toISOString(),
    }).subscribe(() => this.dataResource.reload());
  }

  rejectTimeEntry(entry: TimeEntry) {
    this.api.updateTimeEntry(entry.id, { status: 'Rejected' }).subscribe(() => this.dataResource.reload());
  }

  // --- UI Helpers ---
  // Bar fill colours (graphics: 3:1 large-area contrast is sufficient).
  getUtilizationColorClass(utilization: number): string {
    if (utilization > 120) return 'bg-critical';
    if (utilization > 110) return 'bg-caution';
    if (utilization >= 80) return 'bg-positive';
    if (utilization >= 70) return 'bg-caution';
    return 'bg-critical';
  }

  // Text colours use the -700 shades so small bold text stays WCAG AA on white.
  getUtilizationColorText(utilization: number): string {
    if (utilization > 120) return 'text-critical-text';
    if (utilization > 110) return 'text-caution-text';
    if (utilization >= 80) return 'text-positive-text';
    if (utilization >= 70) return 'text-caution-text';
    return 'text-critical-text';
  }

  getStatusColorText(utilization: number): string {
    if (utilization > 120) return 'text-critical-text';
    if (utilization > 110) return 'text-caution-text';
    if (utilization >= 80) return 'text-positive-text';
    if (utilization >= 70) return 'text-caution-text';
    return 'text-critical-text';
  }

  getStatusText(utilization: number): string {
    if (utilization > 110) return 'Overbooked';
    if (utilization >= 80) return 'Optimal';
    return 'Free Capacity';
  }
}
