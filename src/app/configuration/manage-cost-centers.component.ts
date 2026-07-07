import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, CostCenter, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective],
  template: `
    <div class="max-w-5xl mx-auto space-y-8">
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

        <table class="command-data-table">
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
                <td class="text-right"><span class="text-accent-text">{{ cc.allocated }}</span></td>
                <td class="text-right">{{ cc.actual }}</td>
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
                <td colspan="5" class="text-center"><span class="text-[var(--cc-muted)]">No cost centers defined yet.</span></td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Form Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="costCenterModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="command-card-header">
              <h2 id="costCenterModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <form [formGroup]="form" (ngSubmit)="saveCostCenter()" class="p-6 space-y-4">
              <div>
                <label for="name" class="block text-sm font-medium text-ink-secondary mb-1">Name</label>
                <input id="name" type="text" formControlName="name" class="command-input" placeholder="e.g. Engineering & Dev">
              </div>

              <div>
                <label for="manager" class="block text-sm font-medium text-ink-secondary mb-1">Manager</label>
                <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                <select id="manager" formControlName="manager" class="command-select">
                  <option value="" disabled>Select a manager...</option>
                  @for (r of resourceOptions(); track r.id) {
                    <option [value]="r.name">{{ r.name }}</option>
                  }
                  @if (orphanManager(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
              </div>

              <div>
                <label for="allocated" class="block text-sm font-medium text-ink-secondary mb-1">Allocated</label>
                <input id="allocated" type="number" formControlName="allocated" class="command-input" placeholder="e.g. 100000">
              </div>

              <div>
                <label for="actual" class="block text-sm font-medium text-ink-secondary mb-1">Actual</label>
                <input id="actual" type="number" formControlName="actual" class="command-input" placeholder="e.g. 75000">
              </div>

              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!form.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Cost Center
                </button>
              </div>
            </form>
          </div>
        </div>
      }
      <!-- Delete Confirmation Modal -->
      @if (deletingId()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
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

  private costCentersRes = rxResource({ stream: () => this.api.getCostCenters(), defaultValue: [] as CostCenter[] });
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
    if (cc) {
      this.editingId.set(cc.id);
      this.form.patchValue({
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

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.reset();
  }

  saveCostCenter() {
    if (this.form.valid) {
      const raw = this.form.getRawValue();
      const payload: Partial<CostCenter> = {
        name: raw.name ?? '',
        manager: raw.manager ?? '',
        allocated: raw.allocated ?? 0,
        actual: raw.actual ?? 0
      };
      const id = this.editingId();

      if (id) {
        this.api.updateCostCenter(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          this.costCentersRes.reload();
          this.closeForm();
        });
      } else {
        this.api.createCostCenter(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          this.costCentersRes.reload();
          this.closeForm();
        });
      }
    }
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
