import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { CurrencyPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, CostCenter, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective, CurrencyPipe],
  template: `
    <div class="command-page max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <div class="command-section-label">Configuration</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Cost Centers</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">Define and manage organizational cost centers for project budgeting.</p>
        </div>
        <button (click)="openForm()" class="command-button">
          <mat-icon class="text-sm">add</mat-icon> Add Cost Center
        </button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="p-4 border-b border-[var(--cc-line)] flex gap-4 bg-[var(--cc-panel-muted)]">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">search</mat-icon>
            <input type="text" placeholder="Search cost centers..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   aria-label="Search cost centers"
                   class="w-full pl-10 pr-4 py-2 bg-surface focus:bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
          </div>
        </div>

        <p id="costCentersTableHint" class="px-4 py-2 text-xs text-[var(--cc-muted)] border-b border-[var(--cc-line)] sm:hidden">
          Scroll horizontally to view financials and actions.
        </p>
        <div data-test="cost-centers-table-scroll" class="overflow-x-auto overscroll-x-contain" role="region"
             aria-label="Cost centers table" aria-describedby="costCentersTableHint" tabindex="0">
        <table class="command-data-table min-w-[42rem]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Manager</th>
              <th class="text-right">Allocated</th>
              <th class="text-right">Actual</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (cc of filteredCostCenters(); track cc.id) {
              <tr>
                <td class="font-bold">{{ cc.name }}</td>
                <td>{{ cc.manager }}</td>
                <td class="text-right"><span class="text-accent-text">{{ cc.allocated | currency:'EUR':'symbol':'1.0-0' }}</span></td>
                <td class="text-right">{{ cc.actual | currency:'EUR':'symbol':'1.0-0' }}</td>
                <td class="text-right">
                  <button type="button" (click)="openForm(cc)" [attr.aria-label]="'Edit ' + cc.name" [attr.title]="'Edit ' + cc.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteCostCenter(cc.id)" [attr.aria-label]="'Delete ' + cc.name" [attr.title]="'Delete ' + cc.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (filteredCostCenters().length === 0) {
              <tr>
                <td colspan="5" class="text-center">
                  @if (costCenters().length === 0) {
                    <span class="text-[var(--cc-muted)]">No cost centers defined yet.</span>
                  } @else {
                    <div class="inline-flex flex-col items-center gap-2">
                      <span class="text-[var(--cc-muted)]">No cost centers match your search.</span>
                      <button type="button" (click)="clearSearch()" class="command-button secondary">Clear filters</button>
                    </div>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
        </div>
      </div>

      <!-- Form Modal -->
      @if (showForm()) {
        <!-- SCROLL-SAFE OVERLAY (the shape manage-rate-cards and billing.ts use).
             Four fields plus a header and footer; on a 320x568 phone about 460px of
             visual viewport survives the browser chrome. A fixed items-center
             overlay splits the surplus above and below the centre, so the header
             went above y=0 and the "Save Cost Center" footer below the fold — and a
             fixed box cannot be scrolled by the page, so the form could be filled
             in and never submitted. overflow-y-auto gives the overlay its own
             scroller, items-start anchors the panel at the top on short viewports,
             and the panel's max-h-[90vh] plus the scrolling body below keep the
             footer reachable. -->
        <div data-test="cost-center-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="costCenterModalTitle" (dismiss)="closeForm()">
          <div data-test="cost-center-form-panel" class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="costCenterModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors disabled:opacity-50">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <!-- The <form> stays the submit boundary (so Enter still submits) and
                 becomes a column: the fields scroll, the footer is pinned. -->
            <form [formGroup]="form" (ngSubmit)="saveCostCenter()" [attr.aria-busy]="saving()" class="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div class="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
                <div>
                  <label for="costCenterName" class="block text-sm font-medium text-ink-secondary mb-1">Name <span aria-hidden="true">*</span><span class="sr-only"> required</span></label>
                  <input id="costCenterName" type="text" formControlName="name" class="command-input" placeholder="e.g. Engineering & Dev"
                         required aria-required="true" [attr.aria-invalid]="invalid('name') ? 'true' : null"
                         [attr.aria-describedby]="invalid('name') ? 'costCenterNameError' : null">
                  @if (invalid('name')) {
                    <p id="costCenterNameError" role="alert" class="mt-1 text-xs text-critical-text">Name is required.</p>
                  }
                </div>

                <div>
                  <label for="costCenterManager" class="block text-sm font-medium text-ink-secondary mb-1">Manager <span aria-hidden="true">*</span><span class="sr-only"> required</span></label>
                  <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                  <select id="costCenterManager" formControlName="manager" class="command-select"
                          required aria-required="true" [attr.aria-invalid]="invalid('manager') ? 'true' : null"
                          [attr.aria-describedby]="invalid('manager') ? 'costCenterManagerError' : null">
                    <option value="" disabled>Select a manager...</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanManager(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                  @if (invalid('manager')) {
                    <p id="costCenterManagerError" role="alert" class="mt-1 text-xs text-critical-text">Manager is required.</p>
                  }
                </div>

                <div>
                  <label for="costCenterAllocated" class="block text-sm font-medium text-ink-secondary mb-1">Allocated <span aria-hidden="true">*</span><span class="sr-only"> required</span></label>
                  <input id="costCenterAllocated" type="number" formControlName="allocated" class="command-input" placeholder="e.g. 100000"
                         required aria-required="true" [attr.aria-invalid]="invalid('allocated') ? 'true' : null"
                         [attr.aria-describedby]="invalid('allocated') ? 'costCenterAllocatedError' : null">
                  @if (invalid('allocated')) {
                    <p id="costCenterAllocatedError" role="alert" class="mt-1 text-xs text-critical-text">Allocated amount is required.</p>
                  }
                </div>

                <div>
                  <label for="costCenterActual" class="block text-sm font-medium text-ink-secondary mb-1">Actual <span aria-hidden="true">*</span><span class="sr-only"> required</span></label>
                  <input id="costCenterActual" type="number" formControlName="actual" class="command-input" placeholder="e.g. 75000"
                         required aria-required="true" [attr.aria-invalid]="invalid('actual') ? 'true' : null"
                         [attr.aria-describedby]="invalid('actual') ? 'costCenterActualError' : null">
                  @if (invalid('actual')) {
                    <p id="costCenterActualError" role="alert" class="mt-1 text-xs text-critical-text">Actual amount is required.</p>
                  }
                </div>
                @if (saveError()) {
                  <p id="costCenterSaveError" role="alert" class="rounded-lg border border-critical bg-critical-tint px-3 py-2 text-sm text-critical-text">
                    {{ saveError() }} You can retry without re-entering the form.
                  </p>
                }
              </div>

              <div class="px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
                <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
                <button type="submit" [disabled]="saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ saving() ? 'Saving…' : 'Save Cost Center' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }
      <!-- Delete Confirmation Modal -->
      @if (deletingId()) {
        <!-- Short warning dialog (icon + title + two lines + footer): it fits the
             ~460px a 320x568 phone leaves, so it deliberately keeps the plain centred
             overlay — the same call manage-rate-cards makes. Its className is exactly
             what the FORM overlay carried before the fix, which is what lets the spec
             use it as the negative control that keeps the scroll-safety predicate from
             degenerating into a class-string tautology. -->
        <div data-test="cost-center-delete-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="costCenterDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="costCenterDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete Cost Center</h3>
              <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this cost center? This action cannot be undone.</p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button (click)="cancelDelete()" class="command-button secondary">Cancel</button>
              <button (click)="confirmDelete()" class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm">Delete</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ManageCostCentersComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  private costCentersRes = rxResource<CostCenter[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getCostCenters() : of<CostCenter[]>([])),
    defaultValue: [] as CostCenter[],
  });
  costCenters = this.costCentersRes.value;

  // The cost-center manager is a PERSON reference bound to the resources (people)
  // catalog by name (Phase D). /resources is a principal-gated read, so key the load
  // on authReady to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  search = signal('');
  filteredCostCenters = computed(() => {
    const q = this.search().toLowerCase();
    return this.costCenters().filter(c => c.name.toLowerCase().includes(q));
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

  form = new FormGroup({
    name: new FormControl('', Validators.required),
    manager: new FormControl('', Validators.required),
    allocated: new FormControl<number>(0, Validators.required),
    actual: new FormControl<number>(0, Validators.required)
  });

  // ORPHAN VALUE: a stored manager that isn't a current resource name is surfaced as a
  // disabled option so editing never silently discards a real value.
  private managerValue = toSignal(this.form.controls.manager.valueChanges, { initialValue: this.form.controls.manager.value });
  orphanManager = computed<string | null>(() => {
    const current = this.managerValue();
    if (!current) return null;
    return this.resourceOptions().some(r => r.name === current) ? null : current;
  });

  openForm(cc?: CostCenter) {
    this.saveError.set(null);
    this.saving.set(false);
    if (cc) {
      this.editingId.set(cc.id);
      this.form.reset({
        name: cc.name,
        manager: cc.manager,
        allocated: cc.allocated,
        actual: cc.actual
      });
    } else {
      this.editingId.set(null);
      this.form.reset({ name: '', manager: '', allocated: 0, actual: 0 });
    }
    this.showForm.set(true);
  }

  closeForm(force = false) {
    if (this.saving()) return;
    if (!force && this.form.dirty && typeof window !== 'undefined'
        && !window.confirm('Discard your unsaved cost center changes?')) return;
    this.showForm.set(false);
    this.editingId.set(null);
    this.saveError.set(null);
    this.form.reset();
  }

  clearSearch() { this.search.set(''); }

  invalid(controlName: keyof typeof this.form.controls): boolean {
    const control = this.form.controls[controlName];
    return control.invalid && (control.touched || control.dirty);
  }

  private focusFirstInvalidControl() {
    const controls: [keyof typeof this.form.controls, string][] = [
      ['name', 'costCenterName'],
      ['manager', 'costCenterManager'],
      ['allocated', 'costCenterAllocated'],
      ['actual', 'costCenterActual'],
    ];
    const id = controls.find(([name]) => this.form.controls[name].invalid)?.[1];
    if (id) queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id}`)?.focus());
  }

  private apiErrorMessage(error: unknown): string {
    const response = error as { error?: { error?: unknown }; message?: unknown } | null;
    const detail = response?.error?.error ?? response?.message;
    return typeof detail === 'string' && detail.trim() ? detail : 'Unable to save the cost center.';
  }

  saveCostCenter() {
    if (this.saving()) return;
    this.saveError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.focusFirstInvalidControl();
      return;
    }
    const raw = this.form.getRawValue();
    const payload: Partial<CostCenter> = {
      name: raw.name ?? '',
      manager: raw.manager ?? '',
      allocated: raw.allocated ?? 0,
      actual: raw.actual ?? 0
    };
    const id = this.editingId();
    this.saving.set(true);
    const request = id ? this.api.updateCostCenter(id, payload) : this.api.createCostCenter(payload);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.costCentersRes.reload();
        this.closeForm(true);
      },
      error: error => {
        this.saving.set(false);
        this.saveError.set(this.apiErrorMessage(error));
      },
    });
  }

  deleteCostCenter(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteCostCenter(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.costCentersRes.reload();
        this.deletingId.set(null);
      });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
