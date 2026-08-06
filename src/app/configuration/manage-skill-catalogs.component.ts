import { Component, inject, signal, computed } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, SkillCatalog } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { authGatedResource } from '../services/auth-gated-resource.util';

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
                  <!-- ARMED STATE IS RENDERED IN THE ROW, not announced in a toast.
                       The previous shape armed pendingDeleteId invisibly and never
                       expired it, while its only warning was a toast that
                       auto-dismisses after 5s: ten minutes later the same trash
                       icon — or a DIFFERENT row's, since the armed id survived
                       whatever the admin did next — deleted a whole catalog
                       outright. Confirm/Cancel live inside the armed row, so the
                       armed object is always the object the admin can see.
                       Same shape as manage-skills.component.ts. -->
                  @if (pendingDeleteId() === catalog.id) {
                    <div class="inline-flex items-center gap-2">
                      <span class="text-xs font-bold text-[var(--cc-muted)]">Delete {{ catalog.name }}?</span>
                      <button type="button" (click)="confirmDelete(catalog.id)" class="px-3 py-1.5 text-xs font-bold text-critical-text bg-critical-tint ring-1 ring-critical rounded-lg hover:bg-[color-mix(in_oklch,var(--color-critical)_16%,var(--color-surface))] transition-all shadow-sm">Confirm</button>
                      <button type="button" (click)="cancelDelete()" class="px-3 py-1.5 text-xs font-bold text-ink-secondary bg-surface border border-line rounded-lg hover:bg-surface-muted transition-all shadow-sm">Cancel</button>
                    </div>
                  } @else {
                    <button type="button" (click)="requestDelete(catalog.id)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete catalog ' + catalog.name" [attr.title]="'Delete catalog ' + catalog.name">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  }
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

  private catalogsRes = authGatedResource(() => this.api.getSkillCatalogs(), [] as SkillCatalog[]);
  skillCatalogs = computed(() => this.catalogsRes.value());

  showForm = signal(false);
  /** Read by the template: the armed row renders its own Confirm/Cancel pair. */
  protected pendingDeleteId = signal<string | null>(null);

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

  /**
   * Arms the row. Deliberately CANNOT delete: the only path to the DELETE is the
   * Confirm control rendered inside the armed row, so a stale click on a trash
   * icon — the same one, or another row's — can never destroy anything.
   *
   * The toast is now corroboration, not the warning: it names the catalog and the
   * consequence the old copy left out. `DELETE /skill-catalogs/:id`
   * (src/server.ts:4346) removes the row with no referential guard, and a skill
   * carries its catalogs as an ARRAY OF IDS, so every skill grouped under this
   * catalog keeps a dead id and renders "Unknown" in the Catalogs column of
   * /config/skills (manage-skills.component.ts getCatalogName).
   */
  requestDelete(id: string) {
    this.pendingDeleteId.set(id);
    const name = this.skillCatalogs().find(c => c.id === id)?.name ?? 'this catalog';
    this.notificationService.show(
      `Confirm deletion of "${name}". Skills grouped under it keep a dead catalog id and show "Unknown" in the Catalogs column.`,
      'info',
    );
  }

  cancelDelete() {
    this.pendingDeleteId.set(null);
  }

  confirmDelete(id: string) {
    this.api.deleteSkillCatalog(id).subscribe(() => {
      this.pendingDeleteId.set(null);
      this.catalogsRes.reload();
    });
  }
}
