import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Industry } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { authGatedResource } from '../services/auth-gated-resource.util';

@Component({
  selector: 'app-manage-industries',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective],
  template: `
    <div class="command-page max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <div class="command-section-label">Configuration</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Industries</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">Maintain the customer industry-sector catalog.</p>
        </div>
        <button (click)="openForm()" class="command-button">
          <mat-icon class="text-sm">add</mat-icon> Add Industry
        </button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="p-4 border-b border-[var(--cc-line)] flex gap-4 bg-[var(--cc-panel-muted)]">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">search</mat-icon>
            <input type="text" placeholder="Search industries..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   aria-label="Search industries"
                   class="w-full pl-10 pr-4 py-2 bg-surface focus:bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
          </div>
        </div>

        <table class="command-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (it of filtered(); track it.id) {
              <tr>
                <td class="font-bold">{{ it.name }}</td>
                <td class="text-right">
                  <button type="button" (click)="openForm(it)" [attr.aria-label]="'Edit ' + it.name" [attr.title]="'Edit ' + it.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteItem(it.id)" [attr.aria-label]="'Delete ' + it.name" [attr.title]="'Delete ' + it.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (filtered().length === 0) {
              <tr>
                <td colspan="2" class="text-center">
                  @if (items().length === 0) {
                    <span class="text-[var(--cc-muted)]">No industries defined yet.</span>
                  } @else {
                    <div class="inline-flex flex-col items-center gap-2">
                      <span class="text-[var(--cc-muted)]">No industries match your search.</span>
                      <button type="button" (click)="clearSearch()" class="command-button secondary">Clear filters</button>
                    </div>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (showForm()) {
        <!-- SCROLL-SAFE OVERLAY (the shape manage-rate-cards and billing.ts use).
             A fixed items-center overlay centres a panel taller than the viewport,
             which pushes the header above y=0 and the "Save Industry" row below the
             fold — and a fixed box cannot be scrolled by the page, so the form could
             be filled in and never submitted. This panel is short today, but the
             overlay's own scroller is what makes the footer reachable at 200% browser
             zoom (which halves the effective viewport) and if the form ever grows.
             overflow-y-auto gives the overlay its scroller, items-start anchors the
             panel at the top on short viewports, and the panel's max-h-[90vh] plus the
             scrolling body below keep the footer reachable. -->
        <div data-test="industry-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="industryModalTitle" (dismiss)="closeForm()">
          <div data-test="industry-form-panel" class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="industryModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Industry' : 'Add Industry' }}</h2>
              <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors disabled:opacity-50">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <!-- The <form> stays the submit boundary (so Enter still submits) and
                 becomes a column: the fields scroll, the footer is pinned. -->
            <form [formGroup]="form" (ngSubmit)="save()" [attr.aria-busy]="saving()" class="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div class="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
                <div>
                  <label for="industryName" class="block text-sm font-medium text-ink-secondary mb-1">
                    Name <span aria-hidden="true">*</span><span class="sr-only"> required</span>
                  </label>
                  <input id="industryName" type="text" formControlName="name" class="command-input" placeholder="e.g. Technology"
                         required aria-required="true"
                         [attr.aria-invalid]="invalid('name') ? 'true' : null"
                         [attr.aria-describedby]="invalid('name') ? 'industryNameError' : null">
                  @if (invalid('name')) {
                    <p id="industryNameError" role="alert" class="mt-1 text-xs text-critical-text">Name is required.</p>
                  }
                </div>
                @if (saveError()) {
                  <p id="industrySaveError" role="alert" class="rounded-lg border border-critical bg-critical-tint px-3 py-2 text-sm text-critical-text">
                    {{ saveError() }} You can retry without re-entering the form.
                  </p>
                }
              </div>
              <div class="px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
                <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
                <button type="submit" [disabled]="saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ saving() ? 'Saving…' : 'Save Industry' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }

      @if (deletingId()) {
        <!-- Short warning dialog (icon + title + two lines + footer): it fits the
             ~460px a 320x568 phone leaves, so it deliberately keeps the plain centred
             overlay. Its className is exactly what the FORM overlay carried before the
             fix, which is what lets the spec use it as the negative control that keeps
             the scroll-safety predicate from degenerating into a class-string
             tautology. -->
        <div data-test="industry-delete-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="industryDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="industryDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete Industry</h3>
              <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this industry? This action cannot be undone.</p>
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
export class ManageIndustriesComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private notifications = inject(NotificationService);

  private itemsRes = authGatedResource(() => this.api.getIndustries(), [] as Industry[]);
  items = this.itemsRes.value;

  search = signal('');
  filtered = computed(() => {
    const q = this.search().toLowerCase();
    return this.items().filter(i => i.name.toLowerCase().includes(q));
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

  form = new FormGroup({
    name: new FormControl('', Validators.required),
  });

  openForm(it?: Industry) {
    this.saveError.set(null);
    this.saving.set(false);
    if (it) {
      this.editingId.set(it.id);
      this.form.reset({ name: it.name });
    } else {
      this.editingId.set(null);
      this.form.reset({ name: '' });
    }
    this.showForm.set(true);
  }

  closeForm(force = false) {
    if (this.saving()) return;
    if (!force && this.form.dirty && typeof window !== 'undefined'
        && !window.confirm('Discard your unsaved industry changes?')) return;
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
    const id = this.form.controls.name.invalid ? 'industryName' : null;
    if (id) queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id}`)?.focus());
  }

  private apiErrorMessage(error: unknown): string {
    const response = error as { error?: { error?: unknown }; message?: unknown } | null;
    const detail = response?.error?.error ?? response?.message;
    return typeof detail === 'string' && detail.trim() ? detail : 'Unable to save the industry.';
  }

  save() {
    if (this.saving()) return;
    this.saveError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.focusFirstInvalidControl();
      return;
    }
    const payload: Partial<Industry> = { name: this.form.getRawValue().name ?? '' };
    const id = this.editingId();
    this.saving.set(true);
    const request = id ? this.api.updateIndustry(id, payload) : this.api.createIndustry(payload);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.itemsRes.reload();
        this.closeForm(true);
        this.notifications.show('Industry saved.', 'success');
      },
      error: error => {
        this.saving.set(false);
        this.saveError.set(this.apiErrorMessage(error));
      },
    });
  }

  deleteItem(id: string) { this.deletingId.set(id); }

  confirmDelete() {
    const id = this.deletingId();
    if (!id) return;
    this.api.deleteIndustry(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.itemsRes.reload();
      this.deletingId.set(null);
      this.notifications.show('Industry deleted.', 'success');
    });
  }

  cancelDelete() { this.deletingId.set(null); }
}
