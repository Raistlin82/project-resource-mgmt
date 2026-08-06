import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, BASE_CURRENCY, Project, FinancialItem, CostCategory } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { ListStateComponent } from '../../shared/list-state.component';
import { authGatedResource } from '../../services/auth-gated-resource.util';

@Component({
  selector: 'app-financial-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective, ListStateComponent],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            @if (headingLevel() === 1) {
              <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Financial Plans</h1>
            } @else {
              <h2 class="font-display text-lg font-semibold text-[var(--cc-ink)]">Financial Plans</h2>
            }
            @if (!projectId()) {
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block w-full min-w-0 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)] sm:w-auto">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            }
          </div>
          <button (click)="openForm()" class="command-button self-start sm:self-auto">
            <mat-icon class="text-sm">add</mat-icon> Create Financial Plan
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-semibold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view financial plans.</p>
          </div>
        } @else {
        <app-list-state [loading]="financialDataLoading()" [error]="financialsRes.status() === 'error'"
                        skeleton="table-rows" [rows]="5" [columns]="4" label="financial plans"
                        (retry)="financialsRes.reload()">
          <ng-template>
        <!--
          The role is what makes the aria-label PERMITTED. An aria-label on a
          role-less div is ignored by the accessible-name computation, so this
          region had no name at all and its three tiles were announced as loose,
          unassociated text; with a role the name applies and the tiles read as one
          labelled group. Same treatment as the other labelled wrappers in this
          codebase (register: "no aria-label on a role-less div/span").
        -->
        <div role="group" class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6" aria-label="Financial plan metrics">
          <div class="command-kpi">
            <h3 class="command-kpi-label">Total Budget</h3>
            <p class="command-kpi-value">{{ totalBudget() | currency:baseCurrency:'symbol':'1.0-0' }}</p>
          </div>
          <div class="command-kpi">
            <h3 class="command-kpi-label">Spent</h3>
            <p class="command-kpi-value">{{ totalSpent() | currency:baseCurrency:'symbol':'1.0-0' }}</p>
          </div>
          <div class="command-kpi" [class.green]="remaining() > 0" [class.danger]="remaining() < 0">
            <h3 class="command-kpi-label">Remaining</h3>
            <p class="command-kpi-value">{{ remaining() | currency:baseCurrency:'symbol':'1.0-0' }}</p>
          </div>
        </div>

        <div class="command-card overflow-x-auto">
          <table class="command-data-table min-w-[48rem]">
            <thead>
              <tr>
                <th class="px-6 py-4">Category</th>
                <th class="px-6 py-4 text-right">Budget</th>
                <th class="px-6 py-4 text-right">Actual</th>
                <th class="px-6 py-4 text-right">Variance</th>
                <th class="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--cc-line)]">
              @for (item of filteredFinancials(); track item.id) {
                <tr class="hover:bg-surface-muted transition-colors">
                  <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ item.category }}</td>
                  <td class="px-6 py-4 text-right text-[var(--cc-muted)] font-mono tabular-nums">{{ item.budget | currency:baseCurrency:'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-right text-[var(--cc-muted)] font-mono tabular-nums">{{ item.actual | currency:baseCurrency:'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="item.budget - item.actual > 0" [class.text-critical-text]="item.budget - item.actual < 0" [class.text-ink-secondary]="item.budget - item.actual === 0">
                    {{ item.budget - item.actual > 0 ? '+' : '' }}{{ item.budget - item.actual | currency:baseCurrency:'symbol':'1.0-0' }}
                  </td>
                  <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-2">
                      <button type="button" (click)="editPlan(item)" class="text-ink-muted hover:text-accent-text hover:bg-accent-tint p-1.5 rounded-lg transition-colors" aria-label="Edit financial plan">
                        <mat-icon class="text-sm">edit</mat-icon>
                      </button>
                      <button type="button" (click)="requestDelete(item)" class="text-ink-muted hover:text-critical-text hover:bg-critical-tint p-1.5 rounded-lg transition-colors" [attr.aria-label]="'Delete the ' + item.category + ' budget line'">
                        <mat-icon class="text-sm">delete</mat-icon>
                      </button>
                    </div>
                  </td>
                </tr>
              }
              @if (filteredFinancials().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]">No financial records found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
          </ng-template>
        </app-list-state>
        }
      </div>

      <!--
        DELETE CONFIRMATION — a budget line IS the project's budget. The DELETE used
        to go out on the first click of a 24px icon, and the figure is recoverable
        from nowhere in the UI afterwards. What it moves, in one click:
        budgetForProject sums these rows (finance.util.ts), so the effective budget
        drops by this line's budget and with it Burn % (actualCost/budget), VAC
        (budget minus EAC) and deliveryHealth(), which turns the project header pill
        red on VAC below zero — plus /reporting's Margin and Variance row and the
        eacOverBudget portfolio alert for the same project.

        Same shape as project-rates.ts's landed confirm (and projects.ts's markup):
        the row control ARMS the dialog, only the dialog's own control writes.
      -->
      @if (pendingDelete(); as pending) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="financialPlanDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col" data-test="financial-plan-delete-confirm">
            <div class="p-6 sm:p-8 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="financialPlanDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">
                Delete the {{ pending.category }} budget line?
              </h3>
              <p class="text-[var(--cc-muted)] text-sm">
                Removes <strong class="text-[var(--cc-ink)]">{{ pending.budget | currency:baseCurrency:'symbol':'1.0-2' }}</strong>
                of budget for <strong class="text-[var(--cc-ink)]">{{ pending.category }}</strong>, so this project's total budget
                falls to <strong class="text-[var(--cc-ink)]">{{ budgetAfterDelete() | currency:baseCurrency:'symbol':'1.0-2' }}</strong>.
                Budget Burn %, Variance at Completion and the project's delivery-health pill all recompute on the lower figure,
                and the {{ pending.actual | currency:baseCurrency:'symbol':'1.0-2' }} already recorded as spent against it is dropped too.
                This cannot be undone from this screen.
              </p>
            </div>
            <div class="p-4 sm:p-5 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelDelete()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmDelete()" data-test="financial-plan-delete-confirm-action" class="px-4 py-2 bg-critical text-ink-inverse rounded-lg text-sm font-semibold hover:bg-critical-strong transition-colors shadow-sm">
                Delete budget line
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Create Financial Plan Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="financialPlanModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="command-card-header">
              <h2 id="financialPlanModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Financial Plan' : 'Create Financial Plan' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="finForm" (ngSubmit)="savePlan()" class="space-y-6">
                <div>
                  <label for="finCategory" class="block text-sm font-semibold text-ink-secondary mb-1.5">Category *</label>
                  <!-- Category is a config FK to the cost-categories catalog (store = name). -->
                  <select id="finCategory" formControlName="category" class="command-select">
                    <option value="" disabled>Select a category...</option>
                    @for (cat of categoryOptions(); track cat.id) {
                      <option [value]="cat.name">{{ cat.name }}</option>
                    }
                    @if (orphanCategory(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="finBudget" class="block text-sm font-semibold text-ink-secondary mb-1.5">Budget ({{ baseCurrency }}) *</label>
                    <input id="finBudget" type="number" formControlName="budget" class="command-input" placeholder="0">
                  </div>
                  <div>
                    <label for="finActual" class="block text-sm font-semibold text-ink-secondary mb-1.5">Actual Spent ({{ baseCurrency }}) *</label>
                    <input id="finActual" type="number" formControlName="actual" class="command-input" placeholder="0">
                  </div>
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              @if (saveError(); as error) {
                <p role="alert" class="mr-auto self-center text-xs text-critical-text">{{ error }}</p>
              }
              <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
              <button type="button" (click)="savePlan()" [disabled]="!finForm.valid || saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ saving() ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class FinancialPlans {
  readonly baseCurrency = BASE_CURRENCY;
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

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  showForm = signal(false);
  editingId = signal<string | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

  finForm = new FormGroup({
    category: new FormControl('', Validators.required),
    budget: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
    actual: new FormControl<number | null>(null, [Validators.required, Validators.min(0)])
  });

  // Category is a config FK to the cost-categories catalog (Phase F2).
  private categoriesRes = authGatedResource(() => this.api.getCostCategories(), [] as CostCategory[]);
  categoryOptions = this.categoriesRes.value;

  // ORPHAN VALUE: a stored category not in the catalog stays selectable as a disabled option.
  private categoryValue = toSignal(this.finForm.controls.category.valueChanges, { initialValue: this.finForm.controls.category.value });
  orphanCategory = computed<string | null>(() => {
    const current = this.categoryValue();
    if (!current) return null;
    return this.categoryOptions().some(c => c.name === current) ? null : current;
  });

  protected financialsRes = rxResource<FinancialItem[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getProjectFinancials() : of<FinancialItem[]>([])),
    defaultValue: [] as FinancialItem[]
  });
  protected financialDataLoading = computed(() => !this.auth.authReady() || this.financialsRes.isLoading());
  financials = this.financialsRes.value;

  filteredFinancials = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.financials().filter(f => f.projectId === pId);
  });

  totalBudget = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.budget, 0));
  totalSpent = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.actual, 0));
  remaining = computed(() => this.totalBudget() - this.totalSpent());

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.editingId.set(null);
    this.saveError.set(null);
    this.showForm.set(true);
  }

  editPlan(item: FinancialItem) {
    this.editingId.set(item.id);
    this.saveError.set(null);
    this.finForm.setValue({
      category: item.category,
      budget: item.budget,
      actual: item.actual,
    });
    this.showForm.set(true);
  }

  /**
   * The budget line awaiting confirmation. Holds the WHOLE row so the dialog can
   * quote the category and both figures without re-finding a row the list may have
   * reloaded underneath it.
   */
  pendingDelete = signal<FinancialItem | null>(null);

  /**
   * The project's total budget once the pending line is gone — the consequence
   * stated as a number rather than as a warning. Computed from the rows on screen,
   * which is the same set `totalBudget()` sums.
   */
  budgetAfterDelete = computed(() => {
    const pending = this.pendingDelete();
    if (!pending) return this.totalBudget();
    return this.filteredFinancials()
      .filter(item => item.id !== pending.id)
      .reduce((sum, item) => sum + item.budget, 0);
  });

  /** First click: arm the confirm ONLY. No DELETE goes out from here. */
  requestDelete(item: FinancialItem) {
    this.pendingDelete.set(item);
  }

  cancelDelete() {
    this.pendingDelete.set(null);
  }

  confirmDelete() {
    const item = this.pendingDelete();
    if (!item) return;
    // Cleared BEFORE the request so a double-click cannot issue two DELETEs.
    this.pendingDelete.set(null);
    this.deletePlan(item);
  }

  private deletePlan(item: FinancialItem) {
    this.api.deleteProjectFinancial(item.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.financialsRes.reload();
      this.notificationService.show(`${item.category} budget line deleted — this project's budget is now lower.`, 'success');
    });
  }

  closeForm() {
    if (this.saving()) return;
    this.showForm.set(false);
    this.editingId.set(null);
    this.finForm.reset();
  }

  savePlan() {
    if (this.finForm.invalid || this.saving()) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.finForm.getRawValue();
    const id = this.editingId();
    const payload = {
        projectId: pId,
        category: v.category ?? '',
        budget: v.budget ?? 0,
        actual: v.actual ?? 0,
    };
    this.saving.set(true);
    this.saveError.set(null);
    const request = id
      ? this.api.updateProjectFinancial(id, payload)
      : this.api.createProjectFinancial(payload);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.financialsRes.reload();
        this.notificationService.show(id ? 'Financial plan updated' : 'Financial plan created', 'success');
        this.closeForm();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.saveError.set(
          (error as { error?: { error?: string } })?.error?.error
            ?? 'Could not save the financial plan. Review the values and try again.',
        );
      },
    });
  }
}
