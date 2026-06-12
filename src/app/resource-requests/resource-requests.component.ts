import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Assignment, Resource, ProjectRole, Skill } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

interface RequestsData {
  requests: ResourceRequest[];
  assignments: Assignment[];
  resources: Resource[];
}

@Component({
  selector: 'app-resource-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, DecimalPipe, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Resource Requests</h1>
          <p class="text-sm text-[var(--cc-muted)] mt-1">Create and manage staffing requests for your projects.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="command-card-muted p-1 flex items-center">
            <button (click)="currentView.set('requests')"
                    [class.bg-surface]="currentView() === 'requests'"
                    [class.shadow-sm]="currentView() === 'requests'"
                    [class.text-ink]="currentView() === 'requests'"
                    [class.text-ink-muted]="currentView() !== 'requests'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Requests
            </button>
            <button (click)="currentView.set('availability')"
                    [class.bg-surface]="currentView() === 'availability'"
                    [class.shadow-sm]="currentView() === 'availability'"
                    [class.text-ink]="currentView() === 'availability'"
                    [class.text-ink-muted]="currentView() !== 'availability'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Resource Availability
            </button>
          </div>
          @if (currentView() === 'requests') {
            <button (click)="openCreateForm()" class="command-button w-full sm:w-auto">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Request
            </button>
          }
        </div>
      </div>

      @if (currentView() === 'requests') {
        @if (showForm()) {
          <div class="command-card p-8 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent to-accent"></div>
            <h2 class="font-display text-2xl font-bold text-[var(--cc-ink)] mb-8">{{ editingId() ? 'Edit Request' : 'New Resource Request' }}</h2>
            <form [formGroup]="requestForm" (ngSubmit)="saveRequest()" class="space-y-6">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-1.5">
                  <label for="name" class="block text-sm font-semibold text-ink-secondary">Project Name <span class="text-critical">*</span></label>
                  <input id="name" formControlName="name" class="command-input">
                </div>
                <div class="space-y-1.5">
                  <label for="requiredRole" class="block text-sm font-semibold text-ink-secondary">Required Role <span class="text-critical">*</span></label>
                  <select id="requiredRole" formControlName="requiredRole" class="command-select">
                    <option value="" disabled>Select a role...</option>
                    @for (role of roleOptions(); track role.id) {
                      <option [value]="role.name">{{ role.name }}</option>
                    }
                    <!-- ORPHAN VALUE: a stored requiredRole not in the catalog (e.g. legacy free
                         text) stays selectable as a disabled option so editing never wipes it.
                         requiredRole feeds match-scoring, so preserving the exact value matters. -->
                    @if (orphanRole(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label for="requiredEffort" class="block text-sm font-semibold text-ink-secondary">Required Effort (Hours) <span class="text-critical">*</span></label>
                  <input id="requiredEffort" type="number" formControlName="requiredEffort" class="command-input">
                </div>
                <div class="space-y-1.5">
                  <label for="skills" class="block text-sm font-semibold text-ink-secondary">Required Skills</label>
                  <!-- Skills are catalog values, never free text: a multi-select bound to
                       the /skills catalog (stored value = skill NAME, the value match-scoring
                       compares against). Hold Ctrl/Cmd to pick several. -->
                  <select id="skills" formControlName="skills" multiple class="command-select min-h-[120px]">
                    @for (skill of skillOptions(); track skill.id) {
                      <option [value]="skill.name">{{ skill.name }}</option>
                    }
                    <!-- ORPHAN VALUE: any stored skill name not in the catalog (legacy free
                         text) stays selectable as a disabled option so editing never drops it. -->
                    @for (orphan of orphanSkills(); track orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                  <p class="text-xs font-medium text-[var(--cc-muted)] mt-2">Hold Ctrl/Cmd to select multiple skills.</p>
                </div>
                <div class="space-y-1.5">
                  <label for="startDate" class="block text-sm font-semibold text-ink-secondary">Start Date</label>
                  <input id="startDate" type="date" formControlName="startDate" class="command-input">
                </div>
                <div class="space-y-1.5">
                  <label for="endDate" class="block text-sm font-semibold text-ink-secondary">End Date</label>
                  <input id="endDate" type="date" formControlName="endDate" class="command-input">
                </div>
              </div>
              <div class="space-y-1.5">
                <label for="description" class="block text-sm font-semibold text-ink-secondary">Description</label>
                <textarea id="description" formControlName="description" rows="4" placeholder="Provide details about the project and the role..." class="command-textarea"></textarea>
              </div>
              <div class="flex justify-end gap-3 pt-6 border-t border-[var(--cc-line)]">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!requestForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save Request</button>
              </div>
            </form>
          </div>
        }

        <div class="command-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="command-data-table min-w-[800px]">
              <thead>
                <tr>
                  <th>Project Details</th>
                  <th>Role & Skills</th>
                  <th>Staffing Status</th>
                  <th>State</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (req of myRequests(); track req.id) {
                  <tr class="transition-colors group">
                    <td>
                      <div class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ req.name }}</div>
                      <div class="text-xs font-medium text-[var(--cc-muted)] mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon> {{ req.startDate || 'TBD' }} to {{ req.endDate || 'TBD' }}</div>
                      @if (req.description) {
                        <div class="text-xs text-[var(--cc-muted)] mt-1.5 truncate max-w-[200px]" [title]="req.description">{{ req.description }}</div>
                      }
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">badge</mat-icon> {{ req.requiredRole }}</div>
                      <div class="text-xs font-medium text-[var(--cc-muted)] mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px] text-ink-muted">psychology</mat-icon> {{ req.skills.join(', ') || 'No specific skills' }}</div>
                    </td>
                    <td>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-[var(--cc-ink)] font-mono tabular-nums">{{ req.staffedEffort || 0 }} / {{ req.requiredEffort }}h</span>
                          <span class="font-mono tabular-nums"
                                [class.text-positive-text]="getStaffingPercentage(req) >= 100"
                                [class.text-caution-text]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                                [class.text-ink-muted]="getStaffingPercentage(req) === 0">
                            {{ getStaffingPercentage(req) | number:'1.0-0' }}%
                          </span>
                        </div>
                        <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden">
                          <div class="h-2 rounded-full transition-all duration-1000 ease-out"
                               [class.bg-positive]="getStaffingPercentage(req) >= 100"
                               [class.bg-caution]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                               [class.bg-line-strong]="getStaffingPercentage(req) === 0"
                               [style.width.%]="getStaffingPercentage(req)"></div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="command-chip" [class]="statusChipTone(req.status)">
                        {{ req.status }}
                      </span>
                    </td>
                    <td class="text-right space-x-1">
                      @if (req.status !== 'Not Published' && req.status !== 'Withdrawn') {
                        <button (click)="trackRequest(req)" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-all" title="Track Staffing">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">analytics</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Not Published' || req.status === 'Withdrawn') {
                        <button (click)="openEditForm(req)" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-all" title="Edit">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                        </button>
                        <button (click)="publishRequest(req)" class="p-2 text-ink-muted hover:text-positive-text hover:bg-positive-tint rounded-lg transition-all" title="Publish">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">publish</mat-icon>
                        </button>
                        <button (click)="deleteRequest(req)" class="p-2 text-ink-muted hover:text-critical-text hover:bg-critical-tint rounded-lg transition-all" title="Delete">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Published' || req.status === 'Open' || req.status === 'Fulfilled') {
                        <button (click)="withdrawRequest(req)" class="p-2 text-ink-muted hover:text-caution-text hover:bg-caution-tint rounded-lg transition-all" title="Withdraw">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">undo</mat-icon>
                        </button>
                      }
                    </td>
                  </tr>
                }
                @if (!myRequests().length) {
                  <tr>
                    <td colspan="5" class="text-center text-[var(--cc-muted)]">
                      <div class="flex flex-col items-center justify-center px-6 py-12">
                        <mat-icon class="text-4xl mb-3 opacity-50">assignment</mat-icon>
                        <p class="font-medium">No resource requests found.</p>
                        <p class="text-sm mt-1">Create one to get started.</p>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      } @else {
        <!-- Resource Availability View -->
        <div class="command-card overflow-hidden flex flex-col">
          <div class="p-6 border-b border-[var(--cc-line)] flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[var(--cc-panel-muted)]">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resource Availability</h2>
            <div class="relative w-full sm:w-auto">
              <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input
                type="text"
                [formControl]="availabilitySearch"
                placeholder="Search by name, role, or skills..."
                class="command-input sm:w-72 pl-10"
              >
            </div>
          </div>
          <div class="overflow-x-auto flex-1">
            <table class="command-data-table min-w-[800px]">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Role & Skills</th>
                  <th>Capacity</th>
                  <th>Utilization</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (res of filteredAvailability(); track res.id) {
                  <tr class="transition-colors group">
                    <td>
                      <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-gradient-to-br from-accent to-accent rounded-full flex items-center justify-center text-white font-semibold text-lg shadow-inner shrink-0">
                          {{ res.name.charAt(0) }}
                        </div>
                        <div class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ res.name }}</div>
                      </div>
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">badge</mat-icon> {{ res.role }}</div>
                      <div class="flex gap-1.5 mt-2 flex-wrap">
                        @for (skill of res.skills; track skill.name) {
                          <span class="text-[11px] font-medium bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-md border border-line">{{ skill.name }}</span>
                        }
                      </div>
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-medium flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">schedule</mat-icon> <span class="font-mono tabular-nums">{{ res.capacity }}h</span> / week</div>
                    </td>
                    <td>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-ink-secondary">Utilization</span>
                          <span class="font-mono tabular-nums"
                                [class.text-positive-text]="res.utilization >= 80 && res.utilization <= 100"
                                [class.text-caution-text]="res.utilization > 0 && res.utilization < 80"
                                [class.text-critical-text]="res.utilization > 100"
                                [class.text-ink-muted]="res.utilization === 0">
                            {{ res.utilization | number:'1.0-0' }}%
                          </span>
                        </div>
                        <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden">
                          <div class="h-2 rounded-full transition-all duration-1000 ease-out"
                               [class.bg-positive]="res.utilization >= 80 && res.utilization <= 100"
                               [class.bg-caution]="res.utilization > 0 && res.utilization < 80"
                               [class.bg-critical]="res.utilization > 100"
                               [class.bg-line-strong]="res.utilization === 0"
                               [style.width.%]="res.utilization > 100 ? 100 : res.utilization"></div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="command-chip" [class]="getAvailableHours(res) > 0 ? 'is-positive' : 'is-neutral'">
                        {{ getAvailableHours(res) > 0 ? getAvailableHours(res) + 'h available' : 'Fully booked' }}
                      </span>
                    </td>
                  </tr>
                }
                @if (!filteredAvailability().length) {
                  <tr>
                    <td colspan="5" class="text-center text-[var(--cc-muted)]">
                      <div class="flex flex-col items-center justify-center px-6 py-12">
                        <mat-icon class="text-4xl mb-3 opacity-50">search_off</mat-icon>
                        <p class="font-medium">No resources found matching your search.</p>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }

      @if (trackingDetails()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6"
             appModal ariaLabelledby="trackingModalTitle" (dismiss)="closeTracking()">
          <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] flex items-start justify-between bg-gradient-to-br from-surface-muted to-transparent">
              <div>
                <h2 id="trackingModalTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] tracking-tight">Staffing Progress</h2>
                <p class="text-sm font-medium text-[var(--cc-muted)] mt-1.5 flex items-center gap-1.5">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">work_outline</mat-icon>
                  {{ trackingDetails()?.request?.name }}
                </p>
              </div>
              <button type="button" (click)="closeTracking()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <!-- Progress Bar -->
              <div class="command-card-muted mb-10 p-6">
                <div class="flex justify-between items-end mb-3">
                  <span class="font-semibold text-ink-secondary">Overall Progress</span>
                  <span class="text-2xl font-bold text-[var(--cc-primary-text)] tracking-tight font-mono tabular-nums">{{ getStaffingPercentage(trackingDetails()!.request) }}%</span>
                </div>
                <div class="w-full bg-surface-muted rounded-full h-3 overflow-hidden shadow-inner">
                  <div class="h-3 rounded-full transition-all duration-1000 ease-out relative"
                       [class.bg-positive]="getStaffingPercentage(trackingDetails()!.request) >= 100"
                       [class.bg-caution]="getStaffingPercentage(trackingDetails()!.request) > 0 && getStaffingPercentage(trackingDetails()!.request) < 100"
                       [class.bg-line-strong]="getStaffingPercentage(trackingDetails()!.request) === 0"
                       [style.width.%]="getStaffingPercentage(trackingDetails()!.request)">
                    <div class="absolute inset-0 bg-surface/20 w-full h-full"></div>
                  </div>
                </div>
                <div class="flex justify-between text-sm font-medium text-ink-muted mt-3">
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-positive-text">check_circle</mat-icon> {{ trackingDetails()?.request?.staffedEffort || 0 }}h Staffed</span>
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-caution-text">pending</mat-icon> {{ trackingDetails()?.remaining }}h Remaining of {{ trackingDetails()?.request?.requiredEffort }}h</span>
                </div>
              </div>

              <!-- Assigned Resources -->
              <div class="flex items-center justify-between mb-4">
                <h3 class="command-section-label">Assigned Resources</h3>
                <span class="command-status">{{ trackingDetails()?.assignments?.length || 0 }}</span>
              </div>

              <div class="space-y-3">
                @for (item of trackingDetails()?.assignments; track item.assignment.id) {
                  <div class="command-card-muted flex items-center justify-between p-4 hover:shadow-md transition-all group">
                    <div class="flex items-center gap-4">
                      <div class="w-12 h-12 bg-accent-tint border border-accent rounded-full flex items-center justify-center text-accent-text font-bold shadow-sm shrink-0">
                        {{ item.resource?.name?.charAt(0) || '?' }}
                      </div>
                      <div>
                        <h4 class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ item.resource?.name || 'Unknown Resource' }}</h4>
                        <p class="text-xs font-medium text-[var(--cc-muted)] mt-0.5 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">badge</mat-icon> {{ item.resource?.role }}</p>
                      </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-1">
                      <div class="font-bold text-[var(--cc-primary-text)] text-lg font-mono tabular-nums">{{ item.assignment.assignedHours }}h</div>
                      <div class="command-status uppercase"
                           [class.green]="item.assignment.status === 'confirmed'"
                           [class.amber]="item.assignment.status === 'proposed'">
                        {{ item.assignment.status }}
                      </div>
                    </div>
                  </div>
                }
                @if (trackingDetails()?.assignments?.length === 0) {
                  <div class="text-center p-8 border-2 border-dashed border-line rounded-lg bg-[var(--cc-panel-muted)]">
                    <div class="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-line">
                      <mat-icon class="text-ink-muted text-3xl">person_add_disabled</mat-icon>
                    </div>
                    <p class="font-medium text-ink-secondary">No resources assigned yet</p>
                    <p class="text-sm text-[var(--cc-muted)] mt-1">Assignments will appear here once staffed.</p>
                  </div>
                }
              </div>
            </div>

            <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end">
              <button (click)="closeTracking()" class="command-button secondary">Close</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ResourceRequestsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  // Read LIVE, never snapshot at field-init (see auth.service note): a captured
  // value freezes the anonymous default and shows the wrong user's data on reload.
  private get currentUserId(): string { return this.auth.userId(); }

  // The resources read is principal-gated server-side (401 until the Keycloak JWT
  // is restored). On reload the OIDC token restores async; firing the forkJoin
  // immediately 401s and the rxResource latches on the error. Key the load on auth
  // readiness so it fires only AFTER the OAuth bootstrap has settled and the bearer
  // token is attached.
  private res = rxResource<RequestsData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          requests: this.api.getRequests(),
          assignments: this.api.getAssignments(),
          resources: this.api.getResources()
        })
      : of<RequestsData>({ requests: [], assignments: [], resources: [] }),
    defaultValue: { requests: [], assignments: [], resources: [] }
  });

  requests = computed(() => this.res.value().requests);
  assignments = computed(() => this.res.value().assignments);
  resources = computed(() => this.res.value().resources);

  // Required-role option source: the canonical /project-roles catalog. Stored value
  // = name (Phase A), which is what match-scoring compares against. Keyed on
  // authReady to mirror the principal-gated config reads elsewhere.
  private rolesRes = rxResource<ProjectRole[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjectRoles() : of<ProjectRole[]>([])),
    defaultValue: [] as ProjectRole[],
  });
  roleOptions = this.rolesRes.value;

  // ORPHAN VALUE: when editing a request whose stored requiredRole isn't in the
  // catalog, expose it so the select still shows it and saving doesn't wipe it.
  orphanRole = computed<string | null>(() => {
    const current = this.editingRole();
    if (!current) return null;
    return this.roleOptions().some(r => r.name === current) ? null : current;
  });
  /** The requiredRole value currently loaded into the form (drives orphan detection). */
  private editingRole = signal<string>('');

  // Required-skills option source: the canonical /skills catalog. Stored value =
  // skill name, which is what match-scoring compares against. Keyed on authReady
  // to mirror the principal-gated reads above.
  private skillsRes = rxResource<Skill[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getSkills() : of<Skill[]>([])),
    defaultValue: [] as Skill[],
  });
  skillOptions = this.skillsRes.value;

  // ORPHAN VALUES: any skill on the edited request whose name isn't in the catalog
  // (legacy free text) is surfaced as a disabled option so editing never drops it.
  orphanSkills = computed<string[]>(() => {
    const names = new Set(this.skillOptions().map(s => s.name));
    return this.editingSkills().filter(s => !names.has(s));
  });
  /** The skill names currently loaded into the form (drives orphan detection). */
  private editingSkills = signal<string[]>([]);

  showForm = signal(false);
  editingId = signal<string | null>(null);
  trackingRequestId = signal<string | null>(null);
  currentView = signal<'requests' | 'availability'>('requests');

  availabilitySearch = new FormControl('');
  searchValue = signal('');

  constructor() {
    this.availabilitySearch.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(v => this.searchValue.set(v || ''));
  }

  // Authorization: Only show requests created by the current user
  myRequests = computed(() => this.requests().filter(r => r.requesterId === this.currentUserId));

  filteredAvailability = computed(() => {
    const search = this.searchValue().toLowerCase();
    return this.resources().filter(res => {
      if (!search) return true;
      const matchesName = res.name.toLowerCase().includes(search);
      const matchesRole = res.role.toLowerCase().includes(search);
      const matchesSkills = res.skills.some(s => s.name.toLowerCase().includes(search));
      return matchesName || matchesRole || matchesSkills;
    });
  });

  getAvailableHours(res: Resource): number {
    const utilizedHours = (res.capacity * res.utilization) / 100;
    return Math.max(0, Math.round(res.capacity - utilizedHours));
  }

  trackingDetails = computed(() => {
    const reqId = this.trackingRequestId();
    if (!reqId) return null;
    const req = this.requests().find(r => r.id === reqId);
    if (!req) return null;

    const reqAssignments = this.assignments().filter(a => a.requestId === reqId);
    const staffedResources = reqAssignments.map(a => {
      const res = this.resources().find(r => r.id === a.resourceId);
      return {
        assignment: a,
        resource: res
      };
    });

    return {
      request: req,
      assignments: staffedResources,
      remaining: Math.max(0, req.requiredEffort - (req.staffedEffort || 0))
    };
  });

  requestForm = new FormGroup({
    name: new FormControl('', Validators.required),
    requiredRole: new FormControl('', Validators.required),
    requiredEffort: new FormControl(0, [Validators.required, Validators.min(1)]),
    skills: new FormControl<string[]>([], { nonNullable: true }),
    description: new FormControl(''),
    startDate: new FormControl(''),
    endDate: new FormControl('')
  });

  trackRequest(req: ResourceRequest) {
    this.trackingRequestId.set(req.id);
  }

  closeTracking() {
    this.trackingRequestId.set(null);
  }

  openCreateForm() {
    this.editingId.set(null);
    this.editingRole.set('');
    this.editingSkills.set([]);
    this.requestForm.reset({ requiredEffort: 0, skills: [] });
    this.showForm.set(true);
  }

  openEditForm(req: ResourceRequest) {
    this.editingId.set(req.id);
    this.editingRole.set(req.requiredRole ?? '');
    this.editingSkills.set([...(req.skills ?? [])]);
    this.requestForm.patchValue({
      name: req.name,
      requiredRole: req.requiredRole,
      requiredEffort: req.requiredEffort,
      skills: [...(req.skills ?? [])],
      description: req.description || '',
      startDate: req.startDate || '',
      endDate: req.endDate || ''
    });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.requestForm.reset();
  }

  saveRequest() {
    if (this.requestForm.valid) {
      const val = this.requestForm.value;
      const reqData: Partial<ResourceRequest> = {
        name: val.name || '',
        requiredRole: val.requiredRole || '',
        requiredEffort: val.requiredEffort || 0,
        // Multi-select already yields the selected skill NAMES; preserve any orphan
        // values the user kept (disabled options aren't auto-removed on save).
        skills: val.skills ?? [],
        description: val.description || '',
        startDate: val.startDate || '',
        endDate: val.endDate || '',
        requesterId: this.currentUserId
      };

      if (this.editingId()) {
        this.api.updateRequest(this.editingId()!, reqData).subscribe(() => {
          this.res.reload();
          this.closeForm();
        });
      } else {
        this.api.createRequest(reqData).subscribe(() => {
          this.res.reload();
          this.closeForm();
        });
      }
    }
  }

  publishRequest(req: ResourceRequest) {
    this.api.updateRequest(req.id, { status: 'Published' }).subscribe(() => {
      this.res.reload();
    });
  }

  withdrawRequest(req: ResourceRequest) {
    // Can only withdraw if unstaffed or partially staffed, but let's allow it generally for the demo
    this.api.updateRequest(req.id, { status: 'Withdrawn' }).subscribe(() => {
      this.res.reload();
    });
  }

  deleteRequest(req: ResourceRequest) {
    // In a real app, use a custom modal here instead of window.confirm
    this.api.deleteRequest(req.id).subscribe(() => {
      this.res.reload();
    });
  }

  getStaffingPercentage(req: ResourceRequest): number {
    if (!req.requiredEffort) return 0;
    const staffed = req.staffedEffort || 0;
    return Math.min(100, Math.round((staffed / req.requiredEffort) * 100));
  }

  /** command-chip tone modifier for a request's lifecycle status. */
  statusChipTone(status: ResourceRequest['status']): string {
    switch (status) {
      case 'Published':
      case 'Fulfilled':
        return 'is-positive';
      case 'Open':
        return 'is-info';
      case 'Withdrawn':
        return 'is-caution';
      case 'Not Published':
      default:
        return 'is-neutral';
    }
  }
}
