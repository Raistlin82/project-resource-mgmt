import { ChangeDetectionStrategy, Component, signal, input, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, ProjectCostCenter, Resource, CostCenter } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';

@Component({
  selector: 'app-project-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (headingLevel() === 1) {
              <div>
                <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Cost Centers</h1>
                <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage and allocate project budget to specific cost centers.</p>
              </div>
            } @else {
              <!-- h2, not the h3 this used to be: embedded, the title sits
                   directly under project-details' project-name h1, and an h3
                   there SKIPS a level — a defect of its own, not a smaller
                   version of the missing-h1 one. The text-lg size is
                   unchanged, so nothing moves on screen. -->
              <div>
                <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Cost Centers</h2>
                <p class="text-sm text-[var(--cc-muted)]">Manage and allocate project budget to specific cost centers.</p>
              </div>
            }
            @if (!projectId()) {
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            }
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-sm">add</mat-icon> Add Cost Center
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view cost centers.</p>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th>Cost Center ID</th>
                <th>Name</th>
                <th>Manager</th>
                <th class="text-right">Allocated Budget</th>
                <th class="text-right">Actual Spend</th>
                <th>Status</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (cc of filteredCostCenters(); track cc.id) {
                <tr>
                  <td class="font-mono text-accent-text">{{ cc.id }}</td>
                  <td class="font-medium">{{ cc.name }}</td>
                  <td>{{ cc.manager }}</td>
                  <td class="text-right">{{ cc.allocated | currency:'EUR' }}</td>
                  <td class="text-right">{{ cc.actual | currency:'EUR' }}</td>
                  <td>
                    @let usage = cc.allocated > 0 ? (cc.actual / cc.allocated) * 100 : 0;
                    <span class="command-status"
                          [class.green]="usage <= 80"
                          [class.amber]="usage > 80 && usage <= 100"
                          [class.red]="usage > 100">
                      {{ usage | number:'1.0-0' }}% Used
                    </span>
                  </td>
                  <td class="text-right">
                    <button type="button" (click)="openEditForm(cc)" [attr.aria-label]="'Edit ' + cc.name" [attr.title]="'Edit ' + cc.name" class="text-[var(--cc-muted)] hover:text-accent-text transition-colors">
                      <mat-icon class="text-sm">edit</mat-icon>
                    </button>
                  </td>
                </tr>
              }
              @if (filteredCostCenters().length === 0) {
                <tr>
                  <td colspan="7" class="text-center text-[var(--cc-muted)]">No cost centers found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
          </div>
        </div>
        }
      </div>

      <!-- Create Cost Center Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="projectCostCenterModalTitle" (dismiss)="closeForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="projectCostCenterModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-[var(--cc-muted)] hover:text-[var(--cc-ink)] hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="ccForm" (ngSubmit)="saveCostCenter()" class="space-y-6">
                <div>
                  <label for="ccId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Cost Center *</label>
                  @if (editingId()) {
                    <!-- The id is the immutable key on edit; show it read-only. -->
                    <input id="ccId" type="text" class="command-input font-mono" [value]="ccForm.controls.id.value" disabled>
                  } @else {
                    <!-- Select a configuration cost center: fills+locks the id and derives the name. -->
                    <select id="ccId" formControlName="id" class="command-select" (change)="onCostCenterPicked()">
                      <option value="" disabled>Select a cost center...</option>
                      @for (cc of availableCostCenters(); track cc.id) {
                        <option [value]="cc.id">{{ cc.id }} — {{ cc.name }}</option>
                      }
                    </select>
                  }
                </div>

                <div>
                  <label for="ccName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name</label>
                  <!-- DERIVED from the chosen cost center; not hand-typed. -->
                  <input id="ccName" type="text" formControlName="name" class="command-input" readonly>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="ccBudget" class="block text-sm font-semibold text-ink-secondary mb-1.5">Allocated Budget *</label>
                    <input id="ccBudget" type="number" formControlName="allocatedBudget" class="command-input">
                  </div>

                  <div>
                    <label for="ccManager" class="block text-sm font-semibold text-ink-secondary mb-1.5">Manager</label>
                    <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                    <select id="ccManager" formControlName="manager" class="command-select">
                      <option value="">Unassigned</option>
                      @for (r of resourceOptions(); track r.id) {
                        <option [value]="r.name">{{ r.name }}</option>
                      }
                      @if (orphanManager(); as orphan) {
                        <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                      }
                    </select>
                  </div>
                </div>

                @if (saveError(); as err) {
                  <p role="alert" data-test="cost-center-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveCostCenter()" [disabled]="!ccForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ editingId() ? 'Save Changes' : 'Add Cost Center' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectCostCenters {
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
   * level under the page `<h1>` — which is exactly what this panel's embedded
   * title used to be. The size classes are unchanged in both branches: the
   * heading LEVEL is what moves, never the type scale.
   */
  headingLevel = input<1 | 2>(1);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  editingId = signal<string | null>(null);
  /** The server's own refusal text, shown inline so the dialog staying open is explained. */
  saveError = signal<string | null>(null);

  // The cost-center manager is a PERSON reference bound to the resources (people)
  // catalog by name (Phase D). /resources is a principal-gated read, so key the load
  // on authReady to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  ccForm = new FormGroup({
    id: new FormControl('', Validators.required),
    name: new FormControl('', Validators.required),
    allocatedBudget: new FormControl(0, [Validators.required, Validators.min(0)]),
    manager: new FormControl('')
  });

  // PHASE F2 — the project cost-center `id` is chosen from the configuration
  // cost-centers catalog (selecting one fills+locks the id and derives the name).
  private catalogRes = rxResource<CostCenter[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getCostCenters() : of<CostCenter[]>([])),
    defaultValue: [] as CostCenter[],
  });
  catalogCostCenters = this.catalogRes.value;

  /**
   * Catalog cost centers still attachable here.
   *
   * SUBTRACTS EVERY project cost center, not just THIS project's. The id is the
   * primary key of /project-cost-centers, not a (projectId, id) pair, so a catalog
   * entry already attached to another project cannot be attached here either — the
   * server answers 400 'project cost center CC-1001 already exists'. Filtering on
   * `filteredCostCenters()` (this project's rows) kept offering exactly the options
   * guaranteed to be refused, which is what made that 400 a routine occurrence
   * rather than an edge case.
   */
  availableCostCenters = computed<CostCenter[]>(() => {
    const used = new Set(this.costCenters().map(cc => cc.id));
    return this.catalogCostCenters().filter(cc => !used.has(cc.id));
  });

  /** A cost center was picked: derive + lock the name from the catalog entry. */
  onCostCenterPicked() {
    const id = this.ccForm.controls.id.value ?? '';
    const cc = this.catalogCostCenters().find(c => c.id === id);
    this.ccForm.controls.name.setValue(cc ? cc.name : '');
  }

  // ORPHAN VALUE: a stored manager that isn't a current resource name is surfaced as a
  // disabled option so editing never silently discards a real value.
  private managerValue = toSignal(this.ccForm.controls.manager.valueChanges, { initialValue: this.ccForm.controls.manager.value });
  orphanManager = computed<string | null>(() => {
    const current = this.managerValue();
    if (!current) return null;
    return this.resourceOptions().some(r => r.name === current) ? null : current;
  });

  private costCentersRes = rxResource<ProjectCostCenter[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getProjectCostCenters() : of<ProjectCostCenter[]>([])),
    defaultValue: [] as ProjectCostCenter[],
  });
  costCenters = this.costCentersRes.value;

  filteredCostCenters = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.costCenters().filter(cc => cc.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.editingId.set(null);
    this.saveError.set(null);
    this.ccForm.reset({ allocatedBudget: 0 });
    this.ccForm.get('id')?.enable();
    this.showForm.set(true);
  }

  openEditForm(cc: ProjectCostCenter) {
    this.editingId.set(cc.id);
    this.saveError.set(null);
    this.ccForm.reset({
      id: cc.id,
      name: cc.name,
      allocatedBudget: cc.allocated,
      manager: cc.manager,
    });
    this.ccForm.get('id')?.disable();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.saveError.set(null);
    this.ccForm.get('id')?.enable();
    this.ccForm.reset({ allocatedBudget: 0 });
  }

  saveCostCenter() {
    if (this.ccForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.ccForm.getRawValue();
    const editingId = this.editingId();
    const allocated = Number.isNaN(v.allocatedBudget) ? 0 : (v.allocatedBudget ?? 0);

    // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT. `closeForm()` used to run
    // unconditionally after firing the request, so the dialog closed and
    // `ccForm.reset()` wiped the typed values while the POST was still in flight.
    // On the 400 this picker itself invites — 'project cost center CC-1001 already
    // exists', reachable because a catalog entry attached to ANOTHER project is
    // still offered here — the user got an error toast over an empty screen and had
    // to retype the budget and the manager from scratch. Staying open on the error
    // path is the whole fix: the interceptor's toast carries the server's message,
    // and the values survive for a corrected retry.
    this.saveError.set(null);
    const onSuccess = () => {
      this.costCentersRes.reload();
      this.closeForm();
    };
    // Rendered INLINE rather than left to the interceptor's toast, because error
    // toasts in this app auto-dismiss — a dialog that stays open with a vanished
    // toast is an unexplained refusal. Same shape as project-rates.ts's rateError.
    const onError = (e: unknown) => {
      this.saveError.set(
        (e as { error?: { error?: string } })?.error?.error ?? 'Could not save the cost center.',
      );
    };

    if (editingId) {
      this.api.updateProjectCostCenter(editingId, {
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: onSuccess, error: onError });
    } else {
      this.api.createProjectCostCenter({
        id: v.id ?? '',
        projectId: pId,
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
        actual: 0,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: onSuccess, error: onError });
    }
  }
}
