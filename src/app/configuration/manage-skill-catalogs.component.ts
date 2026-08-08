import { Component, DestroyRef, ElementRef, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, SkillCatalog } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { ConfigurationPageShellComponent } from './configuration-page-shell.component';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-skill-catalogs',
  imports: [ReactiveFormsModule, MatIconModule, ConfigurationPageShellComponent, ModalDialogDirective],
  template: `
    <app-configuration-page-shell title="Manage Skill Catalogs" subtitle="Organize governed skills into reusable catalogs.">
      <button configuration-actions (click)="openCreateForm()" class="command-button">
        <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Catalog
      </button>
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Skill catalogs</h2>
      </div>

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
            @if (skillCatalogs().length === 0) {
              <tr>
                <td colspan="4" class="text-center text-[var(--cc-muted)]">No skill catalogs defined yet.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (showForm()) {
      <div data-test="skill-catalog-form-overlay"
           class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
           appModal ariaLabelledby="skillCatalogModalTitle" (dismiss)="closeForm()" (click)="onFormBackdrop($event)">
        <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="skillCatalogModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Create Skill Catalog</h2>
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close dialog" title="Close"
                    class="text-ink-muted hover:text-ink-secondary transition-colors disabled:opacity-50">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          <form [formGroup]="catalogForm" (ngSubmit)="onSubmit()" [attr.aria-busy]="saving()" class="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div class="p-6 space-y-6 overflow-y-auto flex-1 min-h-0">
              <div>
                <label for="catalogName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">
                  Name <span aria-hidden="true">*</span><span class="sr-only"> required</span>
                </label>
                <input id="catalogName" type="text" formControlName="name" class="command-input"
                       required aria-required="true" [attr.aria-invalid]="invalid('name') ? 'true' : null"
                       [attr.aria-describedby]="invalid('name') ? 'catalogNameError' : null">
                @if (invalid('name')) {
                  <p id="catalogNameError" role="alert" class="mt-1 text-xs text-critical-text">Name is required.</p>
                }
              </div>
              <div>
                <label for="catalogDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
                <textarea id="catalogDescription" formControlName="description" rows="3" class="command-textarea"></textarea>
              </div>
              @if (saveError()) {
                <p id="skillCatalogSaveError" role="alert" class="rounded-lg border border-critical bg-critical-tint px-3 py-2 text-sm text-critical-text">
                  {{ saveError() }} You can retry without re-entering the form.
                </p>
              }
            </div>
            <div class="px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
              <button type="submit" [disabled]="saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ saving() ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
    </app-configuration-page-shell>
  `
})
export class ManageSkillCatalogsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private destroyRef = inject(DestroyRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private notificationService = inject(NotificationService);

  private catalogsRes = authGatedResource(() => this.api.getSkillCatalogs(), [] as SkillCatalog[]);
  skillCatalogs = computed(() => this.catalogsRes.value());

  showForm = signal(false);
  saving = signal(false);
  saveError = signal<string | null>(null);
  /** Read by the template: the armed row renders its own Confirm/Cancel pair. */
  protected pendingDeleteId = signal<string | null>(null);

  catalogForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: ['']
  });

  openCreateForm() {
    this.saving.set(false);
    this.saveError.set(null);
    this.catalogForm.reset({ name: '', description: '' });
    this.showForm.set(true);
  }

  closeForm(force = false) {
    if (this.saving()) return;
    if (!force && this.catalogForm.dirty && typeof window !== 'undefined'
        && !window.confirm('Discard your unsaved skill catalog changes?')) return;
    this.showForm.set(false);
    this.saveError.set(null);
    this.catalogForm.reset({ name: '', description: '' });
  }

  onFormBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) this.closeForm();
  }

  invalid(controlName: 'name' | 'description'): boolean {
    const control = this.catalogForm.controls[controlName];
    return control.invalid && (control.touched || control.dirty);
  }

  private focusFirstInvalidControl() {
    if (this.catalogForm.controls['name'].invalid) {
      queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('#catalogName')?.focus());
    }
  }

  private apiErrorMessage(error: unknown): string {
    const response = error as { error?: { error?: unknown }; message?: unknown } | null;
    const detail = response?.error?.error ?? response?.message;
    return typeof detail === 'string' && detail.trim() ? detail : 'Unable to save the skill catalog.';
  }

  onSubmit() {
    if (this.saving()) return;
    this.saveError.set(null);
    if (this.catalogForm.invalid) {
      this.catalogForm.markAllAsTouched();
      this.focusFirstInvalidControl();
      return;
    }
    this.saving.set(true);
    this.api.createSkillCatalog(this.catalogForm.getRawValue())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.catalogsRes.reload();
          this.closeForm(true);
        },
        error: error => {
          this.saving.set(false);
          this.saveError.set(this.apiErrorMessage(error));
        },
      });
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
