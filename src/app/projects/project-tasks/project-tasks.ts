import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Order, OrderLine, Partner, Project, Resource, Task } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';

/** Sentinel value for an explicitly unassigned task assignee (an empty person ref). */
const UNASSIGNED = 'Unassigned';

/**
 * Verdict of the Commercial Coverage column.
 *
 * The last two are NOT verdicts about the task: they say the data the verdict
 * needs is not available to this reader (no commercial read capability) or did
 * not load (the read failed). They exist because the alternative — deriving a
 * verdict from an envelope that is empty for an authorization reason — reports
 * 'Missing purchase order' about a subcontractor task that has a valid PO.
 */
type CommercialCoverage =
  | 'Internal capacity'
  | 'Subco without partner'
  | 'PO covered'
  | 'Missing purchase order'
  | 'Coverage not available'
  | 'Coverage check failed';

@Component({
  selector: 'app-project-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (headingLevel() === 1) {
              <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Tasks</h1>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Tasks</h2>
            }
            @if (!projectId()) {
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            }
          </div>
          <!-- P2-18: a control whose only possible outcome without a project is a
               toast is disabled instead, with the reason stated beside it so it is
               readable BEFORE the click and reaches a screen reader through
               aria-describedby. The hint is the accessible description, so it is
               referenced only while the control is actually disabled. -->
          <div class="flex flex-col items-start gap-1">
            <button (click)="openForm()" [disabled]="!activeProjectId()"
                    [attr.aria-describedby]="activeProjectId() ? null : 'createTaskHint'"
                    data-test="create-task"
                    class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              <mat-icon class="text-sm">add</mat-icon> Create Task
            </button>
            @if (!activeProjectId()) {
              <p id="createTaskHint" class="text-xs text-[var(--cc-muted)]" data-test="create-task-hint">Select a project first.</p>
            }
          </div>
        </div>

        @if (!activeProjectId()) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view tasks.</p>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <p id="tasksTableHint" class="px-4 py-2 text-xs text-[var(--cc-muted)] border-b border-[var(--cc-line)] sm:hidden">
            Scroll horizontally to view every task field.
          </p>
          <div data-test="tasks-table-scroll" class="overflow-x-auto overscroll-x-contain" role="region"
               aria-label="Project tasks table" aria-describedby="tasksTableHint" tabindex="0">
          <table class="command-data-table min-w-[60rem]">
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
                <!-- One evaluation per row: the verdict is read three times (two
                     class bindings and the label) and it now reads resource
                     status, so recomputing it per binding is both wasteful and
                     a chance for the class list to disagree with the text. -->
                @let coverage = commercialCoverage(task);
                <tr data-test="task-row">
                  <td data-test="task-name" class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ task.name }}</td>
                  <td class="px-6 py-4">
                    <div class="font-medium text-[var(--cc-ink)]">{{ assignmentLabel(task) }}</div>
                    <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ task.assigneeType || 'Internal' }} · {{ task.assignee }}</div>
                  </td>
                  <td class="px-6 py-4">
                    <!-- The two UNKNOWN verdicts ('Coverage not available',
                         'Coverage check failed') deliberately match NEITHER the
                         red nor the amber/green list: an unknown must not be
                         painted as a critical finding the user could act on,
                         and must not be painted as a clean verdict either.
                         '.neutral' is the muted chip for exactly that. -->
                    <span data-test="coverage-chip" class="command-status"
                          [class.green]="coverage === 'PO covered'"
                          [class.amber]="coverage === 'Internal capacity'"
                          [class.red]="coverage === 'Missing purchase order' || coverage === 'Subco without partner'"
                          [class.neutral]="coverage === 'Coverage not available' || coverage === 'Coverage check failed'">
                      {{ coverage }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-[var(--cc-ink)] font-mono tabular-nums">{{ task.dueDate }}</td>
                  <td class="px-6 py-4">
                    <select #statusSelect data-test="task-status" [ngModel]="task.status" (ngModelChange)="updateStatus(task, $event, statusSelect)"
                            [attr.aria-label]="'Update status for task ' + task.name"
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
              <!-- Rendered INLINE rather than left to the interceptor's toast, because
                   error toasts in this app auto-dismiss: a dialog that stays open with a
                   vanished toast is an unexplained refusal. Same shape as
                   project-cost-centers.ts's saveError. -->
              @if (saveError(); as err) {
                <p role="alert" data-test="task-save-error" class="text-xs text-critical-text">{{ err }}</p>
              }
              <div>
                <label for="taskName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Task Name *</label>
                <input id="taskName" type="text" formControlName="name" class="command-input" placeholder="e.g. Design Database Schema">
              </div>

              <div>
                <label for="taskAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee</label>
                <!-- A task assignee is a PERSON reference: bound to the resources (people)
                     catalog by name, never free-typed. "Unassigned" is the explicit empty option. -->
                <select id="taskAssignee" formControlName="assignee" class="command-select">
                  <option [value]="unassigned">Unassigned</option>
                  @for (r of resourceOptions(); track r.id) {
                    <option [value]="r.name">{{ r.name }}</option>
                  }
                  <!-- ORPHAN VALUE: a stored assignee not in the catalog stays selectable as a
                       disabled "(not in catalog)" option so editing never silently wipes it. -->
                  @if (orphanAssignee(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
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
  /**
   * Which element carries this panel's own title: `<h1>` when it stands alone on
   * its route, `<h2>` when project-details embeds it as a tab panel beneath the
   * project-name `<h1>`.
   *
   * ONE mechanism, applied identically by all eight embeddable project panels;
   * the `[headingLevel]="2"` bindings and the full rationale live in
   * project-details.ts. Adding a plain `<h1>` here instead would have put TWO h1
   * elements on /projects/:id — trading the missing-h1 defect for a duplicate-h1
   * one. Typed `1 | 2` so no caller can ask for the `<h3>` that would skip a
   * level under the page `<h1>`. The size classes are unchanged in both
   * branches: the heading LEVEL is what moves, never the type scale.
   */
  headingLevel = input<1 | 2>(1);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  /** Exposed to the template for the explicit "Unassigned" empty option. */
  protected readonly unassigned = UNASSIGNED;

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  /**
   * The project in scope: the routed one when this panel is embedded in
   * project-details, else the one picked in the standalone page's selector.
   * Empty means none, which is what disables the create control (P2-18).
   *
   * Declared right after its own dependency, and the SINGLE source of truth for
   * the question — the inline `projectId() || selectedProjectId()` it replaces
   * appeared in the template, in the filtered list and in every save handler,
   * so the disabled state and the empty state could drift apart.
   */
  activeProjectId = computed(() => this.projectId() || this.selectedProjectId());
  showForm = signal(false);

  // Assignee option source: the resources (people) catalog. Stored value = resource
  // name (Phase D). /resources is a principal-gated read (401 until the Keycloak JWT
  // is restored), so key the load on authReady to fire only after the OAuth bootstrap
  // settles — firing earlier 401s and latches the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  // ORPHAN VALUE: a stored assignee that isn't a current resource name (and isn't the
  // 'Unassigned' sentinel) is surfaced as a disabled option so editing never drops it.
  orphanAssignee = computed<string | null>(() => {
    const current = this.assigneeValue();
    if (!current || current === UNASSIGNED) return null;
    return this.resourceOptions().some(r => r.name === current) ? null : current;
  });

  taskForm = new FormGroup({
    name: new FormControl('', Validators.required),
    assignee: new FormControl(UNASSIGNED),
    assigneeType: new FormControl<'Internal' | 'Subcontractor'>('Internal', { nonNullable: true, validators: Validators.required }),
    partnerId: new FormControl('', { nonNullable: true }),
    dueDate: new FormControl('', Validators.required),
    priority: new FormControl('Medium', Validators.required),
    status: new FormControl('To Do')
  });
  
  private tasksRes = authGatedResource(() => this.api.getProjectTasks(), [] as Task[]);
  tasks = this.tasksRes.value;
  private partnersRes = authGatedResource(() => this.api.getProjectPartners(), [] as Partner[]);
  // COMMERCIAL-GATED READS. /project-tasks is readable by pm, but READ_RULES in
  // src/server.ts restricts /orders and /order-lines to the commercial set
  // (sales/finance/delivery-executive/admin) — canReadCommercial() is exactly
  // that set. Gating on authReady alone sent a pm's request anyway, took the
  // 403, and left ordersRes in 'error' — after which every this.orders() in
  // commercialCoverage() threw ResourceValueError mid-render and the Tasks
  // table stopped at the first Subcontractor row, with no panel and no Retry.
  // Fold the capability into params so the refused request never leaves; the
  // verdict for the missing data is handled in commercialCoverage().
  private ordersRes = rxResource<Order[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadCommercial(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getOrders() : of<Order[]>([])),
    defaultValue: [] as Order[],
  });
  private orderLinesRes = rxResource<OrderLine[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadCommercial(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getOrderLines() : of<OrderLine[]>([])),
    defaultValue: [] as OrderLine[],
  });
  partners = this.partnersRes.value;
  // PRIVATE on purpose: `.value()` THROWS in the error state, so the only place
  // allowed to dereference these two is commercialCoverage(), below its status
  // guard. A template binding on them would put the throw back above every
  // guard, which is the shape that made the pm's table unusable.
  private orders = this.ordersRes.value;
  private orderLines = this.orderLinesRes.value;

  selectedAssigneeType = toSignal(this.taskForm.controls.assigneeType.valueChanges, { initialValue: this.taskForm.controls.assigneeType.value });
  /** The assignee value currently in the form (drives orphan detection). */
  private assigneeValue = toSignal(this.taskForm.controls.assignee.valueChanges, { initialValue: this.taskForm.controls.assignee.value });

  filteredTasks = computed(() => {
    const pId = this.activeProjectId();
    if (!pId) return [];
    return this.tasks().filter(t => t.projectId === pId);
  });

  filteredPartners = computed(() => {
    const pId = this.activeProjectId();
    if (!pId) return [];
    return this.partners().filter(p => p.projectId === pId);
  });

  openForm() {
    this.showForm.set(true);
  }

  /**
   * @param control The row's own <select>. The binding is one-way
   *   (`[ngModel]`), so when the server refuses the PUT the model never moves
   *   and Angular has nothing to re-render: the control keeps displaying the
   *   status the server rejected, for the rest of the session, while the list
   *   behind it still holds the old value. Snap the element back by hand.
   */
  updateStatus(task: Task, status: string, control: HTMLSelectElement) {
    this.api.updateProjectTask(task.id, { status }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.tasksRes.reload(),
      // Revert to the value the SERVER still holds. errorInterceptor already
      // raised the toast, so this only repairs the control — and it reverts on
      // failure only, never unconditionally, or an accepted change would be
      // undone on screen.
      error: () => { control.value = task.status; },
    });
  }

  /** Server refusal text for the open dialog, or null. See the template comment. */
  saveError = signal<string | null>(null);

  closeForm() {
    this.showForm.set(false);
    this.saveError.set(null);
    this.taskForm.reset({ priority: 'Medium', status: 'To Do', assignee: 'Unassigned', assigneeType: 'Internal', partnerId: '' });
  }

  saveTask() {
    if (this.taskForm.invalid) return;
    const pId = this.activeProjectId();
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

    // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — same rule as
    // project-cost-centers.ts's saveCostCenter(). `closeForm()` used to run
    // unconditionally right after firing the POST, so `taskForm.reset()` wiped the
    // name, assignee, partner and due date while the request was still in flight. A
    // resource-manager, who can READ this table but not write it, hit exactly that:
    // 403, a toast, and an empty form.
    this.saveError.set(null);
    this.api.createProjectTask(newTask).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.tasksRes.reload();
        this.closeForm();
      },
      error: (e: unknown) => {
        this.saveError.set(
          (e as { error?: { error?: string } })?.error?.error ?? 'Could not save the task.',
        );
      },
    });
  }

  assignmentLabel(task: Task): string {
    if (task.assigneeType === 'Subcontractor') {
      return this.partnerName(task.partnerId) || 'Subcontractor not selected';
    }
    return task.assignee || 'Unassigned';
  }

  commercialCoverage(task: Task): CommercialCoverage {
    // These two verdicts are derived from the TASK alone, so they stay truthful
    // for every role and must be answered before the commercial data is needed.
    if (task.assigneeType !== 'Subcontractor') return 'Internal capacity';
    if (!task.partnerId) return 'Subco without partner';
    // Past this point the verdict DEPENDS on /orders + /order-lines, so say so
    // when they are not there instead of reading an envelope that is empty for
    // a reason. Both branches are the opposite of the banned
    // `status() === 'error' ? [] : value()` shape: absent data must surface as
    // an explicit unknown, never as the confident 'Missing purchase order' an
    // empty orders() would produce for a task that IS in fact covered.
    if (!this.auth.canReadCommercial()) return 'Coverage not available';
    // Same crash, different cause: a 500 or an expired bearer on /orders errors
    // the resource for a role that legitimately reads it, and value() throws.
    // Named distinctly from the capability case ('not available' vs 'check
    // failed') so "you may not see this" is never confused with "we could not
    // load this" — in the UI or in an assertion about the UI.
    if (this.ordersRes.status() === 'error' || this.orderLinesRes.status() === 'error') return 'Coverage check failed';
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
