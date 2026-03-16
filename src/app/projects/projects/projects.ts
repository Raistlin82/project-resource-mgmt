import { ChangeDetectionStrategy, Component, inject, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, ReactiveFormsModule, RouterLink],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">My Collaborative Projects</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage and track all your ongoing and completed projects.</p>
        </div>
        <button (click)="showForm.set(true)" class="bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 shadow-sm w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Project
        </button>
      </div>

      <!-- Search and Filter -->
      <div class="bg-white/80 backdrop-blur-md p-4 rounded-2xl shadow-sm border border-slate-200/60 flex flex-col sm:flex-row gap-4">
        <div class="flex-1 relative">
          <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[20px] w-[20px] h-[20px]">search</mat-icon>
          <input [formControl]="searchControl" type="text" placeholder="Search projects by name, ID, or location..." 
                 class="w-full pl-10 pr-4 py-3 bg-slate-50/50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all outline-none">
        </div>
      </div>

      <!-- Projects Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        @for (project of filteredProjects(); track project.id) {
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden hover:shadow-xl hover:border-indigo-100 transition-all duration-300 group relative flex flex-col h-full">
            <div class="p-6 sm:p-8 flex-1 flex flex-col">
              <div class="flex justify-between items-start mb-4 gap-4">
                <div class="flex-1 min-w-0">
                  <h3 class="text-xl font-bold text-slate-900 mb-1 truncate group-hover:text-indigo-600 transition-colors">
                    <a [routerLink]="['/projects', project.id]" class="focus:outline-none before:absolute before:inset-0">{{ project.name }}</a>
                  </h3>
                  <p class="text-xs text-slate-500 font-mono bg-slate-100 inline-block px-2 py-0.5 rounded-md">{{ project.id }}</p>
                </div>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide shrink-0"
                      [class.bg-blue-100]="project.status === 'In Planning'"
                      [class.text-blue-800]="project.status === 'In Planning'"
                      [class.bg-emerald-100]="project.status === 'In Execution'"
                      [class.text-emerald-800]="project.status === 'In Execution'"
                      [class.bg-slate-100]="project.status === 'Completed'"
                      [class.text-slate-800]="project.status === 'Completed'">
                  {{ project.status }}
                </span>
              </div>
              
              <p class="text-sm text-slate-600 mb-6 line-clamp-3 flex-1">{{ project.description || 'No description provided.' }}</p>
              
              <div class="space-y-3 mt-auto pt-4 border-t border-slate-100">
                <div class="flex items-center gap-3 text-sm text-slate-600 font-medium">
                  <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500 transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                  </div>
                  <span class="truncate">{{ project.location }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-600 font-medium">
                  <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500 transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">date_range</mat-icon>
                  </div>
                  <span class="truncate">{{ project.startDate | date:'mediumDate' }} - {{ project.endDate | date:'mediumDate' }}</span>
                </div>
              </div>
            </div>
            
            <div class="px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100 relative z-10">
              <button (click)="editProject(project); $event.stopPropagation()" class="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" aria-label="Edit project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
              </button>
              <button (click)="deleteProject(project.id); $event.stopPropagation()" class="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" aria-label="Delete project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
              </button>
            </div>
          </div>
        }
        @if (!filteredProjects().length) {
          <div class="col-span-full p-12 text-center bg-white/50 backdrop-blur-sm rounded-3xl border-2 border-slate-200 border-dashed">
            <div class="w-20 h-20 bg-white shadow-sm rounded-full flex items-center justify-center mx-auto mb-4">
              <mat-icon class="text-slate-300 text-4xl">folder_off</mat-icon>
            </div>
            <h3 class="text-xl font-bold text-slate-900 mb-2">No projects found</h3>
            <p class="text-slate-500">Get started by creating a new collaborative project.</p>
          </div>
        }
      </div>
    </div>

    <!-- Create/Edit Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
            <h2 class="text-2xl font-bold text-slate-900 tracking-tight">{{ editingId() ? 'Edit Project' : 'Create Collaborative Project' }}</h2>
            <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          
          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="projectForm" (ngSubmit)="saveProject()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="projectName" class="block text-sm font-semibold text-slate-700 mb-1.5">Project Name *</label>
                  <input id="projectName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Project Alpha">
                </div>
                
                <div class="sm:col-span-2">
                  <label for="projectLocation" class="block text-sm font-semibold text-slate-700 mb-1.5">Location *</label>
                  <input id="projectLocation" type="text" formControlName="location" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. New York, NY">
                </div>

                <div>
                  <label for="projectStartDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Start Date *</label>
                  <input id="projectStartDate" type="date" formControlName="startDate" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                </div>

                <div>
                  <label for="projectEndDate" class="block text-sm font-semibold text-slate-700 mb-1.5">End Date *</label>
                  <input id="projectEndDate" type="date" formControlName="endDate" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                </div>
                
                <div class="sm:col-span-2">
                  <label for="projectStatus" class="block text-sm font-semibold text-slate-700 mb-1.5">Status *</label>
                  <select id="projectStatus" formControlName="status" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                    <option value="In Planning">In Planning</option>
                    <option value="In Execution">In Execution</option>
                    <option value="Completed">Completed</option>
                    <option value="On Hold">On Hold</option>
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="projectDescription" class="block text-sm font-semibold text-slate-700 mb-1.5">Description</label>
                  <textarea id="projectDescription" formControlName="description" rows="3" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white resize-none" placeholder="Brief project description..."></textarea>
                </div>
              </div>
            </form>
          </div>
          
          <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="saveProject()" [disabled]="!projectForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
              {{ editingId() ? 'Update Project' : 'Create Project' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Delete Confirmation Modal -->
    @if (deletingId()) {
      <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-red-500 text-4xl">warning</mat-icon>
            </div>
            <h3 class="text-2xl font-bold text-slate-900 mb-2 tracking-tight">Delete Project</h3>
            <p class="text-slate-500 text-sm">Are you sure you want to delete this project? This action cannot be undone.</p>
          </div>
          <div class="p-5 bg-slate-50/80 backdrop-blur-sm border-t border-slate-100 flex justify-end gap-3">
            <button (click)="cancelDelete()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 hover:shadow-lg hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
  `
})
export class ProjectsComponent implements OnInit {
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  searchControl = new FormControl('');
  searchValue = signal('');

  projectForm = new FormGroup({
    name: new FormControl('', Validators.required),
    location: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    status: new FormControl('In Planning', Validators.required),
    description: new FormControl('')
  });

  filteredProjects = computed(() => {
    const search = this.searchValue().toLowerCase();
    return this.projects().filter(p => {
      if (!search) return true;
      return p.name.toLowerCase().includes(search) || 
             p.id.toLowerCase().includes(search) ||
             p.location.toLowerCase().includes(search);
    });
  });

  ngOnInit() {
    this.loadProjects();
    this.searchControl.valueChanges.subscribe(val => {
      this.searchValue.set(val || '');
    });
  }

  loadProjects() {
    this.api.getProjects().subscribe(data => this.projects.set(data));
  }

  editProject(project: Project) {
    this.editingId.set(project.id);
    this.projectForm.patchValue({
      name: project.name,
      location: project.location,
      startDate: project.startDate,
      endDate: project.endDate,
      status: project.status,
      description: project.description
    });
    this.showForm.set(true);
  }

  saveProject() {
    if (this.projectForm.invalid) return;
    
    const projectData = this.projectForm.value as Partial<Project>;
    projectData.ownerId = '1'; // Mock current user

    if (this.editingId()) {
      this.api.updateProject(this.editingId()!, projectData).subscribe(() => {
        this.loadProjects();
        this.closeForm();
      });
    } else {
      this.api.createProject(projectData).subscribe(() => {
        this.loadProjects();
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
      this.api.deleteProject(id).subscribe(() => {
        this.loadProjects();
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
    this.projectForm.reset({ status: 'In Planning' });
  }
}
