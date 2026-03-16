import { ChangeDetectionStrategy, Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-project-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Documents</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Documents</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">upload_file</mat-icon> Upload Document
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view documents.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          @for (doc of filteredDocuments(); track doc.id) {
            <!-- Document Card -->
            <div class="bg-white rounded-2xl border border-slate-100 p-6 hover:shadow-md transition-shadow cursor-pointer group">
              <div class="flex items-start justify-between mb-4">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center"
                     [class.bg-red-50]="doc.type === 'pdf'" [class.text-red-600]="doc.type === 'pdf'"
                     [class.bg-blue-50]="doc.type === 'word'" [class.text-blue-600]="doc.type === 'word'">
                  <mat-icon>{{ doc.type === 'pdf' ? 'picture_as_pdf' : 'description' }}</mat-icon>
                </div>
                <button class="text-slate-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity">
                  <mat-icon class="text-sm">more_vert</mat-icon>
                </button>
              </div>
              <h3 class="font-medium text-slate-900 mb-1 truncate">{{ doc.name }}</h3>
              <p class="text-xs text-slate-500 mb-4">{{ doc.size }} • Uploaded {{ doc.uploadedAt }}</p>
              <div class="flex items-center gap-2 text-xs text-slate-500">
                <div class="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-medium text-slate-600">
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
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Upload Document</h2>
              <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="docForm" (ngSubmit)="saveDocument()" class="space-y-6">
                <div>
                  <label for="docName" class="block text-sm font-semibold text-slate-700 mb-1.5">Document Name *</label>
                  <input id="docName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Requirements_Spec.docx">
                </div>
                
                <div>
                  <label for="docType" class="block text-sm font-semibold text-slate-700 mb-1.5">Document Type *</label>
                  <select id="docType" formControlName="type" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                    <option value="pdf">PDF</option>
                    <option value="word">Word</option>
                    <option value="excel">Excel</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveDocument()" [disabled]="!docForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Upload
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectDocuments implements OnInit {
  projectId = input<string>();
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  docForm = new FormGroup({
    name: new FormControl('', Validators.required),
    type: new FormControl('pdf', Validators.required)
  });
  
  documents = signal([
    { id: 'D1', projectId: 'P-1001', name: 'Project_Charter_v1.pdf', type: 'pdf', size: '2.4 MB', uploadedAt: '2 days ago', author: 'Jane Doe', authorInitials: 'JD' },
    { id: 'D2', projectId: 'P-1002', name: 'Requirements_Spec.docx', type: 'word', size: '1.1 MB', uploadedAt: '5 days ago', author: 'John Smith', authorInitials: 'JS' }
  ]);

  filteredDocuments = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.documents().filter(d => d.projectId === pId);
  });

  ngOnInit() {
    this.api.getProjects().subscribe(p => this.projects.set(p));
  }

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      alert('Please select a project first.');
      return;
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.docForm.reset({ type: 'pdf' });
  }

  saveDocument() {
    if (this.docForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newDoc = {
      id: 'D' + Math.floor(Math.random() * 10000),
      projectId: pId,
      size: '1.0 MB',
      uploadedAt: 'Just now',
      author: 'Current User',
      authorInitials: 'CU',
      ...this.docForm.value
    } as any;

    this.documents.update(d => [...d, newDoc]);
    this.closeForm();
  }
}
