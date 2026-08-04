import { ChangeDetectionStrategy, Component, signal, computed, input, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, WorkPackage, Milestone, Resource } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DatePipe, DecimalPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-8">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <div>
                <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Project Schedule & Plans</h2>
                <p class="text-sm text-[var(--cc-muted)] mt-2">Manage work packages, scheduling, and key milestones.</p>
              </div>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Project Schedule & Plans</h2>
                <p class="text-sm text-[var(--cc-muted)] mt-1">Manage work packages, scheduling, and key milestones.</p>
              </div>
            }
          </div>
          <div class="flex gap-3">
            <button (click)="openMilestoneForm()" class="command-button secondary">
              <mat-icon class="text-sm">flag</mat-icon> Add Milestone
            </button>
            <button (click)="openWpForm()" class="command-button">
              <mat-icon class="text-sm">add</mat-icon> Add Work Package
            </button>
          </div>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view plans and milestones.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- Work Packages (Main Content) -->
          <div class="lg:col-span-2 space-y-6">
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] flex items-center gap-2">
              <mat-icon class="text-accent-text">account_tree</mat-icon> Work Packages
            </h3>

            <div class="command-card overflow-hidden">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th class="py-3 px-4">WBS / Name</th>
                    <th class="py-3 px-4">Timeline</th>
                    <th class="py-3 px-4">Assignee</th>
                    <th class="py-3 px-4">Progress</th>
                    <th class="py-3 px-4 text-right">Actions</th>
                  </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (wp of filteredWorkPackages(); track wp.id) {
                  <tr class="group">
                    <td class="py-4 px-4">
                      <div class="font-medium text-[var(--cc-ink)]">{{ wp.name }}</div>
                      <div class="text-xs text-accent-text font-mono mt-0.5">{{ wp.id }}</div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-1.5 text-[var(--cc-muted)] text-xs">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">calendar_today</mat-icon>
                        {{ wp.startDate | date:'MMM d' }} - {{ wp.endDate | date:'MMM d' }}
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-2">
                        <div class="w-6 h-6 rounded-full bg-accent-tint text-accent-text ring-1 ring-accent flex items-center justify-center text-xs font-bold">
                          {{ wp.assignee.charAt(0) }}
                        </div>
                        <span class="text-xs font-medium">{{ wp.assignee }}</span>
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-3">
                        <div class="flex-1 h-2 bg-surface-muted rounded-full overflow-hidden">
                          <div class="h-full rounded-full transition-all duration-500"
                               [class.bg-positive]="wp.progress === 100"
                               [class.bg-gradient-to-r]="wp.progress > 0 && wp.progress < 100"
                               [class.from-accent]="wp.progress > 0 && wp.progress < 100"
                               [class.to-accent]="wp.progress > 0 && wp.progress < 100"
                               [class.bg-surface-muted]="wp.progress === 0"
                               [style.width.%]="wp.progress"></div>
                        </div>
                        <span class="text-xs font-mono tabular-nums font-medium w-8 text-right">{{ wp.progress | number:'1.0-0' }}%</span>
                      </div>
                    </td>
                    <td class="py-4 px-4 text-right">
                      <button type="button" (click)="openEditWpForm(wp)" [attr.aria-label]="'Edit ' + wp.name" [attr.title]="'Edit ' + wp.name" class="text-ink-muted hover:text-accent-text transition-colors opacity-0 group-hover:opacity-100">
                        <mat-icon class="text-sm">edit</mat-icon>
                      </button>
                    </td>
                  </tr>
                }
                @if (filteredWorkPackages().length === 0) {
                  <tr>
                    <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]">No work packages found for this project.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Milestones (Sidebar) -->
        <div class="space-y-6">
          <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] flex items-center gap-2">
            <mat-icon class="text-caution">emoji_events</mat-icon> Key Milestones
          </h3>

          <div class="command-card p-6">
            <div class="relative border-l-2 border-[var(--cc-line)] ml-3 space-y-8">
              @for (milestone of filteredMilestones(); track milestone.id; let last = $last) {
                <div class="relative pl-6">
                  <!-- Timeline Dot -->
                  <div class="absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center"
                       [class.bg-positive]="milestone.status === 'Achieved'"
                       [class.bg-surface-muted]="milestone.status === 'Pending'">
                    @if (milestone.status === 'Achieved') {
                      <mat-icon class="text-white text-[10px] w-[10px] h-[10px]">check</mat-icon>
                    }
                  </div>

                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <h4 class="text-sm font-semibold text-[var(--cc-ink)]" [class.line-through]="milestone.status === 'Achieved'">
                        {{ milestone.name }}
                      </h4>
                      <span class="text-xs font-medium px-2 py-0.5 rounded-full ring-1"
                            [class.bg-positive-tint]="milestone.status === 'Achieved'"
                            [class.text-positive-text]="milestone.status === 'Achieved'"
                            [class.ring-positive]="milestone.status === 'Achieved'"
                            [class.bg-surface-muted]="milestone.status === 'Pending'"
                            [class.text-ink-secondary]="milestone.status === 'Pending'"
                            [class.ring-line]="milestone.status === 'Pending'">
                        {{ milestone.status }}
                      </span>
                    </div>
                    <div class="flex items-center gap-1.5 text-xs text-[var(--cc-muted)]">
                      <mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon>
                      {{ milestone.date | date:'mediumDate' }}
                    </div>
                    @if (milestone.status === 'Pending') {
                      <button (click)="achieveMilestone(milestone)" class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-positive-tint ring-1 ring-positive px-3 py-1.5 text-xs font-bold text-positive-text hover:bg-[color-mix(in_oklch,var(--color-positive)_16%,var(--color-surface))] transition-colors">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">check_circle</mat-icon>
                        Approve
                      </button>
                    } @else if (milestone.approvedBy) {
                      <p class="mt-2 text-[11px] text-[var(--cc-muted)]">Approved by {{ milestone.approvedBy }}</p>
                    }
                  </div>
                </div>
              }
              @if (filteredMilestones().length === 0) {
                <div class="pl-6 text-sm text-[var(--cc-muted)]">No milestones found.</div>
              }
            </div>
          </div>
          
          <!-- Quick Summary -->
          <div class="command-card-muted p-6">
            <h4 class="command-kpi-label mb-4">Schedule Summary</h4>
            <div class="space-y-3">
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Total Work Packages</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">{{ filteredWorkPackages().length }}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Completed</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">
                  {{ completedWorkPackagesCount() }}
                </span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Milestones Achieved</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">
                  {{ achievedMilestonesCount() }} / {{ filteredMilestones().length }}
                </span>
              </div>
            </div>
          </div>
        </div>
        </div>
        }
      </div>

      <!-- Add Milestone Modal -->
      @if (showMilestoneForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="milestoneModalTitle" (dismiss)="closeMilestoneForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="milestoneModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Milestone</h2>
              <button type="button" (click)="closeMilestoneForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="milestoneForm" (ngSubmit)="saveMilestone()" class="space-y-6">
                <div>
                  <label for="milestoneName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Milestone Name *</label>
                  <input id="milestoneName" type="text" formControlName="name" class="command-input" placeholder="e.g. Phase 1 Completion">
                </div>

                <div>
                  <label for="milestoneDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Date *</label>
                  <input id="milestoneDate" type="date" formControlName="date" class="command-input">
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeMilestoneForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveMilestone()" [disabled]="!milestoneForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Add Work Package Modal -->
      @if (showWpForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="wpModalTitle" (dismiss)="closeWpForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="wpModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Work Package</h2>
              <button type="button" (click)="closeWpForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="wpForm" (ngSubmit)="saveWp()" class="space-y-6">
                <div>
                  <label for="wpName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Work Package Name *</label>
                  <input id="wpName" type="text" formControlName="name" class="command-input" placeholder="e.g. Requirements Analysis">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="wpStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                    <input id="wpStartDate" type="date" formControlName="startDate" class="command-input">
                  </div>
                  <div>
                    <label for="wpEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                    <input id="wpEndDate" type="date" formControlName="endDate" class="command-input">
                  </div>
                </div>

                <div>
                  <label for="wpAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee *</label>
                  <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                  <select id="wpAssignee" formControlName="assignee" class="command-select">
                    <option [value]="unassigned">Unassigned</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanWpAssignee(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeWpForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveWp()" [disabled]="!wpForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Edit Work Package Modal -->
      @if (showEditWpForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="editWpModalTitle" (dismiss)="closeEditWpForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="editWpModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Edit Work Package</h2>
              <button type="button" (click)="closeEditWpForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="editWpForm" (ngSubmit)="saveEditWp()" class="space-y-6">
                <div>
                  <label for="editWpName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Work Package Name *</label>
                  <input id="editWpName" type="text" formControlName="name" class="command-input" placeholder="e.g. Requirements Analysis">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="editWpStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                    <input id="editWpStartDate" type="date" formControlName="startDate" class="command-input">
                  </div>
                  <div>
                    <label for="editWpEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                    <input id="editWpEndDate" type="date" formControlName="endDate" class="command-input">
                  </div>
                </div>

                <div>
                  <label for="editWpAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee *</label>
                  <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                  <select id="editWpAssignee" formControlName="assignee" class="command-select">
                    <option [value]="unassigned">Unassigned</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanEditWpAssignee(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="editWpStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                    <select id="editWpStatus" formControlName="status" class="command-select">
                      <option value="Planned">Planned</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div>
                    <label for="editWpProgress" class="block text-sm font-semibold text-ink-secondary mb-1.5">Progress (%) *</label>
                    <input id="editWpProgress" type="number" min="0" max="100" formControlName="progress" class="command-input">
                  </div>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeEditWpForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveEditWp()" [disabled]="!editWpForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectPlans {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);

  /** Exposed to the template for the explicit "Unassigned" empty option. */
  protected readonly unassigned = 'Unassigned';

  projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  // Work-package assignee is a PERSON reference bound to the resources (people) catalog
  // by name (Phase D). /resources is a principal-gated read, so key the load on authReady
  // to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  showMilestoneForm = signal(false);
  showWpForm = signal(false);
  showEditWpForm = signal(false);
  editingWpId = signal<string | null>(null);

  milestoneForm = new FormGroup({
    name: new FormControl('', Validators.required),
    date: new FormControl('', Validators.required)
  });

  wpForm = new FormGroup({
    name: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    assignee: new FormControl('', Validators.required)
  });

  editWpForm = new FormGroup({
    name: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    assignee: new FormControl('', Validators.required),
    status: new FormControl<WorkPackage['status']>('Planned', Validators.required),
    progress: new FormControl(0, Validators.required)
  });

  // ORPHAN VALUES: a stored assignee that isn't a current resource name (and isn't the
  // 'Unassigned' sentinel) is surfaced as a disabled option so editing never drops it.
  private wpAssigneeValue = toSignal(this.wpForm.controls.assignee.valueChanges, { initialValue: this.wpForm.controls.assignee.value });
  private editWpAssigneeValue = toSignal(this.editWpForm.controls.assignee.valueChanges, { initialValue: this.editWpForm.controls.assignee.value });
  orphanWpAssignee = computed<string | null>(() => this.orphanAssignee(this.wpAssigneeValue()));
  orphanEditWpAssignee = computed<string | null>(() => this.orphanAssignee(this.editWpAssigneeValue()));
  private orphanAssignee(value: string | null | undefined): string | null {
    if (!value || value === this.unassigned) return null;
    return this.resourceOptions().some(r => r.name === value) ? null : value;
  }

  private wpRes = rxResource({ stream: () => this.api.getWorkPackages(), defaultValue: [] as WorkPackage[] });
  workPackages = this.wpRes.value;

  private milestoneRes = rxResource({ stream: () => this.api.getMilestones(), defaultValue: [] as Milestone[] });
  milestones = this.milestoneRes.value;

  filteredWorkPackages = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.workPackages().filter(wp => wp.projectId === pId);
  });

  filteredMilestones = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.milestones().filter(m => m.projectId === pId);
  });

  completedWorkPackagesCount = computed(() => this.filteredWorkPackages().filter(wp => wp.status === 'Completed').length);
  achievedMilestonesCount = computed(() => this.filteredMilestones().filter(m => m.status === 'Achieved').length);

  openMilestoneForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showMilestoneForm.set(true);
  }

  closeMilestoneForm() {
    this.showMilestoneForm.set(false);
    this.milestoneForm.reset();
  }

  saveMilestone() {
    if (this.milestoneForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.milestoneForm.getRawValue();
    this.api.createMilestone({
      projectId: pId,
      name: v.name ?? '',
      date: v.date ?? '',
      status: 'Pending',
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.milestoneRes.reload());
    this.closeMilestoneForm();
  }

  openWpForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showWpForm.set(true);
  }

  closeWpForm() {
    this.showWpForm.set(false);
    this.wpForm.reset();
  }

  saveWp() {
    if (this.wpForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.wpForm.getRawValue();
    this.api.createWorkPackage({
      projectId: pId,
      name: v.name ?? '',
      startDate: v.startDate ?? '',
      endDate: v.endDate ?? '',
      status: 'Planned',
      progress: 0,
      assignee: v.assignee ?? '',
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.wpRes.reload());
    this.closeWpForm();
  }

  openEditWpForm(wp: WorkPackage) {
    this.editingWpId.set(wp.id);
    this.editWpForm.setValue({
      name: wp.name,
      startDate: wp.startDate,
      endDate: wp.endDate,
      assignee: wp.assignee,
      status: wp.status,
      progress: wp.progress,
    });
    this.showEditWpForm.set(true);
  }

  closeEditWpForm() {
    this.showEditWpForm.set(false);
    this.editingWpId.set(null);
    this.editWpForm.reset();
  }

  saveEditWp() {
    if (this.editWpForm.invalid) return;
    const id = this.editingWpId();
    if (!id) return;

    const v = this.editWpForm.getRawValue();
    this.api.updateWorkPackage(id, {
      name: v.name ?? '',
      startDate: v.startDate ?? '',
      endDate: v.endDate ?? '',
      assignee: v.assignee ?? '',
      status: v.status ?? 'Planned',
      progress: v.progress ?? 0,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.wpRes.reload());
    this.closeEditWpForm();
  }

  achieveMilestone(milestone: Milestone) {
    this.api.updateMilestone(milestone.id, {
      status: 'Achieved',
      approvedBy: this.auth.userId(),
      approvedAt: new Date().toISOString(),
    }).subscribe(() => {
      this.milestoneRes.reload();
      this.notificationService.show('Milestone approved', 'success');
    });
  }
}
