import { ChangeDetectionStrategy, Component, signal, computed, input, inject, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';

interface WorkPackage {
  id: string;
  projectId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'Planned' | 'In Progress' | 'Completed';
  progress: number;
  assignee: string;
}

interface Milestone {
  id: string;
  projectId: string;
  name: string;
  date: string;
  status: 'Pending' | 'Achieved';
}

@Component({
  selector: 'app-project-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-8">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <div>
                <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Project Schedule & Plans</h2>
                <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage work packages, scheduling, and key milestones.</p>
              </div>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <div>
                <h2 class="text-xl font-semibold text-slate-900">Project Schedule & Plans</h2>
                <p class="text-sm text-slate-500 mt-1">Manage work packages, scheduling, and key milestones.</p>
              </div>
            }
          </div>
          <div class="flex gap-3">
            <button (click)="openMilestoneForm()" class="bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm flex items-center gap-2">
              <mat-icon class="text-sm">flag</mat-icon> Add Milestone
            </button>
            <button (click)="openWpForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2">
              <mat-icon class="text-sm">add</mat-icon> Add Work Package
            </button>
          </div>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view plans and milestones.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- Work Packages (Main Content) -->
          <div class="lg:col-span-2 space-y-6">
            <h3 class="text-lg font-medium text-slate-900 flex items-center gap-2">
              <mat-icon class="text-indigo-600">account_tree</mat-icon> Work Packages
            </h3>
            
            <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    <th class="py-3 px-4">WBS / Name</th>
                    <th class="py-3 px-4">Timeline</th>
                    <th class="py-3 px-4">Assignee</th>
                    <th class="py-3 px-4">Progress</th>
                    <th class="py-3 px-4 text-right">Actions</th>
                  </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (wp of filteredWorkPackages(); track wp.id) {
                  <tr class="text-sm text-slate-700 hover:bg-slate-50 transition-colors group">
                    <td class="py-4 px-4">
                      <div class="font-medium text-slate-900">{{ wp.name }}</div>
                      <div class="text-xs text-slate-500 font-mono mt-0.5">{{ wp.id }}</div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-1.5 text-slate-600 text-xs">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">calendar_today</mat-icon>
                        {{ wp.startDate | date:'MMM d' }} - {{ wp.endDate | date:'MMM d' }}
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-2">
                        <div class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                          {{ wp.assignee.charAt(0) }}
                        </div>
                        <span class="text-xs font-medium">{{ wp.assignee }}</span>
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-3">
                        <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div class="h-full rounded-full transition-all duration-500"
                               [class.bg-emerald-500]="wp.progress === 100"
                               [class.bg-indigo-500]="wp.progress > 0 && wp.progress < 100"
                               [class.bg-slate-300]="wp.progress === 0"
                               [style.width.%]="wp.progress"></div>
                        </div>
                        <span class="text-xs font-medium w-8 text-right">{{ wp.progress }}%</span>
                      </div>
                    </td>
                    <td class="py-4 px-4 text-right">
                      <button class="text-slate-400 hover:text-indigo-600 transition-colors opacity-0 group-hover:opacity-100">
                        <mat-icon class="text-sm">edit</mat-icon>
                      </button>
                    </td>
                  </tr>
                }
                @if (filteredWorkPackages().length === 0) {
                  <tr>
                    <td colspan="5" class="px-6 py-8 text-center text-slate-500">No work packages found for this project.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Milestones (Sidebar) -->
        <div class="space-y-6">
          <h3 class="text-lg font-medium text-slate-900 flex items-center gap-2">
            <mat-icon class="text-amber-500">emoji_events</mat-icon> Key Milestones
          </h3>

          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div class="relative border-l-2 border-slate-100 ml-3 space-y-8">
              @for (milestone of filteredMilestones(); track milestone.id; let last = $last) {
                <div class="relative pl-6">
                  <!-- Timeline Dot -->
                  <div class="absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center"
                       [class.bg-emerald-500]="milestone.status === 'Achieved'"
                       [class.bg-slate-300]="milestone.status === 'Pending'">
                    @if (milestone.status === 'Achieved') {
                      <mat-icon class="text-white text-[10px] w-[10px] h-[10px]">check</mat-icon>
                    }
                  </div>
                  
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <h4 class="text-sm font-semibold text-slate-900" [class.line-through]="milestone.status === 'Achieved'">
                        {{ milestone.name }}
                      </h4>
                      <span class="text-xs font-medium px-2 py-0.5 rounded-full"
                            [class.bg-emerald-50]="milestone.status === 'Achieved'"
                            [class.text-emerald-700]="milestone.status === 'Achieved'"
                            [class.bg-slate-100]="milestone.status === 'Pending'"
                            [class.text-slate-600]="milestone.status === 'Pending'">
                        {{ milestone.status }}
                      </span>
                    </div>
                    <div class="flex items-center gap-1.5 text-xs text-slate-500">
                      <mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon>
                      {{ milestone.date | date:'mediumDate' }}
                    </div>
                  </div>
                </div>
              }
              @if (filteredMilestones().length === 0) {
                <div class="pl-6 text-sm text-slate-500">No milestones found.</div>
              }
            </div>
          </div>
          
          <!-- Quick Summary -->
          <div class="bg-indigo-50 rounded-2xl p-6 border border-indigo-100">
            <h4 class="text-sm font-semibold text-indigo-900 mb-4">Schedule Summary</h4>
            <div class="space-y-3">
              <div class="flex justify-between text-sm">
                <span class="text-indigo-700">Total Work Packages</span>
                <span class="font-medium text-indigo-900">{{ filteredWorkPackages().length }}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-indigo-700">Completed</span>
                <span class="font-medium text-indigo-900">
                  {{ completedWorkPackagesCount() }}
                </span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-indigo-700">Milestones Achieved</span>
                <span class="font-medium text-indigo-900">
                  {{ achievedMilestonesCount() }} / {{ filteredMilestones().length }}
                </span>
              </div>
            </div>
          </div>
        </div>
        </div>
        }
      </div>

      <!-- Add Milestone Modal -->
      @if (showMilestoneForm()) {
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Add Milestone</h2>
              <button (click)="closeMilestoneForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="milestoneForm" (ngSubmit)="saveMilestone()" class="space-y-6">
                <div>
                  <label for="milestoneName" class="block text-sm font-semibold text-slate-700 mb-1.5">Milestone Name *</label>
                  <input id="milestoneName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Phase 1 Completion">
                </div>
                
                <div>
                  <label for="milestoneDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Date *</label>
                  <input id="milestoneDate" type="date" formControlName="date" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
              <button type="button" (click)="closeMilestoneForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveMilestone()" [disabled]="!milestoneForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Add Work Package Modal -->
      @if (showWpForm()) {
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Add Work Package</h2>
              <button (click)="closeWpForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="wpForm" (ngSubmit)="saveWp()" class="space-y-6">
                <div>
                  <label for="wpName" class="block text-sm font-semibold text-slate-700 mb-1.5">Work Package Name *</label>
                  <input id="wpName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Requirements Analysis">
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="wpStartDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Start Date *</label>
                    <input id="wpStartDate" type="date" formControlName="startDate" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                  </div>
                  <div>
                    <label for="wpEndDate" class="block text-sm font-semibold text-slate-700 mb-1.5">End Date *</label>
                    <input id="wpEndDate" type="date" formControlName="endDate" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                  </div>
                </div>

                <div>
                  <label for="wpAssignee" class="block text-sm font-semibold text-slate-700 mb-1.5">Assignee *</label>
                  <input id="wpAssignee" type="text" formControlName="assignee" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. John Doe">
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
              <button type="button" (click)="closeWpForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveWp()" [disabled]="!wpForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Save
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectPlans implements OnInit {
  projectId = input<string>();
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  selectedProjectId = signal<string>('');

  showMilestoneForm = signal(false);
  showWpForm = signal(false);

  milestoneForm = new FormGroup({
    name: new FormControl('', Validators.required),
    date: new FormControl('', Validators.required)
  });

  wpForm = new FormGroup({
    name: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    assignee: new FormControl('', Validators.required)
  });

  workPackages = signal<WorkPackage[]>([
    { id: 'WP-1.1', projectId: 'P-1001', name: 'Requirements Analysis', startDate: '2023-10-01', endDate: '2023-10-15', status: 'Completed', progress: 100, assignee: 'Alice Smith' },
    { id: 'WP-1.2', projectId: 'P-1001', name: 'System Architecture Design', startDate: '2023-10-16', endDate: '2023-11-05', status: 'Completed', progress: 100, assignee: 'Bob Jones' },
    { id: 'WP-2.1', projectId: 'P-1002', name: 'Frontend Development', startDate: '2023-11-06', endDate: '2023-12-20', status: 'In Progress', progress: 65, assignee: 'Charlie Brown' },
    { id: 'WP-2.2', projectId: 'P-1002', name: 'Backend API Implementation', startDate: '2023-11-06', endDate: '2023-12-15', status: 'In Progress', progress: 80, assignee: 'Diana Prince' },
    { id: 'WP-3.1', projectId: 'P-1001', name: 'Integration Testing', startDate: '2023-12-21', endDate: '2024-01-15', status: 'Planned', progress: 0, assignee: 'Eve Davis' },
    { id: 'WP-4.1', projectId: 'P-1002', name: 'User Acceptance Testing (UAT)', startDate: '2024-01-16', endDate: '2024-01-31', status: 'Planned', progress: 0, assignee: 'Alice Smith' },
  ]);

  milestones = signal<Milestone[]>([
    { id: 'M1', projectId: 'P-1001', name: 'Project Kickoff', date: '2023-10-01', status: 'Achieved' },
    { id: 'M2', projectId: 'P-1001', name: 'Requirements Signed Off', date: '2023-10-15', status: 'Achieved' },
    { id: 'M3', projectId: 'P-1002', name: 'Architecture Approved', date: '2023-11-05', status: 'Achieved' },
    { id: 'M4', projectId: 'P-1002', name: 'Development Complete', date: '2023-12-20', status: 'Pending' },
    { id: 'M5', projectId: 'P-1001', name: 'Go-Live', date: '2024-02-01', status: 'Pending' },
  ]);

  filteredWorkPackages = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.workPackages().filter(wp => wp.projectId === pId);
  });

  filteredMilestones = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.milestones().filter(m => m.projectId === pId);
  });

  completedWorkPackagesCount = computed(() => this.filteredWorkPackages().filter(wp => wp.status === 'Completed').length);
  achievedMilestonesCount = computed(() => this.filteredMilestones().filter(m => m.status === 'Achieved').length);

  ngOnInit() {
    this.api.getProjects().subscribe(p => this.projects.set(p));
  }

  openMilestoneForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      alert('Please select a project first.');
      return;
    }
    this.showMilestoneForm.set(true);
  }

  closeMilestoneForm() {
    this.showMilestoneForm.set(false);
    this.milestoneForm.reset();
  }

  saveMilestone() {
    if (this.milestoneForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newMilestone: Milestone = {
      id: 'M' + Math.floor(Math.random() * 10000),
      projectId: pId,
      status: 'Pending',
      ...this.milestoneForm.value
    } as any;

    this.milestones.update(m => [...m, newMilestone]);
    this.closeMilestoneForm();
  }

  openWpForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      alert('Please select a project first.');
      return;
    }
    this.showWpForm.set(true);
  }

  closeWpForm() {
    this.showWpForm.set(false);
    this.wpForm.reset();
  }

  saveWp() {
    if (this.wpForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newWp: WorkPackage = {
      id: 'WP' + Math.floor(Math.random() * 10000),
      projectId: pId,
      status: 'Planned',
      progress: 0,
      ...this.wpForm.value
    } as any;

    this.workPackages.update(wp => [...wp, newWp]);
    this.closeWpForm();
  }
}
