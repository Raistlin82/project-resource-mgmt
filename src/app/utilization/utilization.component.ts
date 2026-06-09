import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource, Assignment, ResourceRequest, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DecimalPipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { forkJoin } from 'rxjs';

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
    <div class="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Manage Resource Utilization</h1>
        <div class="flex items-center gap-3 bg-white px-5 py-3 rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200">
          <span class="text-sm font-bold tracking-wide text-slate-500 uppercase">Team Average:</span>
          <span class="text-xl font-black tracking-tight font-mono tabular-nums" [class]="getUtilizationColorText(averageUtilization())">
            {{ averageUtilization() | number:'1.0-0' }}%
          </span>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
        <!-- Left Pane: Managed Resources -->
        <div class="lg:col-span-1 bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden flex flex-col h-[800px] hover:shadow-md transition-all">
          <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
            <h2 class="text-xl font-bold text-slate-900 tracking-tight">My Team</h2>
            <p class="text-sm font-medium text-slate-500 mt-2">Resources you manage</p>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
            @for (res of managedResources(); track res.id) {
              <div class="p-6 hover:bg-slate-50 transition-all cursor-pointer group relative"
                   [class.bg-blue-50]="selectedResource()?.id === res.id"
                   tabindex="0"
                   (keydown.enter)="selectResource(res)"
                   (click)="selectResource(res)">
                @if (selectedResource()?.id === res.id) {
                  <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-600 rounded-r-full"></div>
                }
                <div class="flex items-center justify-between mb-4">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-sm ring-1 ring-slate-900/5 group-hover:scale-105 transition-transform">
                      {{ res.name.charAt(0) }}
                    </div>
                    <div>
                      <h3 class="font-bold text-slate-900 text-lg group-hover:text-blue-700 transition-colors">{{ res.name }}</h3>
                      <p class="text-xs font-semibold tracking-wide text-slate-500 uppercase mt-0.5">{{ res.role }}</p>
                    </div>
                  </div>
                </div>
                <div class="mt-4">
                  <div class="flex items-center justify-between text-xs mb-2">
                    <span class="font-bold tracking-wide text-slate-500 uppercase">Utilization</span>
                    <span class="font-black text-sm font-mono tabular-nums" [class]="getUtilizationColorText(res.utilization)">{{ res.utilization | number:'1.0-0' }}%</span>
                  </div>
                  <div class="w-full bg-slate-100 rounded-full h-2 shadow-inner overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-500 ease-out"
                         [class]="getUtilizationColorClass(res.utilization)"
                         [style.width.%]="res.utilization > 100 ? 100 : res.utilization"></div>
                  </div>
                </div>
              </div>
            }
            @if (managedResources().length === 0) {
              <div class="p-12 text-center text-slate-500 font-medium italic">You do not manage any resources.</div>
            }
          </div>
        </div>

        <!-- Right Pane: Resource Details & Assignments -->
        <div class="lg:col-span-2 flex flex-col gap-6 sm:gap-8">
          @if (selectedResource()) {
            <!-- Resource Header -->
            <div class="bg-white p-6 sm:p-8 rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-6 hover:shadow-md transition-all">
              <div>
                <h2 class="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">{{ selectedResource()?.name }}</h2>
                <p class="text-slate-500 font-medium mt-2">{{ selectedResource()?.role }} <span class="mx-2 text-slate-400">•</span> Capacity: <span class="font-bold text-slate-700 font-mono tabular-nums">{{ selectedResource()?.capacity }}h/week</span></p>
              </div>
              <div class="text-left sm:text-right bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <div class="text-4xl font-black tracking-tighter font-mono tabular-nums" [class]="getUtilizationColorText(selectedResource()?.utilization || 0)">
                  {{ selectedResource()?.utilization | number:'1.0-0' }}%
                </div>
                <div class="text-sm font-bold tracking-wide uppercase mt-1" [class]="getStatusColorText(selectedResource()?.utilization || 0)">
                  {{ getStatusText(selectedResource()?.utilization || 0) }}
                </div>
              </div>
            </div>

            <!-- Assignments -->
            <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden flex-1 flex flex-col hover:shadow-md transition-all">
              <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <h3 class="text-xl font-bold text-slate-900 tracking-tight">Assignments</h3>
                <div class="flex flex-wrap gap-3">
                  @if (copiedAssignment()) {
                    <button (click)="pasteAssignment()" class="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-slate-100 text-slate-700 px-4 py-2.5 rounded-xl font-bold hover:bg-slate-200 transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5 text-sm">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">content_paste</mat-icon> Paste
                    </button>
                  }
                  <button (click)="openCreateForm()" class="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-4 py-2.5 rounded-xl transition-all hover:shadow-md hover:-translate-y-0.5 text-sm">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create
                  </button>
                </div>
              </div>

              @if (showForm()) {
                <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
                  <h4 class="font-bold text-slate-900 text-lg mb-6 tracking-tight">{{ editingAssignmentId() ? 'Edit Assignment' : 'New Assignment' }}</h4>
                  <form [formGroup]="assignmentForm" (ngSubmit)="saveAssignment()" class="space-y-6">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div class="md:col-span-2">
                        <label for="requestId" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Project / Request *</label>
                        <select id="requestId" formControlName="requestId" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 placeholder:text-slate-400 transition-all">
                          <option value="">Select a project...</option>
                          @for (req of allRequests(); track req.id) {
                            <option [value]="req.id">{{ req.name }} ({{ req.requiredRole }})</option>
                          }
                        </select>
                      </div>
                      <div>
                        <label for="assignedHours" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Hours *</label>
                        <input id="assignedHours" type="number" formControlName="assignedHours" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
                      </div>
                    </div>
                    <div class="flex justify-end gap-3 pt-2">
                      <button type="button" (click)="closeForm()" class="px-5 py-2.5 rounded-xl font-bold text-slate-700 hover:bg-slate-100 transition-all text-sm">Cancel</button>
                      <button type="submit" [disabled]="!assignmentForm.valid" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-6 py-2.5 rounded-xl transition-all disabled:opacity-50 text-sm hover:shadow-md hover:-translate-y-0.5">Save</button>
                    </div>
                  </form>
                </div>
              }

              <div class="divide-y divide-slate-100 overflow-y-auto">
                @for (assignment of resourceAssignments(); track assignment.id) {
                  <div class="p-6 sm:p-8 hover:bg-slate-50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between group gap-4">
                    <div>
                      <h4 class="font-bold text-slate-900 text-lg group-hover:text-blue-700 transition-colors">{{ getRequestName(assignment.requestId) }}</h4>
                      <div class="flex items-center gap-3 mt-2">
                        <span class="text-sm font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-lg font-mono tabular-nums">{{ assignment.assignedHours }} hours</span>
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-blue-50 text-blue-700 uppercase ring-1 ring-blue-200">
                          {{ assignment.status }}
                        </span>
                      </div>
                    </div>
                    <div class="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <button (click)="copyAssignment(assignment)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-blue-700 hover:border-blue-200 hover:bg-blue-50 transition-all flex items-center justify-center shadow-sm" title="Copy">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">content_copy</mat-icon>
                      </button>
                      <button (click)="openEditForm(assignment)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-blue-700 hover:border-blue-200 hover:bg-blue-50 transition-all flex items-center justify-center shadow-sm" title="Edit">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                      </button>
                      <button (click)="deleteAssignment(assignment.id)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-red-700 hover:border-red-200 hover:bg-red-50 transition-all flex items-center justify-center shadow-sm" title="Delete">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                      </button>
                    </div>
                  </div>
                }
                @if (resourceAssignments().length === 0) {
                  <div class="p-12 text-center text-slate-500 font-medium italic">No assignments found for this resource.</div>
                }
              </div>
            </div>

            <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
              <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
                <h3 class="text-xl font-bold text-slate-900 tracking-tight">Actual Time Approval</h3>
                <p class="text-sm text-slate-500 mt-1">Approve submitted hours so they become actual delivery cost.</p>
              </div>
              <div class="divide-y divide-slate-100">
                @for (entry of resourceTimeEntries(); track entry.id) {
                  <div class="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div class="font-bold text-slate-900">{{ getRequestName(entry.requestId) }}</div>
                      <div class="text-sm text-slate-500 mt-1 font-mono tabular-nums">{{ entry.date }} · {{ entry.hours }}h · {{ entry.notes || 'No notes' }}</div>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                            [class.bg-amber-50]="entry.status === 'Submitted'"
                            [class.text-amber-700]="entry.status === 'Submitted'"
                            [class.ring-amber-200]="entry.status === 'Submitted'"
                            [class.bg-emerald-50]="entry.status === 'Approved'"
                            [class.text-emerald-700]="entry.status === 'Approved'"
                            [class.ring-emerald-200]="entry.status === 'Approved'"
                            [class.bg-red-50]="entry.status === 'Rejected'"
                            [class.text-red-700]="entry.status === 'Rejected'"
                            [class.ring-red-200]="entry.status === 'Rejected'">
                        {{ entry.status }}
                      </span>
                      @if (entry.status === 'Submitted') {
                        <button (click)="approveTimeEntry(entry)" class="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50" title="Approve">
                          <mat-icon>check_circle</mat-icon>
                        </button>
                        <button (click)="rejectTimeEntry(entry)" class="p-2 rounded-lg text-red-600 hover:bg-red-50" title="Reject">
                          <mat-icon>cancel</mat-icon>
                        </button>
                      }
                    </div>
                  </div>
                }
                @if (!resourceTimeEntries().length) {
                  <div class="p-8 text-center text-slate-500">No actual time entries for this resource.</div>
                }
              </div>
            </div>
          } @else {
            <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 h-full flex flex-col items-center justify-center p-12 text-center">
              <div class="w-20 h-20 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center text-white mb-6 shadow-inner ring-1 ring-slate-900/5">
                <mat-icon class="text-4xl">people</mat-icon>
              </div>
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Select a Resource</h2>
              <p class="text-slate-500 font-medium mt-3 max-w-sm leading-relaxed">Choose a resource from your team on the left to view and manage their utilization and assignments.</p>
            </div>
          }
        </div>
      </div>
    </div>
  `
})
export class UtilizationComponent {
  private api = inject(ApiService);

  // MOCK ONLY: hardcoded current user (Resource Manager) id used for authorization.
  // TODO: replace with an AuthService providing the authenticated user and
  // role-based access control once authentication is implemented.
  private currentManagerId = inject(AuthService).userId();

  private dataResource = rxResource<UtilizationData, unknown>({
    stream: () =>
      forkJoin({
        resources: this.api.getResources(),
        assignments: this.api.getAssignments(),
        requests: this.api.getRequests(),
        timeEntries: this.api.getTimeEntries()
      }),
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
        status: 'hard-booked' // Default status
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
  getUtilizationColorClass(utilization: number): string {
    if (utilization > 120) return 'bg-red-500';
    if (utilization > 110) return 'bg-orange-500';
    if (utilization >= 80) return 'bg-emerald-500';
    if (utilization >= 70) return 'bg-orange-500';
    return 'bg-red-500';
  }

  getUtilizationColorText(utilization: number): string {
    if (utilization > 120) return 'text-red-600';
    if (utilization > 110) return 'text-orange-600';
    if (utilization >= 80) return 'text-emerald-600';
    if (utilization >= 70) return 'text-orange-600';
    return 'text-red-600';
  }

  getStatusColorText(utilization: number): string {
    if (utilization > 120) return 'text-red-600';
    if (utilization > 110) return 'text-orange-600';
    if (utilization >= 80) return 'text-emerald-600';
    if (utilization >= 70) return 'text-orange-600';
    return 'text-red-600';
  }

  getStatusText(utilization: number): string {
    if (utilization > 110) return 'Overbooked';
    if (utilization >= 80) return 'Optimal';
    return 'Free Capacity';
  }
}
