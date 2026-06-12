import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, SkillCatalog } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-skill-catalogs',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Skill Catalogs</h2>
        <button (click)="openCreateForm()" class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Catalog
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="catalogForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-md">
            <div>
              <label for="catalogName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
              <input id="catalogName" type="text" formControlName="name" class="command-input">
            </div>
            <div>
              <label for="catalogDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
              <textarea id="catalogDescription" formControlName="description" rows="3" class="command-textarea"></textarea>
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="catalogForm.invalid" class="command-button disabled:opacity-50">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="overflow-x-auto">
        <table class="command-data-table">
          <thead>
            <tr>
              <th class="w-1/3">Name</th>
              <th>Description</th>
              <th class="text-right">Skills Count</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (catalog of skillCatalogs(); track catalog.id) {
              <tr>
                <td class="font-bold">{{ catalog.name }}</td>
                <td>{{ catalog.description }}</td>
                <td class="text-right">
                  <span class="command-status">{{ catalog.skills.length }}</span>
                </td>
                <td class="text-right">
                  <button (click)="deleteCatalog(catalog.id)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `
})
export class ManageSkillCatalogsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);

  private catalogsRes = rxResource({
    stream: () => this.api.getSkillCatalogs(),
    defaultValue: [] as SkillCatalog[]
  });
  skillCatalogs = computed(() => this.catalogsRes.value());

  showForm = signal(false);
  private pendingDeleteId = signal<string | null>(null);

  catalogForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: ['']
  });

  openCreateForm() {
    this.catalogForm.reset();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  onSubmit() {
    if (this.catalogForm.valid) {
      this.api.createSkillCatalog(this.catalogForm.value).subscribe(() => {
        this.catalogsRes.reload();
        this.closeForm();
      });
    }
  }

  deleteCatalog(id: string) {
    if (this.pendingDeleteId() === id) {
      this.pendingDeleteId.set(null);
      this.api.deleteSkillCatalog(id).subscribe(() => {
        this.catalogsRes.reload();
      });
    } else {
      this.pendingDeleteId.set(id);
      this.notificationService.show('Click delete again to confirm removing this catalog', 'info');
    }
  }
}
