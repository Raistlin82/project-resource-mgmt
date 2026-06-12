import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Order, OrderLine, Partner, Project, Task } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Tasks</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Tasks</h2>
            }
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-sm">add</mat-icon> Create Task
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view tasks.</p>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="px-6 py-4 font-medium">Task</th>
                <th class="px-6 py-4 font-medium">Assignment</th>
                <th class="px-6 py-4 font-medium">Commercial Coverage</th>
                <th class="px-6 py-4 font-medium">Due Date</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium">Priority</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--cc-line)]">
              @for (task of filteredTasks(); track task.id) {
                <tr>
                  <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ task.name }}</td>
                  <td class="px-6 py-4">
                    <div class="font-medium text-[var(--cc-ink)]">{{ assignmentLabel(task) }}</div>
                    <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ task.assigneeType || 'Internal' }} · {{ task.assignee }}</div>
                  </td>
                  <td class="px-6 py-4">
                    <span class="command-status"
                          [class.green]="commercialCoverage(task) === 'PO covered'"
                          [class.amber]="commercialCoverage(task) === 'Internal capacity'"
                          [class.red]="commercialCoverage(task) === 'Missing purchase order' || commercialCoverage(task) === 'Subco without partner'">
                      {{ commercialCoverage(task) }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-[var(--cc-ink)] font-mono tabular-nums">{{ task.dueDate }}</td>
                  <td class="px-6 py-4">
                    <select [ngModel]="task.status" (ngModelChange)="updateStatus(task, $event)"
                            class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border-0 ring-1 focus:ring-2 focus:ring-accent/25 cursor-pointer"
                            [class.bg-positive-tint]="task.status === 'Done'" [class.text-positive-text]="task.status === 'Done'" [class.ring-positive]="task.status === 'Done'"
                            [class.bg-accent-tint]="task.status === 'In Progress'" [class.text-accent-text]="task.status === 'In Progress'" [class.ring-accent]="task.status === 'In Progress'"
                            [class.bg-surface-muted]="task.status === 'To Do'" [class.text-ink-secondary]="task.status === 'To Do'" [class.ring-line]="task.status === 'To Do'">
                      <option value="To Do">To Do</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Done">Done</option>
                    </select>
                  </td>
                  <td class="px-6 py-4">
                    <span class="command-status"
                          [class.red]="task.priority === 'High'"
                          [class.amber]="task.priority === 'Medium'"
                          [class.green]="task.priority === 'Low'">
                      {{ task.priority }}
                    </span>
                  </td>
                </tr>
              }
              @if (filteredTasks().length === 0) {
                <tr>
                  <td colspan="6" class="px-6 py-8 text-center text-[var(--cc-muted)]">No tasks found for this project.</td>
                </tr>
              }
            </tbody>
        </table>
      </div>
      }
    </div>

    <!-- Create Task Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="taskModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="taskModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Create Task</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          
          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="taskForm" (ngSubmit)="saveTask()" class="space-y-6">
              <div>
                <label for="taskName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Task Name *</label>
                <input id="taskName" type="text" formControlName="name" class="command-input" placeholder="e.g. Design Database Schema">
              </div>

              <div>
                <label for="taskAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee / Contact</label>
                <input id="taskAssignee" type="text" formControlName="assignee" class="command-input" placeholder="e.g. Jane Doe">
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="taskAssigneeType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignment Type *</label>
                  <select id="taskAssigneeType" formControlName="assigneeType" class="command-select">
                    <option value="Internal">Internal</option>
                    <option value="Subcontractor">Subcontractor</option>
                  </select>
                </div>

                @if (selectedAssigneeType() === 'Subcontractor') {
                  <div>
                    <label for="taskPartner" class="block text-sm font-semibold text-ink-secondary mb-1.5">Subcontractor *</label>
                    <select id="taskPartner" formControlName="partnerId" class="command-select">
                      <option value="">Select project partner...</option>
                      @for (partner of filteredPartners(); track partner.id) {
                        <option [value]="partner.id">{{ partner.company }}</option>
                      }
                    </select>
                  </div>
                }
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label for="taskDueDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Due Date *</label>
                  <input id="taskDueDate" type="date" formControlName="dueDate" class="command-input">
                </div>

                <div>
                  <label for="taskPriority" class="block text-sm font-semibold text-ink-secondary mb-1.5">Priority *</label>
                  <select id="taskPriority" formControlName="priority" class="command-select">
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </div>
              </div>
            </form>
          </div>
          
          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="saveTask()" [disabled]="!taskForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              Create Task
            </button>
          </div>
        </div>
      </div>
    }
    </div>
  `
})
export class ProjectTasks {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  taskForm = new FormGroup({
    name: new FormControl('', Validators.required),
    assignee: new FormControl('Unassigned'),
    assigneeType: new FormControl<'Internal' | 'Subcontractor'>('Internal', { nonNullable: true, validators: Validators.required }),
    partnerId: new FormControl('', { nonNullable: true }),
    dueDate: new FormControl('', Validators.required),
    priority: new FormControl('Medium', Validators.required),
    status: new FormControl('To Do')
  });
  
  private tasksRes = rxResource({ stream: () => this.api.getProjectTasks(), defaultValue: [] as Task[] });
  tasks = this.tasksRes.value;
  private partnersRes = rxResource({ stream: () => this.api.getProjectPartners(), defaultValue: [] as Partner[] });
  private ordersRes = rxResource({ stream: () => this.api.getOrders(), defaultValue: [] as Order[] });
  private orderLinesRes = rxResource({ stream: () => this.api.getOrderLines(), defaultValue: [] as OrderLine[] });
  partners = this.partnersRes.value;
  orders = this.ordersRes.value;
  orderLines = this.orderLinesRes.value;

  selectedAssigneeType = toSignal(this.taskForm.controls.assigneeType.valueChanges, { initialValue: this.taskForm.controls.assigneeType.value });

  filteredTasks = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.tasks().filter(t => t.projectId === pId);
  });

  filteredPartners = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.partners().filter(p => p.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showForm.set(true);
  }

  updateStatus(task: Task, status: string) {
    this.api.updateProjectTask(task.id, { status }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.tasksRes.reload());
  }

  closeForm() {
    this.showForm.set(false);
    this.taskForm.reset({ priority: 'Medium', status: 'To Do', assignee: 'Unassigned', assigneeType: 'Internal', partnerId: '' });
  }

  saveTask() {
    if (this.taskForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.taskForm.getRawValue();
    if (v.assigneeType === 'Subcontractor' && !v.partnerId) {
      this.notificationService.show('Select a project partner for subcontractor tasks', 'info');
      return;
    }

    const newTask: Partial<Task> = {
      projectId: pId,
      name: v.name ?? '',
      assignee: v.assignee ?? 'Unassigned',
      assigneeType: v.assigneeType,
      partnerId: v.assigneeType === 'Subcontractor' ? v.partnerId : '',
      dueDate: v.dueDate ?? '',
      status: v.status ?? 'To Do',
      priority: v.priority ?? 'Medium',
    };

    this.api.createProjectTask(newTask).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.tasksRes.reload());
    this.closeForm();
  }

  assignmentLabel(task: Task): string {
    if (task.assigneeType === 'Subcontractor') {
      return this.partnerName(task.partnerId) || 'Subcontractor not selected';
    }
    return task.assignee || 'Unassigned';
  }

  commercialCoverage(task: Task): 'Internal capacity' | 'Subco without partner' | 'PO covered' | 'Missing purchase order' {
    if (task.assigneeType !== 'Subcontractor') return 'Internal capacity';
    if (!task.partnerId) return 'Subco without partner';
    const purchaseOrderIds = new Set(
      this.orders()
        .filter(o => o.type === 'Purchase' && o.partnerId === task.partnerId && (o.status === 'Confirmed' || o.status === 'Invoiced' || o.status === 'Paid'))
        .map(o => o.id),
    );
    const covered = this.orderLines().some(line => line.projectId === task.projectId && purchaseOrderIds.has(line.orderId));
    return covered ? 'PO covered' : 'Missing purchase order';
  }

  private partnerName(id?: string): string {
    if (!id) return '';
    return this.partners().find(p => p.id === id)?.company ?? id;
  }
}
