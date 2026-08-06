import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, ProjectDocument } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';

/**
 * Derive 1-2 uppercase initials from a display name (e.g. "Julie Armstrong" -> "JA",
 * "admin" -> "A"). Falls back to "?" for an empty/blank name so the avatar chip
 * always renders something.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

@Component({
  selector: 'app-project-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            @if (headingLevel() === 1) {
              <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Documents</h1>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Documents</h2>
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
            <mat-icon class="text-sm">note_add</mat-icon> Add Document Entry
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view documents.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          @for (doc of filteredDocuments(); track doc.id) {
            <!-- Document Card -->
            <div class="command-card p-6 group">
              <div class="flex items-start justify-between mb-4">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center ring-1"
                     [class.bg-critical-tint]="doc.type === 'pdf'" [class.text-critical-text]="doc.type === 'pdf'" [class.ring-critical]="doc.type === 'pdf'"
                     [class.bg-accent-tint]="doc.type === 'word'" [class.text-accent-text]="doc.type === 'word'" [class.ring-accent]="doc.type === 'word'">
                  <mat-icon>{{ doc.type === 'pdf' ? 'picture_as_pdf' : 'description' }}</mat-icon>
                </div>
                <!-- Arms the confirm below; nothing is destroyed from here. -->
                <button type="button" (click)="askDelete(doc)" [attr.aria-label]="'Delete ' + doc.name" class="text-[var(--cc-muted)] hover:text-critical-text opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                  <mat-icon class="text-sm">delete</mat-icon>
                </button>
              </div>
              <h3 class="font-bold text-[var(--cc-ink)] mb-1 truncate">{{ doc.name }}</h3>
              <p class="text-xs text-[var(--cc-muted)] mb-4 font-mono tabular-nums">{{ doc.size }} • Uploaded {{ doc.uploadedAt }}</p>
              <div class="flex items-center gap-2 text-xs text-[var(--cc-muted)]">
                <div class="w-6 h-6 rounded-full bg-[var(--cc-panel-muted)] flex items-center justify-center text-[10px] font-medium text-[var(--cc-ink)] font-mono">
                  {{ doc.authorInitials }}
                </div>
                <span>{{ doc.author }}</span>
              </div>
            </div>
          }
          @if (filteredDocuments().length === 0) {
            <div class="col-span-full py-8 text-center text-[var(--cc-muted)]">
              No documents found for this project.
            </div>
          }
        </div>
        }
      </div>

      <!-- Upload Document Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="documentModalTitle" (dismiss)="closeForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="documentModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Document Entry</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-[var(--cc-muted)] hover:text-[var(--cc-ink)] hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="docForm" (ngSubmit)="saveDocument()" class="space-y-6">
                <p class="text-xs text-[var(--cc-muted)]">This records document metadata only. No file is uploaded.</p>
                <!-- Rendered INLINE rather than left to the interceptor's toast, because
                     error toasts in this app auto-dismiss: a dialog that stays open with a
                     vanished toast is an unexplained refusal. Same shape as
                     project-cost-centers.ts's saveError. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="document-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="docName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Document Name *</label>
                  <input id="docName" type="text" formControlName="name" class="command-input" placeholder="e.g. Requirements_Spec.docx">
                </div>

                <div>
                  <label for="docType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Document Type *</label>
                  <select id="docType" formControlName="type" class="command-select">
                    <option value="pdf">PDF</option>
                    <option value="word">Word</option>
                    <option value="excel">Excel</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveDocument()" [disabled]="!docForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Add Entry
              </button>
            </div>
          </div>
        </div>
      }

      <!--
        DELETE CONFIRMATION. The trash icon is hover-revealed (sm:opacity-0) and sat
        directly on the DELETE: one mis-click removed the register entry outright.
        Nothing in this app can restore it — the row is the only record of the
        document's name, size, filing date and author attribution, and the
        append-only audit trail that holds the real actor is admin /
        delivery-executive readable only, so a project-level reader has no way back.
        Short dialog (icon + title + two lines + footer), so it deliberately keeps
        the plain centred overlay: it fits the ~460px a 320x568 phone leaves, and it
        is the negative control the scroll-safety predicate is measured against
        (manage-rate-cards.component.spec.ts documents that pairing).
      -->
      @if (pendingDelete(); as doc) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="documentDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col" data-test="document-delete-confirm">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="documentDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete document entry</h3>
              <p class="text-[var(--cc-muted)] text-sm">
                <strong class="text-ink">{{ doc.name }}</strong> is removed from this project's document register,
                together with its filing date and its attribution to {{ doc.author }}.
                This cannot be undone &mdash; the entry is not shown anywhere else once it is gone.
              </p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelDelete()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmDelete()" data-test="document-delete-confirm-action" class="px-4 py-2 bg-critical text-ink-inverse rounded-lg text-sm font-semibold hover:bg-critical-strong transition-colors shadow-sm">
                Delete entry
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectDocuments {
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
  
  docForm = new FormGroup({
    name: new FormControl('', Validators.required),
    type: new FormControl('pdf', Validators.required)
  });
  
  private documentsRes = authGatedResource(() => this.api.getProjectDocuments(), [] as ProjectDocument[]);
  documents = this.documentsRes.value;

  filteredDocuments = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.documents().filter(d => d.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showForm.set(true);
  }

  /**
   * The document awaiting confirmation. Holds the WHOLE record, not just an id: the
   * dialog names the file and its author, and an id alone would force a second
   * lookup that a concurrent reload could miss.
   */
  pendingDelete = signal<ProjectDocument | null>(null);

  /** First click: arm the confirm ONLY. No DELETE goes out from here. */
  askDelete(doc: ProjectDocument) {
    this.pendingDelete.set(doc);
  }

  cancelDelete() {
    this.pendingDelete.set(null);
  }

  /** The only place the DELETE is issued. */
  confirmDelete() {
    const doc = this.pendingDelete();
    if (!doc) return;
    // Cleared BEFORE the request so a double-click on the confirm control cannot
    // fire two DELETEs for the same row.
    this.pendingDelete.set(null);
    this.api.deleteProjectDocument(doc.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.documentsRes.reload();
      this.notificationService.show(`Document entry "${doc.name}" removed`, 'success');
    });
  }

  /** Server refusal text for the open dialog, or null. See the template comment. */
  saveError = signal<string | null>(null);

  closeForm() {
    this.showForm.set(false);
    this.saveError.set(null);
    this.docForm.reset({ type: 'pdf' });
  }

  saveDocument() {
    if (this.docForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    // ACTOR FIELD (Phase D): the document author is the signed-in user, derived from
    // AuthService (display name + initials) — never free-typed and not a person picker.
    // Mirrors how change-requests pins createdBy from the verified actor. Falls back to
    // 'Current User'/'CU' only when anonymous (no display name), preserving prior UX.
    const displayName = this.auth.displayName();
    const author = displayName || 'Current User';
    const authorInitials = displayName ? initialsOf(displayName) : 'CU';

    const v = this.docForm.getRawValue();
    const payload: Partial<ProjectDocument> = {
      projectId: pId,
      name: v.name ?? '',
      type: v.type ?? 'pdf',
      size: '1.0 MB',
      uploadedAt: 'Just now',
      author,
      authorInitials,
    };

    // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — same rule as
    // project-cost-centers.ts's saveCostCenter(). `closeForm()` used to run
    // unconditionally right after firing the POST, so `docForm.reset()` wiped the
    // typed name while the request was still in flight; on a refusal (a pm's 403 on
    // /project-documents, or a validation 400) the user got a toast over an empty
    // screen and had to retype from scratch. Staying open on the error path is the
    // whole fix: the interceptor's toast carries the server's message and the values
    // survive for a corrected retry.
    this.saveError.set(null);
    this.api.createProjectDocument(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.documentsRes.reload();
        this.closeForm();
      },
      error: (e: unknown) => {
        this.saveError.set(
          (e as { error?: { error?: string } })?.error?.error ?? 'Could not save the document entry.',
        );
      },
    });
  }
}
