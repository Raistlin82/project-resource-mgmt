import { ChangeDetectionStrategy, Component, signal, input, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, ProjectCostCenter } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <div>
                <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Cost Centers</h2>
                <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage and allocate project budget to specific cost centers.</p>
              </div>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <div>
                <h3 class="font-display text-lg font-bold text-[var(--cc-ink)]">Cost Centers</h3>
                <p class="text-sm text-[var(--cc-muted)]">Manage and allocate project budget to specific cost centers.</p>
              </div>
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
                  <label for="ccId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Cost Center ID *</label>
                  <input id="ccId" type="text" formControlName="id" class="command-input" placeholder="e.g. CC-1234">
                </div>

                <div>
                  <label for="ccName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name *</label>
                  <input id="ccName" type="text" formControlName="name" class="command-input" placeholder="e.g. Engineering">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="ccBudget" class="block text-sm font-semibold text-ink-secondary mb-1.5">Allocated Budget *</label>
                    <input id="ccBudget" type="number" formControlName="allocatedBudget" class="command-input">
                  </div>

                  <div>
                    <label for="ccManager" class="block text-sm font-semibold text-ink-secondary mb-1.5">Manager</label>
                    <input id="ccManager" type="text" formControlName="manager" class="command-input" placeholder="e.g. John Doe">
                  </div>
                </div>
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
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  editingId = signal<string | null>(null);

  ccForm = new FormGroup({
    id: new FormControl('', Validators.required),
    name: new FormControl('', Validators.required),
    allocatedBudget: new FormControl(0, [Validators.required, Validators.min(0)]),
    manager: new FormControl('')
  });

  private costCentersRes = rxResource({ stream: () => this.api.getProjectCostCenters(), defaultValue: [] as ProjectCostCenter[] });
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
    this.ccForm.reset({ allocatedBudget: 0 });
    this.ccForm.get('id')?.enable();
    this.showForm.set(true);
  }

  openEditForm(cc: ProjectCostCenter) {
    this.editingId.set(cc.id);
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

    if (editingId) {
      this.api.updateProjectCostCenter(editingId, {
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.costCentersRes.reload());
    } else {
      this.api.createProjectCostCenter({
        id: v.id ?? '',
        projectId: pId,
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
        actual: 0,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.costCentersRes.reload());
    }

    this.closeForm();
  }
}
