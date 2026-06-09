import { ChangeDetectionStrategy, Component, inject, signal, computed, DestroyRef } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { toSignal, rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { ApiService, Project, Contract } from '../../services/api.service';

@Component({
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DatePipe, ReactiveFormsModule, RouterLink],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">My Collaborative Projects</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage and track all your ongoing and completed projects.</p>
        </div>
        <button (click)="showForm.set(true)" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-xl text-sm hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 shadow-sm w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Project
        </button>
      </div>

      <!-- Search and Filter -->
      <div class="bg-white p-4 rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 flex flex-col sm:flex-row gap-4">
        <div class="flex-1 relative">
          <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[20px] w-[20px] h-[20px]">search</mat-icon>
          <input [formControl]="searchControl" type="text" placeholder="Search projects by name, ID, or location..."
                 class="w-full pl-10 pr-4 py-3 bg-white border border-slate-300 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 transition-all outline-none">
        </div>
      </div>

      <!-- Projects Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        @for (project of filteredProjects(); track project.id) {
          <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md hover:border-blue-200 transition-all duration-300 group relative flex flex-col h-full">
            <div class="p-6 sm:p-8 flex-1 flex flex-col">
              <div class="flex justify-between items-start mb-4 gap-4">
                <div class="flex-1 min-w-0">
                  <h3 class="text-xl font-bold text-slate-900 mb-1 truncate group-hover:text-blue-700 transition-colors">
                    <a [routerLink]="['/projects', project.id]" class="focus:outline-none before:absolute before:inset-0">{{ project.name }}</a>
                  </h3>
                  <p class="text-xs text-blue-700 font-mono bg-blue-50 ring-1 ring-blue-200 inline-block px-2 py-0.5 rounded-md">{{ project.id }}</p>
                </div>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide shrink-0 ring-1"
                      [class.bg-blue-50]="project.status === 'In Planning'"
                      [class.text-blue-700]="project.status === 'In Planning'"
                      [class.ring-blue-200]="project.status === 'In Planning'"
                      [class.bg-emerald-50]="project.status === 'In Execution'"
                      [class.text-emerald-700]="project.status === 'In Execution'"
                      [class.ring-emerald-200]="project.status === 'In Execution'"
                      [class.bg-slate-100]="project.status === 'Completed'"
                      [class.text-slate-700]="project.status === 'Completed'"
                      [class.ring-slate-200]="project.status === 'Completed'">
                  {{ project.status }}
                </span>
              </div>

              <p class="text-sm text-slate-600 mb-6 line-clamp-3 flex-1">{{ project.description || 'No description provided.' }}</p>

              <div class="space-y-3 mt-auto pt-4 border-t border-slate-200">
                <div class="flex items-center gap-3 text-sm text-slate-600 font-medium">
                  <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-700 transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                  </div>
                  <span class="truncate">{{ project.location }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-600 font-medium">
                  <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-700 transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">date_range</mat-icon>
                  </div>
                  <span class="truncate font-mono tabular-nums">{{ project.startDate | date:'mediumDate' }} - {{ project.endDate | date:'mediumDate' }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-600 font-medium">
                  <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-700 transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">gavel</mat-icon>
                  </div>
                  <span class="truncate">{{ contractName(project.contractId) }}</span>
                </div>
              </div>
            </div>

            <div class="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100 relative z-10">
              <button (click)="editProject(project); $event.stopPropagation()" class="p-2 text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors" aria-label="Edit project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
              </button>
              <button (click)="deleteProject(project.id); $event.stopPropagation()" class="p-2 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors" aria-label="Delete project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
              </button>
            </div>
          </div>
        }
        @if (!filteredProjects().length) {
          <div class="col-span-full p-12 text-center bg-white rounded-3xl ring-1 ring-slate-900/5 border-2 border-slate-200 border-dashed">
            <div class="w-20 h-20 bg-slate-50 ring-1 ring-slate-900/5 rounded-full flex items-center justify-center mx-auto mb-4">
              <mat-icon class="text-slate-400 text-4xl">folder_off</mat-icon>
            </div>
            <h3 class="text-xl font-bold text-slate-900 mb-2">No projects found</h3>
            <p class="text-slate-500">Get started by creating a new collaborative project.</p>
          </div>
        }
      </div>
    </div>

    <!-- Create/Edit Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
            <h2 class="text-2xl font-bold text-slate-900 tracking-tight">{{ editingId() ? 'Edit Project' : 'Create Collaborative Project' }}</h2>
            <button (click)="closeForm()" class="text-slate-500 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="projectForm" (ngSubmit)="saveProject()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="projectName" class="block text-sm font-semibold text-slate-700 mb-1.5">Project Name *</label>
                  <input id="projectName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Project Alpha">
                </div>

                <div class="sm:col-span-2">
                  <label for="projectLocation" class="block text-sm font-semibold text-slate-700 mb-1.5">Location *</label>
                  <input id="projectLocation" type="text" formControlName="location" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. New York, NY">
                </div>

                <div>
                  <label for="projectStartDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Start Date *</label>
                  <input id="projectStartDate" type="date" formControlName="startDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white">
                </div>

                <div>
                  <label for="projectEndDate" class="block text-sm font-semibold text-slate-700 mb-1.5">End Date *</label>
                  <input id="projectEndDate" type="date" formControlName="endDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white">
                </div>

                <div class="sm:col-span-2">
                  <label for="projectStatus" class="block text-sm font-semibold text-slate-700 mb-1.5">Status *</label>
                  <select id="projectStatus" formControlName="status" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                    <option value="In Planning">In Planning</option>
                    <option value="In Execution">In Execution</option>
                    <option value="Completed">Completed</option>
                    <option value="On Hold">On Hold</option>
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="projectContract" class="block text-sm font-semibold text-slate-700 mb-1.5">Contract</label>
                  <select id="projectContract" formControlName="contractId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                    <option value="">No contract linked</option>
                    @for (contract of contracts(); track contract.id) {
                      <option [value]="contract.id">{{ contract.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="projectDescription" class="block text-sm font-semibold text-slate-700 mb-1.5">Description</label>
                  <textarea id="projectDescription" formControlName="description" rows="3" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white resize-none" placeholder="Brief project description..."></textarea>
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="saveProject()" [disabled]="!projectForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold hover:-translate-y-0.5 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
              {{ editingId() ? 'Update Project' : 'Create Project' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Delete Confirmation Modal -->
    @if (deletingId()) {
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-red-50 ring-1 ring-red-200 rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-red-700 text-4xl">warning</mat-icon>
            </div>
            <h3 class="text-2xl font-bold text-slate-900 mb-2 tracking-tight">Delete Project</h3>
            <p class="text-slate-500 text-sm">Are you sure you want to delete this project? This action cannot be undone.</p>
          </div>
          <div class="p-5 bg-slate-50 border-t border-slate-200 flex justify-end gap-3">
            <button (click)="cancelDelete()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 hover:shadow-lg hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
  `
})
export class ProjectsComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private contractsRes = rxResource({ stream: () => this.api.getContracts(), defaultValue: [] as Contract[] });
  projects = this.projectsRes.value;
  contracts = this.contractsRes.value;
  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  searchControl = new FormControl('');
  searchValue = toSignal(this.searchControl.valueChanges, { initialValue: '' });

  projectForm = new FormGroup({
    name: new FormControl('', Validators.required),
    location: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    status: new FormControl('In Planning', Validators.required),
    contractId: new FormControl(''),
    description: new FormControl('')
  });

  filteredProjects = computed(() => {
    const search = (this.searchValue() ?? '').toLowerCase();
    return this.projects().filter(p => {
      if (!search) return true;
      return p.name.toLowerCase().includes(search) || 
             p.id.toLowerCase().includes(search) ||
             p.location.toLowerCase().includes(search);
    });
  });

  private contractsById = computed(() => new Map(this.contracts().map(c => [c.id, c.name])));

  contractName(id: string | undefined): string {
    return id ? (this.contractsById().get(id) ?? id) : 'No contract linked';
  }

  editProject(project: Project) {
    this.editingId.set(project.id);
    this.projectForm.patchValue({
      name: project.name,
      location: project.location,
      startDate: project.startDate,
      endDate: project.endDate,
      status: project.status,
      contractId: project.contractId || '',
      description: project.description
    });
    this.showForm.set(true);
  }

  saveProject() {
    if (this.projectForm.invalid) return;
    
    const projectData = this.projectForm.value as Partial<Project>;
    projectData.ownerId = '1'; // Mock current user

    if (this.editingId()) {
      this.api.updateProject(this.editingId()!, projectData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.projectsRes.reload();
          this.closeForm();
        });
    } else {
      this.api.createProject(projectData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.projectsRes.reload();
          this.closeForm();
        });
    }
  }

  deleteProject(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteProject(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.projectsRes.reload();
          this.deletingId.set(null);
        });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.projectForm.reset({ status: 'In Planning', contractId: '' });
  }
}
