import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormArray } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceOrganization } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-resource-organizations',
  imports: [ReactiveFormsModule, MatIconModule, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Resource Organizations</h2>
        <button (click)="openCreateForm()" class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Organization
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="orgForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-3xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="orgName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
                <input id="orgName" type="text" formControlName="name" class="command-input">
              </div>
              <div>
                <label for="orgDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
                <input id="orgDescription" type="text" formControlName="description" class="command-input">
              </div>
            </div>

            <div formArrayName="costCenters" class="space-y-4 mt-8">
              <div class="flex justify-between items-center pb-2 border-b border-[var(--cc-line)]">
                <h3 class="command-section-label">Cost Centers</h3>
                <button type="button" (click)="addCostCenter()" class="command-button secondary">
                  <mat-icon class="text-[18px] w-[18px] h-[18px]">add_circle</mat-icon> Add Cost Center
                </button>
              </div>

              <div class="space-y-3">
                @for (cc of costCenters.controls; track i; let i = $index) {
                  <div class="command-card flex gap-4 items-center p-4 group">
                    <div class="flex-1">
                      <input type="text" [formControlName]="i" placeholder="Cost Center ID" class="command-input font-mono">
                    </div>
                    <button type="button" (click)="removeCostCenter(i)" class="w-10 h-10 rounded-full bg-surface-muted border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">remove_circle</mat-icon>
                    </button>
                  </div>
                }
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-6 border-t border-[var(--cc-line)]">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="orgForm.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="w-1/4">Name</th>
                <th class="w-1/3">Description</th>
                <th>Cost Centers</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (org of resourceOrganizations(); track org.id) {
                <tr>
                  <td class="font-bold text-base">{{ org.name }}</td>
                  <td class="font-medium"><span class="text-[var(--cc-muted)]">{{ org.description }}</span></td>
                  <td>
                    <div class="flex flex-wrap gap-2">
                      @for (cc of org.costCenters; track cc) {
                        <span class="command-status">
                          {{ cc }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="text-right">
                    <button (click)="deleteOrg(org.id)" class="w-10 h-10 rounded-full bg-surface-muted border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (deletingId()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
           appModal ariaLabelledby="resourceOrgDeleteTitle" (dismiss)="cancelDelete()">
        <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-critical-text text-4xl">warning</mat-icon>
            </div>
            <h3 id="resourceOrgDeleteTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] mb-2 tracking-tight">Delete Resource Organization</h3>
            <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this resource organization? This action cannot be undone.</p>
          </div>
          <div class="p-5 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
            <button (click)="cancelDelete()" class="command-button secondary">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-critical-tint text-critical-text ring-1 ring-critical rounded-xl text-sm font-semibold hover:bg-[color-mix(in_oklch,var(--color-critical)_16%,var(--color-surface))] hover:shadow-md hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
    </div>
  `
})
export class ManageResourceOrganizationsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notifications = inject(NotificationService);

  private orgsRes = rxResource({ stream: () => this.api.getResourceOrganizations(), defaultValue: [] as ResourceOrganization[] });
  resourceOrganizations = computed(() => this.orgsRes.value());
  showForm = signal(false);
  deletingId = signal<string | null>(null);

  orgForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    costCenters: this.fb.array([])
  });

  get costCenters() {
    return this.orgForm.get('costCenters') as FormArray;
  }

  openCreateForm() {
    this.orgForm.reset();
    this.costCenters.clear();
    this.addCostCenter();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  addCostCenter() {
    this.costCenters.push(this.fb.control('', Validators.required));
  }

  removeCostCenter(index: number) {
    this.costCenters.removeAt(index);
  }

  onSubmit() {
    if (this.orgForm.valid) {
      this.api.createResourceOrganization(this.orgForm.value).subscribe(() => {
        this.orgsRes.reload();
        this.closeForm();
        this.notifications.show('Resource organization created.', 'success');
      });
    }
  }

  deleteOrg(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteResourceOrganization(id).subscribe(() => {
        this.orgsRes.reload();
        this.deletingId.set(null);
        this.notifications.show('Resource organization deleted.', 'success');
      });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
