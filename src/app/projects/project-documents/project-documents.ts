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
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Documents</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500/25 focus:border-blue-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Documents</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-4 py-2 rounded-xl text-sm transition-colors flex items-center gap-2">
            <mat-icon class="text-sm">note_add</mat-icon> Add Document Entry
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view documents.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          @for (doc of filteredDocuments(); track doc.id) {
            <!-- Document Card -->
            <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-6 hover:shadow-md transition-shadow group">
              <div class="flex items-start justify-between mb-4">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center ring-1"
                     [class.bg-red-50]="doc.type === 'pdf'" [class.text-red-700]="doc.type === 'pdf'" [class.ring-red-200]="doc.type === 'pdf'"
                     [class.bg-blue-50]="doc.type === 'word'" [class.text-blue-700]="doc.type === 'word'" [class.ring-blue-200]="doc.type === 'word'">
                  <mat-icon>{{ doc.type === 'pdf' ? 'picture_as_pdf' : 'description' }}</mat-icon>
                </div>
                <button type="button" (click)="deleteDocument(doc)" aria-label="Delete document" class="text-slate-400 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity">
                  <mat-icon class="text-sm">delete</mat-icon>
                </button>
              </div>
              <h3 class="font-medium text-slate-900 mb-1 truncate">{{ doc.name }}</h3>
              <p class="text-xs text-slate-500 mb-4 font-mono tabular-nums">{{ doc.size }} • Uploaded {{ doc.uploadedAt }}</p>
              <div class="flex items-center gap-2 text-xs text-slate-500">
                <div class="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-medium text-slate-700 font-mono">
                  {{ doc.authorInitials }}
                </div>
                <span>{{ doc.author }}</span>
              </div>
            </div>
          }
          @if (filteredDocuments().length === 0) {
            <div class="col-span-full py-8 text-center text-slate-500">
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
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h2 id="documentModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">Add Document Entry</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-500 hover:text-slate-700 hover:bg-slate-50 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="docForm" (ngSubmit)="saveDocument()" class="space-y-6">
                <p class="text-xs text-slate-500">This records document metadata only. No file is uploaded.</p>
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

            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveDocument()" [disabled]="!docForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
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
