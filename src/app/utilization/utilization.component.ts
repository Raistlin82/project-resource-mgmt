import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource, Assignment, ResourceRequest, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DecimalPipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { forkJoin, of } from 'rxjs';

interface UtilizationData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
  timeEntries: TimeEntry[];
}

@Component({
  selector: 'app-utilization',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ReactiveFormsModule],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Resource Utilization</h1>
        <div class="command-card flex items-center gap-3 px-5 py-3">
          <span class="command-kpi-label">Team Average:</span>
          <span class="text-xl font-black tracking-tight font-mono tabular-nums" [class]="getUtilizationColorText(averageUtilization())">
            {{ averageUtilization() | number:'1.0-0' }}%
          </span>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
        <!-- Left Pane: Managed Resources -->
        <div class="lg:col-span-1 command-card overflow-hidden flex flex-col h-[min(800px,80vh)]">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">My Team</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Resources you manage</p>
            </div>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-[var(--cc-line)]">
            @for (res of managedResources(); track res.id) {
              <div class="p-6 hover:bg-surface-muted transition-all cursor-pointer group relative"
                   [class.bg-accent-tint]="selectedResource()?.id === res.id"
                   role="button"
                   tabindex="0"
                   [attr.aria-label]="'Select ' + res.name + ' utilization details'"
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
                      <h3 class="font-bold text-[var(--cc-ink)] text-lg group-hover:text-[var(--cc-primary-text)] transition-colors">{{ res.name }}</h3>
                      <p class="text-xs font-semibold tracking-wide text-[var(--cc-muted)] uppercase mt-0.5">{{ res.role }}</p>
                    </div>
                  </div>
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
              <div class="p-12 text-center text-sm text-[var(--cc-muted)]">You do not manage any resources.</div>
            }
          </div>
        </div>

        <!-- Right Pane: Resource Details & Assignments -->
        <div class="lg:col-span-2 flex flex-col gap-6 sm:gap-8">
          @if (selectedResource()) {
            <!-- Resource Header -->
            <div class="command-card p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
              <div>
                <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">{{ selectedResource()?.name }}</h2>
                <p class="text-[var(--cc-muted)] font-medium mt-2">{{ selectedResource()?.role }} <span class="mx-2 text-ink-muted">•</span> Capacity: <span class="font-bold text-[var(--cc-ink)] font-mono tabular-nums">{{ selectedResource()?.capacity }}h/week</span></p>
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
              </div>

              @if (showForm()) {
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
                      <div>
                        <label for="assignedHours" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Hours *</label>
                        <input id="assignedHours" type="number" formControlName="assignedHours" class="command-input">
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
                    <div class="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <button (click)="copyAssignment(assignment)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-[var(--cc-primary-text)] hover:border-accent hover:bg-accent-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Copy assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Copy assignment for ' + getRequestName(assignment.requestId)">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">content_copy</mat-icon>
                      </button>
                      <button (click)="openEditForm(assignment)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-[var(--cc-primary-text)] hover:border-accent hover:bg-accent-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Edit assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Edit assignment for ' + getRequestName(assignment.requestId)">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                      </button>
                      <button (click)="deleteAssignment(assignment.id)" class="w-10 h-10 rounded-full bg-[var(--cc-panel-muted)] border border-[var(--cc-line)] text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete assignment for ' + getRequestName(assignment.requestId)" [attr.title]="'Delete assignment for ' + getRequestName(assignment.requestId)">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                      </button>
                    </div>
                  </div>
                }
                @if (resourceAssignments().length === 0) {
                  <div class="p-12 text-center text-sm text-[var(--cc-muted)]">No assignments found for this resource.</div>
                }
              </div>
            </div>

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
                      <div class="text-sm text-[var(--cc-muted)] mt-1 font-mono tabular-nums">{{ entry.date }} · {{ entry.hours }}h · {{ entry.notes || 'No notes' }}</div>
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
        </div>
      </div>
    </div>
  `
})
export class UtilizationComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  // Current authenticated user (Resource Manager) id used for authorization.
  // Read LIVE, never snapshot at field-init (see auth.service note): a captured
  // value freezes the anonymous default and scopes the wrong manager on reload.
  private get currentManagerId(): string { return this.auth.userId(); }

  // resources and time-entries are principal-gated server-side: key the forkJoin
  // on auth readiness so it fires only AFTER the OAuth bootstrap has settled and
  // the bearer token is attached; firing earlier (e.g. on a reload/deep-link) sent
  // unauthenticated requests that 401'd and forkJoin's fail-fast collapsed the
  // whole view to empty (and never recovered).
  private dataResource = rxResource<UtilizationData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            assignments: this.api.getAssignments(),
            requests: this.api.getRequests(),
            timeEntries: this.api.getTimeEntries()
          })
        : of<UtilizationData>({ resources: [], assignments: [], requests: [], timeEntries: [] }),
    defaultValue: { resources: [], assignments: [], requests: [], timeEntries: [] }
  });

  resources = computed(() => this.dataResource.value().resources);
  assignments = computed(() => this.dataResource.value().assignments);
  allRequests = computed(() => this.dataResource.value().requests);
  timeEntries = computed(() => this.dataResource.value().timeEntries);

  private selectedResourceId = signal<string | null>(null);
  // Derived from the loaded resources so it always reflects the latest data after a reload.
  selectedResource = computed<Resource | null>(() => {
    const id = this.selectedResourceId();
    if (!id) return null;
    return this.resources().find(r => r.id === id) ?? null;
  });

  showForm = signal(false);
  editingAssignmentId = signal<string | null>(null);
  copiedAssignment = signal<Partial<Assignment> | null>(null);

  // Authorization: Only show resources managed by the current user
  managedResources = computed(() => this.resources().filter(r => r.managerId === this.currentManagerId));

  averageUtilization = computed(() => {
    const team = this.managedResources();
    if (!team.length) return 0;
    const total = team.reduce((sum, r) => sum + r.utilization, 0);
    return total / team.length;
  });

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
    assignedHours: new FormControl(0, [Validators.required, Validators.min(1)])
  });

  selectResource(res: Resource) {
    this.selectedResourceId.set(res.id);
    this.closeForm();
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  // --- Form Handling ---
  openCreateForm() {
    this.editingAssignmentId.set(null);
    this.assignmentForm.reset({ assignedHours: 0, requestId: '' });
    this.showForm.set(true);
  }

  openEditForm(assignment: Assignment) {
    this.editingAssignmentId.set(assignment.id);
    this.assignmentForm.patchValue({
      requestId: assignment.requestId,
      assignedHours: assignment.assignedHours
    });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingAssignmentId.set(null);
    this.assignmentForm.reset();
  }

  saveAssignment() {
    if (this.assignmentForm.valid && this.selectedResource()) {
      const val = this.assignmentForm.value;
      const data: Partial<Assignment> = {
        requestId: val.requestId || '',
        resourceId: this.selectedResource()!.id,
        assignedHours: val.assignedHours || 0,
        // TODO(alloc-approval): 'hard-booked' predates the typed Assignment.status
        // union added in the allocation-approval-workflow feature; cast is
        // type-only (no runtime change) until this handler is rewritten (Task 7+).
        status: 'hard-booked' as Assignment['status'] // Default status
      };

      if (this.editingAssignmentId()) {
        this.api.updateAssignment(this.editingAssignmentId()!, data).subscribe(() => {
          this.dataResource.reload();
          this.closeForm();
        });
      } else {
        this.api.createAssignment(data).subscribe(() => {
          this.dataResource.reload();
          this.closeForm();
        });
      }
    }
  }

  // --- Copy / Paste / Delete ---
  copyAssignment(assignment: Assignment) {
    this.copiedAssignment.set({
      requestId: assignment.requestId,
      assignedHours: assignment.assignedHours,
      status: assignment.status
    });
  }

  pasteAssignment() {
    const copied = this.copiedAssignment();
    const resId = this.selectedResource()?.id;
    if (copied && resId) {
      const newAssignment: Partial<Assignment> = {
        ...copied,
        resourceId: resId
      };
      this.api.createAssignment(newAssignment).subscribe(() => {
        this.dataResource.reload();
        // Optional: clear copied assignment after paste
        // this.copiedAssignment.set(null);
      });
    }
  }

  deleteAssignment(id: string) {
    this.api.deleteAssignment(id).subscribe(() => {
      this.dataResource.reload();
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
