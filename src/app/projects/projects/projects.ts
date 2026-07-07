import { ChangeDetectionStrategy, Component, inject, signal, computed, DestroyRef } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { toSignal, rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { ApiService, Project, Contract, Resource, Country, City } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

/** Allowed location sentinel for fully-remote projects (mirrors the server + seed). */
const REMOTE_LOCATION = 'Remote';

@Component({
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DatePipe, ReactiveFormsModule, FormsModule, RouterLink, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-section-label">Project Portfolio</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">My Collaborative Projects</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage and track all your ongoing and completed projects.</p>
        </div>
        <button (click)="openCreateForm()" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Project
        </button>
      </div>

      <!-- Search and Filter -->
      <div class="command-card p-4 flex flex-col sm:flex-row gap-4">
        <div class="flex-1 relative">
          <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-[20px] w-[20px] h-[20px]">search</mat-icon>
          <input [formControl]="searchControl" type="text" placeholder="Search projects by name, ID, or location..."
                 aria-label="Search projects"
                 class="w-full pl-10 pr-4 py-3 bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:bg-surface focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
        </div>
      </div>

      <!-- Projects Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        @for (project of filteredProjects(); track project.id) {
          <div class="command-card overflow-hidden group relative flex flex-col h-full">
            <div class="p-6 sm:p-8 flex-1 flex flex-col">
              <div class="flex justify-between items-start mb-4 gap-4">
                <div class="flex-1 min-w-0">
                  <h3 class="font-display text-xl font-bold text-[var(--cc-ink)] mb-1 truncate group-hover:text-accent-text transition-colors">
                    <a [routerLink]="['/projects', project.id]" class="focus:outline-none before:absolute before:inset-0">{{ project.name }}</a>
                  </h3>
                  <p class="text-xs text-accent-text font-mono bg-accent-tint ring-1 ring-accent inline-block px-2 py-0.5 rounded-md">{{ project.id }}</p>
                </div>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide shrink-0 ring-1"
                      [class.bg-accent-tint]="project.status === 'In Planning'"
                      [class.text-accent-text]="project.status === 'In Planning'"
                      [class.ring-accent]="project.status === 'In Planning'"
                      [class.bg-positive-tint]="project.status === 'In Execution'"
                      [class.text-positive-text]="project.status === 'In Execution'"
                      [class.ring-positive]="project.status === 'In Execution'"
                      [class.bg-surface-muted]="project.status === 'Completed'"
                      [class.text-ink-secondary]="project.status === 'Completed'"
                      [class.ring-line]="project.status === 'Completed'">
                  {{ project.status }}
                </span>
              </div>

              <p class="text-sm text-[var(--cc-muted)] mb-6 line-clamp-3 flex-1">{{ project.description || 'No description provided.' }}</p>

              <div class="space-y-3 mt-auto pt-4 border-t border-[var(--cc-line)]">
                <div class="flex items-center gap-3 text-sm text-[var(--cc-muted)] font-medium">
                  <div class="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center text-ink-muted group-hover:bg-accent-tint group-hover:text-accent-text transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                  </div>
                  <span class="truncate">{{ project.location }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm text-[var(--cc-muted)] font-medium">
                  <div class="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center text-ink-muted group-hover:bg-accent-tint group-hover:text-accent-text transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">date_range</mat-icon>
                  </div>
                  <span class="truncate font-mono tabular-nums">{{ project.startDate | date:'mediumDate' }} - {{ project.endDate | date:'mediumDate' }}</span>
                </div>
                <div class="flex items-center gap-3 text-sm text-[var(--cc-muted)] font-medium">
                  <div class="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center text-ink-muted group-hover:bg-accent-tint group-hover:text-accent-text transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">gavel</mat-icon>
                  </div>
                  <span class="truncate">{{ contractName(project.contractId) }}</span>
                </div>
              </div>
            </div>

            <div class="px-6 py-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100 relative z-10">
              <button (click)="editProject(project); $event.stopPropagation()" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-colors" aria-label="Edit project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
              </button>
              <button (click)="deleteProject(project.id); $event.stopPropagation()" class="p-2 text-ink-muted hover:text-critical-text hover:bg-critical-tint rounded-lg transition-colors" aria-label="Delete project">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
              </button>
            </div>
          </div>
        }
        @if (!filteredProjects().length) {
          <div class="col-span-full command-card p-12 text-center border-2 border-dashed">
            <div class="w-20 h-20 bg-[var(--cc-panel-muted)] ring-1 ring-line/5 rounded-full flex items-center justify-center mx-auto mb-4">
              <mat-icon class="text-ink-muted text-4xl">folder_off</mat-icon>
            </div>
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)] mb-2">No projects found</h3>
            <p class="text-[var(--cc-muted)]">Get started by creating a new collaborative project.</p>
          </div>
        }
      </div>
    </div>

    <!-- Create/Edit Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="projectModalTitle" (dismiss)="closeForm()">
        <div class="command-card shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="command-card-header">
            <h2 id="projectModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Project' : 'Create Collaborative Project' }}</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="projectForm" (ngSubmit)="saveProject()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="projectName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project Name *</label>
                  <input id="projectName" type="text" formControlName="name" class="command-input" placeholder="e.g. Project Alpha"
                         [attr.aria-invalid]="projectForm.controls.name.invalid && (projectForm.controls.name.touched || projectForm.controls.name.dirty)"
                         [attr.aria-describedby]="projectForm.controls.name.invalid && (projectForm.controls.name.touched || projectForm.controls.name.dirty) ? 'projectNameError' : null">
                  @if (projectForm.controls.name.invalid && (projectForm.controls.name.touched || projectForm.controls.name.dirty)) {
                    <p id="projectNameError" class="command-field-error" role="alert">Project name is required.</p>
                  }
                </div>

                <div>
                  <label for="projectCountry" class="block text-sm font-semibold text-ink-secondary mb-1.5">Country *</label>
                  <!-- Location = Country + City. Country filters the City list; the stored
                       value is the City NAME ('location'). 'Remote' is a sentinel location. -->
                  <select id="projectCountry" [ngModel]="locationCountry()" (ngModelChange)="onCountryChange($event)" [ngModelOptions]="{ standalone: true }" class="command-select">
                    <option value="" disabled>Select a country...</option>
                    <option value="__REMOTE__">Remote</option>
                    @for (c of countryOptions(); track c.code) {
                      <option [value]="c.code">{{ c.name }}</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="projectLocation" class="block text-sm font-semibold text-ink-secondary mb-1.5">City *</label>
                  @if (locationCountry() === '__REMOTE__') {
                    <input id="projectLocation" type="text" class="command-input" value="Remote (no city)" disabled>
                  } @else {
                    <select id="projectLocation" formControlName="location" class="command-select"
                            [attr.aria-invalid]="projectForm.controls.location.invalid && (projectForm.controls.location.touched || projectForm.controls.location.dirty)"
                            [attr.aria-describedby]="projectForm.controls.location.invalid && (projectForm.controls.location.touched || projectForm.controls.location.dirty) ? 'projectLocationError' : null">
                      <option value="" disabled>{{ locationCountry() ? 'Select a city...' : 'Select a country first' }}</option>
                      @for (city of citiesForCountry(); track city.id) {
                        <option [value]="city.name">{{ city.name }}</option>
                      }
                      @if (orphanCity(); as orphan) {
                        <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                      }
                    </select>
                  }
                  @if (projectForm.controls.location.invalid && (projectForm.controls.location.touched || projectForm.controls.location.dirty)) {
                    <p id="projectLocationError" class="command-field-error" role="alert">Location is required.</p>
                  }
                </div>

                <div>
                  <label for="projectStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                  <input id="projectStartDate" type="date" formControlName="startDate" class="command-input"
                         [attr.aria-invalid]="projectForm.controls.startDate.invalid && (projectForm.controls.startDate.touched || projectForm.controls.startDate.dirty)"
                         [attr.aria-describedby]="projectForm.controls.startDate.invalid && (projectForm.controls.startDate.touched || projectForm.controls.startDate.dirty) ? 'projectStartDateError' : null">
                  @if (projectForm.controls.startDate.invalid && (projectForm.controls.startDate.touched || projectForm.controls.startDate.dirty)) {
                    <p id="projectStartDateError" class="command-field-error" role="alert">Start date is required.</p>
                  }
                </div>

                <div>
                  <label for="projectEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                  <input id="projectEndDate" type="date" formControlName="endDate" class="command-input"
                         [attr.aria-invalid]="projectForm.controls.endDate.invalid && (projectForm.controls.endDate.touched || projectForm.controls.endDate.dirty)"
                         [attr.aria-describedby]="projectForm.controls.endDate.invalid && (projectForm.controls.endDate.touched || projectForm.controls.endDate.dirty) ? 'projectEndDateError' : null">
                  @if (projectForm.controls.endDate.invalid && (projectForm.controls.endDate.touched || projectForm.controls.endDate.dirty)) {
                    <p id="projectEndDateError" class="command-field-error" role="alert">End date is required.</p>
                  }
                </div>

                <div class="sm:col-span-2">
                  <label for="projectStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                  <select id="projectStatus" formControlName="status" class="command-select"
                          [attr.aria-invalid]="projectForm.controls.status.invalid && (projectForm.controls.status.touched || projectForm.controls.status.dirty)"
                          [attr.aria-describedby]="projectForm.controls.status.invalid && (projectForm.controls.status.touched || projectForm.controls.status.dirty) ? 'projectStatusError' : null">
                    <option value="In Planning">In Planning</option>
                    <option value="In Execution">In Execution</option>
                    <option value="Completed">Completed</option>
                    <option value="On Hold">On Hold</option>
                  </select>
                  @if (projectForm.controls.status.invalid && (projectForm.controls.status.touched || projectForm.controls.status.dirty)) {
                    <p id="projectStatusError" class="command-field-error" role="alert">Status is required.</p>
                  }
                </div>

                <div class="sm:col-span-2">
                  <label for="projectOwner" class="block text-sm font-semibold text-ink-secondary mb-1.5">Owner *</label>
                  <!-- The project owner is a PERSON reference. ownerId is an ID field, so the
                       SELECT stores the resource id (label = resource name) bound to the
                       resources (people) catalog. -->
                  <select id="projectOwner" formControlName="ownerId" class="command-select"
                          [attr.aria-invalid]="projectForm.controls.ownerId.invalid && (projectForm.controls.ownerId.touched || projectForm.controls.ownerId.dirty)"
                          [attr.aria-describedby]="projectForm.controls.ownerId.invalid && (projectForm.controls.ownerId.touched || projectForm.controls.ownerId.dirty) ? 'projectOwnerError' : null">
                    <option value="" disabled>Select an owner...</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.id">{{ r.name }}</option>
                    }
                    @if (orphanOwner(); as orphan) {
                      <option [value]="orphan.id" disabled>{{ orphan.label }} (not in catalog)</option>
                    }
                  </select>
                  @if (projectForm.controls.ownerId.invalid && (projectForm.controls.ownerId.touched || projectForm.controls.ownerId.dirty)) {
                    <p id="projectOwnerError" class="command-field-error" role="alert">Owner is required.</p>
                  }
                </div>

                <div class="sm:col-span-2">
                  <label for="projectContract" class="block text-sm font-semibold text-ink-secondary mb-1.5">Contract</label>
                  <select id="projectContract" formControlName="contractId" class="command-select">
                    <option value="">No contract linked</option>
                    @for (contract of contracts(); track contract.id) {
                      <option [value]="contract.id">{{ contract.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="projectDescription" class="block text-sm font-semibold text-ink-secondary mb-1.5">Description</label>
                  <textarea id="projectDescription" formControlName="description" rows="3" class="command-textarea" placeholder="Brief project description..."></textarea>
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="saveProject()" [disabled]="!projectForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              {{ editingId() ? 'Update Project' : 'Create Project' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Delete Confirmation Modal -->
    @if (deletingId()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
           appModal ariaLabelledby="projectDeleteTitle" (dismiss)="cancelDelete()">
        <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-critical-text text-4xl">warning</mat-icon>
            </div>
            <h3 id="projectDeleteTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] mb-2 tracking-tight">Delete Project</h3>
            <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this project? This action cannot be undone.</p>
          </div>
          <div class="p-5 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
            <button (click)="cancelDelete()" class="command-button secondary">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-critical text-white rounded-xl text-sm font-semibold hover:bg-critical-text hover:shadow-lg hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
  `
})
export class ProjectsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  // /contracts is principal-gated in READ_RULES; wait for the restored bearer
  // token before loading it so SSR/deep reloads don't latch ResourceValueError.
  private contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });
  projects = this.projectsRes.value;
  contracts = this.contractsRes.value;
  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  // The project owner is a PERSON reference. ownerId is an ID field, so the SELECT
  // stores the resource id (label = resource name) bound to the resources (people)
  // catalog (Phase D). /resources is a principal-gated read, so key the load on
  // authReady to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  // Location = Country + City (Phase F2). Both catalogs are open reads.
  private countriesRes = rxResource({ stream: () => this.api.getCountries(), defaultValue: [] as Country[] });
  private citiesRes = rxResource({ stream: () => this.api.getCities(), defaultValue: [] as City[] });
  countryOptions = this.countriesRes.value;
  cityOptions = this.citiesRes.value;

  searchControl = new FormControl('');
  searchValue = toSignal(this.searchControl.valueChanges, { initialValue: '' });

  projectForm = new FormGroup({
    name: new FormControl('', Validators.required),
    location: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    status: new FormControl('In Planning', Validators.required),
    ownerId: new FormControl('', Validators.required),
    contractId: new FormControl(''),
    description: new FormControl('')
  });

  // ORPHAN VALUE: a stored ownerId that isn't a current resource id is surfaced as a
  // disabled option (showing the raw id) so editing never silently discards it.
  private ownerIdValue = toSignal(this.projectForm.controls.ownerId.valueChanges, { initialValue: this.projectForm.controls.ownerId.value });
  orphanOwner = computed<{ id: string; label: string } | null>(() => {
    const current = this.ownerIdValue();
    if (!current) return null;
    return this.resourceOptions().some(r => r.id === current) ? null : { id: current, label: current };
  });

  // Location picker state (Phase F2). The form's `location` holds the city NAME (or
  // 'Remote'). The country selection drives the city list; a manual override lets the
  // user change country interactively without losing the initial derive (cities load
  // async after the form opens).
  private locationValue = toSignal(this.projectForm.controls.location.valueChanges, { initialValue: this.projectForm.controls.location.value });
  private countryOverride = signal<string | null>(null);
  locationCountry = computed<string>(() => {
    const override = this.countryOverride();
    if (override !== null) return override;
    const loc = this.locationValue() ?? '';
    if (!loc) return '';
    if (loc === REMOTE_LOCATION) return '__REMOTE__';
    const city = this.cityOptions().find(c => c.name === loc);
    return city ? city.countryCode : '';
  });
  citiesForCountry = computed<City[]>(() => {
    const code = this.locationCountry();
    if (!code || code === '__REMOTE__') return [];
    return this.cityOptions().filter(c => c.countryCode === code);
  });
  orphanCity = computed<string | null>(() => {
    const current = this.locationValue() ?? '';
    if (!current || current === REMOTE_LOCATION) return null;
    return this.cityOptions().some(c => c.name === current) ? null : current;
  });

  /** Country select change: 'Remote' stores the sentinel; otherwise clear the city. */
  onCountryChange(code: string) {
    this.countryOverride.set(code);
    this.projectForm.controls.location.setValue(code === '__REMOTE__' ? REMOTE_LOCATION : '');
    this.projectForm.controls.location.markAsDirty();
  }

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
    this.countryOverride.set(null); // derive the country from the stored location
    this.projectForm.patchValue({
      name: project.name,
      location: project.location,
      startDate: project.startDate,
      endDate: project.endDate,
      status: project.status,
      ownerId: project.ownerId || '',
      contractId: project.contractId || '',
      description: project.description
    });
    this.showForm.set(true);
  }

  saveProject() {
    if (this.projectForm.invalid) return;

    // ownerId is a real resource-id reference chosen in the Owner SELECT (no longer a
    // hardcoded mock id). The required validator guarantees it is set here.
    const projectData = this.projectForm.value as Partial<Project>;

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

  /** Open the create form, defaulting the owner to the signed-in user's resource id. */
  openCreateForm() {
    this.editingId.set(null);
    this.countryOverride.set('');
    this.projectForm.reset({ status: 'In Planning', ownerId: this.auth.userId(), contractId: '', location: '' });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.countryOverride.set('');
    this.projectForm.reset({ status: 'In Planning', ownerId: '', contractId: '', location: '' });
  }
}
