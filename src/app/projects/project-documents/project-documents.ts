import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, ProjectDocument } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Documents</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Documents</h2>
            }
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-sm">note_add</mat-icon> Add Document Entry
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
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
                     [class.bg-red-50]="doc.type === 'pdf'" [class.text-red-700]="doc.type === 'pdf'" [class.ring-red-200]="doc.type === 'pdf'"
                     [class.bg-blue-50]="doc.type === 'word'" [class.text-blue-700]="doc.type === 'word'" [class.ring-blue-200]="doc.type === 'word'">
                  <mat-icon>{{ doc.type === 'pdf' ? 'picture_as_pdf' : 'description' }}</mat-icon>
                </div>
                <button type="button" (click)="deleteDocument(doc)" aria-label="Delete document" class="text-[var(--cc-muted)] hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity">
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
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="documentModalTitle" (dismiss)="closeForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="documentModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Document Entry</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-[var(--cc-muted)] hover:text-[var(--cc-ink)] hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="docForm" (ngSubmit)="saveDocument()" class="space-y-6">
                <p class="text-xs text-[var(--cc-muted)]">This records document metadata only. No file is uploaded.</p>
                <div>
                  <label for="docName" class="block text-sm font-semibold text-slate-700 mb-1.5">Document Name *</label>
                  <input id="docName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="e.g. Requirements_Spec.docx">
                </div>

                <div>
                  <label for="docType" class="block text-sm font-semibold text-slate-700 mb-1.5">Document Type *</label>
                  <select id="docType" formControlName="type" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
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
    </div>
  `
})
export class ProjectDocuments {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({
    stream: () => this.api.getProjects(),
    defaultValue: [] as Project[]
  });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  docForm = new FormGroup({
    name: new FormControl('', Validators.required),
    type: new FormControl('pdf', Validators.required)
  });
  
  private documentsRes = rxResource({
    stream: () => this.api.getProjectDocuments(),
    defaultValue: [] as ProjectDocument[]
  });
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

  deleteDocument(doc: ProjectDocument) {
    this.api.deleteProjectDocument(doc.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.documentsRes.reload();
      this.notificationService.show('Document entry removed', 'success');
    });
  }

  closeForm() {
    this.showForm.set(false);
    this.docForm.reset({ type: 'pdf' });
  }

  saveDocument() {
    if (this.docForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.docForm.getRawValue();
    const payload: Partial<ProjectDocument> = {
      projectId: pId,
      name: v.name ?? '',
      type: v.type ?? 'pdf',
      size: '1.0 MB',
      uploadedAt: 'Just now',
      author: 'Current User',
      authorInitials: 'CU',
    };

    this.api.createProjectDocument(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.documentsRes.reload());
    this.closeForm();
  }
}
