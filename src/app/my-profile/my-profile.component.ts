import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource, Assignment, ResourceRequest } from '../services/api.service';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { forkJoin } from 'rxjs';

@Component({
  selector: 'app-my-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, CommonModule],
  template: `
    <div class="max-w-5xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">My Project Experience</h1>
        <div class="flex items-center gap-3 bg-white/80 backdrop-blur-md px-5 py-2.5 rounded-2xl shadow-sm border border-slate-200/60 transition-all hover:shadow-md">
          <span class="text-sm font-semibold text-slate-500 uppercase tracking-wider">Average Utilization:</span>
          <span class="text-lg font-bold" [ngClass]="getUtilizationColorText(profile()?.utilization || 0)">
            {{ profile()?.utilization | number:'1.0-0' }}%
          </span>
        </div>
      </div>
      
      @if (profile()) {
        <!-- Profile Details -->
        <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden hover:shadow-md transition-all">
          <div class="p-8 sm:p-10 flex flex-col sm:flex-row items-center sm:items-start gap-6 sm:gap-8 bg-gradient-to-br from-slate-50/50 to-white/50">
            <div class="relative group shrink-0">
              <div class="w-28 h-28 sm:w-32 sm:h-32 bg-gradient-to-br from-indigo-100 to-indigo-50 rounded-full flex items-center justify-center text-indigo-500 text-4xl font-bold overflow-hidden shadow-inner border-4 border-white">
                @if (profile()?.profilePicture) {
                  <img [src]="profile()?.profilePicture" alt="Profile" class="w-full h-full object-cover">
                } @else {
                  {{ profile()?.name?.charAt(0) }}
                }
              </div>
              <label class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 text-white cursor-pointer scale-95 group-hover:scale-100">
                <input type="file" class="hidden" accept="image/*" (change)="onProfilePictureSelected($event)">
                <mat-icon class="text-[28px] w-[28px] h-[28px]">photo_camera</mat-icon>
              </label>
            </div>
            <div class="text-center sm:text-left flex-1">
              <h2 class="text-3xl font-bold text-slate-900 tracking-tight">{{ profile()?.name }}</h2>
              <p class="text-lg font-medium text-indigo-600 mt-1">{{ profile()?.role }}</p>
              <div class="mt-4 flex flex-wrap justify-center sm:justify-start gap-2">
                <span class="inline-flex items-center px-3 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-600 border border-slate-200/60">
                  <mat-icon class="text-[14px] w-[14px] h-[14px] mr-1">business</mat-icon> {{ profile()?.organization }}
                </span>
                <span class="inline-flex items-center px-3 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-600 border border-slate-200/60">
                  <mat-icon class="text-[14px] w-[14px] h-[14px] mr-1">location_on</mat-icon> {{ profile()?.location || 'Remote' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Availability / Utilization -->
        <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden">
          <div class="p-6 sm:p-8 border-b border-slate-100 bg-slate-50/50">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Availability (Next 6 Months)</h3>
          </div>
          <div class="p-6 sm:p-8 overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr class="text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200/60">
                  <th class="pb-4 pr-4">Month</th>
                  <th class="pb-4 px-4">Available (h)</th>
                  <th class="pb-4 px-4">Assigned (h)</th>
                  <th class="pb-4 px-4">Free (h)</th>
                  <th class="pb-4 pl-4">Utilization</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (month of nextSixMonths; track month.name) {
                  <tr class="text-sm text-slate-700 hover:bg-slate-50/80 transition-colors group">
                    <td class="py-4 pr-4 font-bold text-slate-900">{{ month.name }}</td>
                    <td class="py-4 px-4 font-medium">{{ profile()?.capacity! * 4 }}</td>
                    <td class="py-4 px-4 font-medium">{{ getAssignedHoursForMonth(month.index) }}</td>
                    <td class="py-4 px-4 font-medium">{{ (profile()?.capacity! * 4) - getAssignedHoursForMonth(month.index) }}</td>
                    <td class="py-4 pl-4">
                      @let util = ((getAssignedHoursForMonth(month.index) / (profile()?.capacity! * 4)) * 100);
                      <div class="flex items-center gap-3">
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg font-bold text-xs tracking-wide w-16 justify-center" [ngClass]="getUtilizationColorBg(util)">
                          {{ util | number:'1.0-0' }}%
                        </span>
                        <div class="w-24 h-2 bg-slate-100 rounded-full overflow-hidden hidden sm:block">
                          <div class="h-full rounded-full transition-all duration-500" 
                               [ngClass]="getUtilizationColorBg(util).replace('bg-', 'bg-opacity-100 bg-').replace('text-', 'text-opacity-0 text-')"
                               [style.width.%]="util > 100 ? 100 : util"></div>
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Skills -->
        <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden">
          <div class="p-6 sm:p-8 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Skills</h3>
            <button (click)="toggleAddSkill()" class="text-sm font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-xl transition-colors">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Add Skill
            </button>
          </div>
          <div class="p-6 sm:p-8">
            @if (showAddSkill()) {
              <form [formGroup]="skillForm" (ngSubmit)="addSkill()" class="flex flex-col sm:flex-row gap-4 mb-8 p-5 bg-slate-50/80 rounded-2xl border border-slate-200/60 shadow-inner">
                <input formControlName="name" placeholder="Skill name (e.g. Angular)" class="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-sm">
                <select formControlName="level" class="px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-white transition-all font-medium text-sm">
                  <option [value]="1">Beginner (1)</option>
                  <option [value]="2">Intermediate (2)</option>
                  <option [value]="3">Expert (3)</option>
                </select>
                <button type="submit" [disabled]="!skillForm.valid" class="bg-indigo-600 text-white px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
                  Save
                </button>
              </form>
            }
            <div class="flex flex-wrap gap-3">
              @for (skill of profile()?.skills; track skill.name) {
                <div class="group flex items-center gap-2 bg-white border border-slate-200/80 px-4 py-2 rounded-xl shadow-sm hover:shadow-md hover:border-indigo-200 transition-all">
                  <span class="font-bold text-slate-700 text-sm tracking-wide">{{ skill.name }}</span>
                  <div class="flex gap-0.5 ml-2">
                    @for (i of [1, 2, 3]; track i) {
                      <div class="w-2 h-2 rounded-full transition-colors"
                           [class.bg-indigo-500]="i <= skill.level"
                           [class.bg-slate-200]="i > skill.level">
                      </div>
                    }
                  </div>
                  <button (click)="removeSkill(skill.name)" class="ml-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all focus-within:opacity-100">
                    <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
                  </button>
                </div>
              }
              @if (!profile()?.skills?.length) {
                <p class="text-slate-500 italic text-sm">No skills added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- Project Roles -->
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="p-6 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <h3 class="text-lg font-medium text-slate-900">Project Roles</h3>
            <button (click)="toggleAddRole()" class="text-sm font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
              <mat-icon class="text-sm">add</mat-icon> Add
            </button>
          </div>
          <div class="p-6">
            @if (showAddRole()) {
              <div class="flex gap-4 mb-6 p-4 bg-slate-50 rounded-xl border border-slate-100">
                <input [formControl]="roleInput" placeholder="Role name (e.g. Scrum Master)" class="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <button (click)="addRole()" [disabled]="!roleInput.value" class="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50">Save</button>
              </div>
            }
            <div class="flex flex-wrap gap-3">
              @for (role of profile()?.projectRoles; track role) {
                <div class="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg border border-slate-200">
                  <span class="font-medium text-slate-700 text-sm">{{ role }}</span>
                  <button (click)="removeRole(role)" class="text-slate-400 hover:text-red-500 transition-colors ml-1">
                    <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
                  </button>
                </div>
              }
              @if (!profile()?.projectRoles?.length) {
                <p class="text-slate-500 text-sm">No project roles added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- External Work Experience -->
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="p-6 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <h3 class="text-lg font-medium text-slate-900">External Work Experience</h3>
            <button (click)="toggleAddExtExp()" class="text-sm font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
              <mat-icon class="text-sm">add</mat-icon> Add
            </button>
          </div>
          <div class="p-6">
            @if (showAddExtExp()) {
              <form [formGroup]="extExpForm" (ngSubmit)="addExtExp()" class="mb-6 p-5 bg-slate-50 rounded-xl border border-slate-100 space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label for="projectName" class="block text-xs font-medium text-slate-700 mb-1">Project Name *</label>
                    <input id="projectName" formControlName="projectName" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  </div>
                  <div>
                    <label for="company" class="block text-xs font-medium text-slate-700 mb-1">Company *</label>
                    <input id="company" formControlName="company" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  </div>
                  <div>
                    <label for="role" class="block text-xs font-medium text-slate-700 mb-1">Project Role *</label>
                    <input id="role" formControlName="role" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label for="startDate" class="block text-xs font-medium text-slate-700 mb-1">Start Date *</label>
                      <input id="startDate" type="date" formControlName="startDate" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    </div>
                    <div>
                      <label for="endDate" class="block text-xs font-medium text-slate-700 mb-1">End Date *</label>
                      <input id="endDate" type="date" formControlName="endDate" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    </div>
                  </div>
                </div>
                <div>
                  <label for="comment" class="block text-xs font-medium text-slate-700 mb-1">Comment</label>
                  <textarea id="comment" formControlName="comment" rows="2" class="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
                </div>
                <div class="flex justify-end gap-2">
                  <button type="button" (click)="toggleAddExtExp()" class="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors">Cancel</button>
                  <button type="submit" [disabled]="!extExpForm.valid" class="bg-indigo-600 text-white px-4 py-2 text-sm rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50">Save</button>
                </div>
              </form>
            }
            
            <div class="space-y-4">
              @for (exp of profile()?.externalExperience; track exp.projectName) {
                <div class="p-4 rounded-xl border border-slate-100 bg-slate-50 relative group">
                  <button (click)="removeExtExp(exp)" class="absolute top-4 right-4 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                    <mat-icon>delete</mat-icon>
                  </button>
                  <h4 class="font-medium text-slate-900">{{ exp.projectName }}</h4>
                  <p class="text-sm text-slate-600">{{ exp.role }} at {{ exp.company }}</p>
                  <p class="text-xs text-slate-500 mt-1">{{ exp.startDate }} to {{ exp.endDate }}</p>
                  @if (exp.comment) {
                    <p class="text-sm text-slate-700 mt-3 bg-white p-3 rounded-lg border border-slate-100">{{ exp.comment }}</p>
                  }
                </div>
              }
              @if (!profile()?.externalExperience?.length) {
                <p class="text-slate-500 text-sm">No external experience added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- Internal Work Experience (Assignments) -->
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="p-6 border-b border-slate-100 bg-slate-50">
            <h3 class="text-lg font-medium text-slate-900">Internal Work Experience (Assignments)</h3>
          </div>
          <div class="p-6">
            <div class="space-y-3">
              @for (assignment of myAssignments(); track assignment.id) {
                <div class="flex items-center justify-between p-4 rounded-xl border border-slate-100 bg-slate-50">
                  <div>
                    <h4 class="font-medium text-slate-900">{{ getRequestName(assignment.requestId) }}</h4>
                    <p class="text-sm text-slate-500 mt-1">{{ assignment.assignedHours }} hours • <span class="capitalize">{{ assignment.status }}</span></p>
                  </div>
                  <mat-icon class="text-slate-400">chevron_right</mat-icon>
                </div>
              }
              @if (!myAssignments().length) {
                <p class="text-slate-500 text-sm">No internal assignments found.</p>
              }
            </div>
          </div>
        </div>

        <!-- Resume / Attachments -->
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="p-6 border-b border-slate-100 bg-slate-50">
            <h3 class="text-lg font-medium text-slate-900">Resume & Attachments</h3>
          </div>
          <div class="p-6">
            @if (profile()?.resume) {
              <div class="flex items-center justify-between p-4 rounded-xl border border-slate-100 bg-slate-50">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">
                    <mat-icon>description</mat-icon>
                  </div>
                  <div>
                    <h4 class="font-medium text-slate-900">Resume</h4>
                    <p class="text-xs text-slate-500">Uploaded</p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <a [href]="profile()?.resume" download="Resume" class="text-slate-400 hover:text-indigo-600 transition-colors">
                    <mat-icon>download</mat-icon>
                  </a>
                  <button (click)="removeResume()" class="text-slate-400 hover:text-red-500 transition-colors">
                    <mat-icon>delete</mat-icon>
                  </button>
                </div>
              </div>
            } @else {
              <label class="block border-2 border-dashed border-slate-200 rounded-xl p-8 text-center hover:bg-slate-50 transition-colors cursor-pointer">
                <input type="file" class="hidden" accept=".pdf,.doc,.docx" (change)="onResumeSelected($event)">
                <mat-icon class="text-slate-400 mb-2">cloud_upload</mat-icon>
                <p class="text-sm font-medium text-slate-700">Click to upload resume</p>
                <p class="text-xs text-slate-500 mt-1">PDF or DOCX up to 2MB</p>
              </label>
            }
          </div>
        </div>

      }
    </div>
  `
})
export class MyProfileComponent implements OnInit {
  private api = inject(ApiService);
  
  profile = signal<Resource | null>(null);
  myAssignments = signal<Assignment[]>([]);
  allRequests = signal<ResourceRequest[]>([]);

  showAddSkill = signal(false);
  showAddRole = signal(false);
  showAddExtExp = signal(false);

  skillForm = new FormGroup({
    name: new FormControl('', Validators.required),
    level: new FormControl(1, Validators.required)
  });

  roleInput = new FormControl('', Validators.required);

  extExpForm = new FormGroup({
    projectName: new FormControl('', Validators.required),
    company: new FormControl('', Validators.required),
    role: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    comment: new FormControl('')
  });

  nextSixMonths: { name: string, index: number }[] = [];

  ngOnInit() {
    this.generateMonths();
    this.loadData();
  }

  generateMonths() {
    const d = new Date();
    for (let i = 0; i < 6; i++) {
      this.nextSixMonths.push({
        name: d.toLocaleString('default', { month: 'short', year: 'numeric' }),
        index: d.getMonth()
      });
      d.setMonth(d.getMonth() + 1);
    }
  }

  loadData() {
    forkJoin({
      profile: this.api.getResource('1'),
      assignments: this.api.getAssignments(),
      requests: this.api.getRequests()
    }).subscribe(({ profile, assignments, requests }) => {
      this.profile.set(profile);
      this.myAssignments.set(assignments.filter(a => a.resourceId === profile.id));
      this.allRequests.set(requests);
    });
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  getAssignedHoursForMonth(monthIndex: number): number {
    // Mock logic: just distribute total assigned hours evenly across months for demo
    // In reality, assignments would have start/end dates
    const totalAssigned = this.myAssignments().reduce((sum, a) => sum + a.assignedHours, 0);
    return Math.round(totalAssigned / 6) + (monthIndex * 0); 
  }

  getUtilizationColorText(utilization: number): string {
    if (utilization > 110) return 'text-red-600';
    if (utilization >= 80) return 'text-emerald-600';
    return 'text-orange-600';
  }

  getUtilizationColorBg(utilization: number): string {
    if (utilization > 110) return 'bg-red-100 text-red-800';
    if (utilization >= 80) return 'bg-emerald-100 text-emerald-800';
    return 'bg-orange-100 text-orange-800';
  }

  // --- Skills ---
  toggleAddSkill() { this.showAddSkill.update(v => !v); }
  addSkill() {
    if (this.skillForm.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const newSkill = { name: this.skillForm.value.name!, level: Number(this.skillForm.value.level!) };
      const updatedSkills = [...currentProfile.skills, newSkill];
      this.api.updateResource(currentProfile.id, { skills: updatedSkills }).subscribe(res => {
        this.profile.set(res);
        this.skillForm.reset({ level: 1 });
        this.showAddSkill.set(false);
      });
    }
  }
  removeSkill(skillName: string) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedSkills = currentProfile.skills.filter(s => s.name !== skillName);
      this.api.updateResource(currentProfile.id, { skills: updatedSkills }).subscribe(res => this.profile.set(res));
    }
  }

  // --- Roles ---
  toggleAddRole() { this.showAddRole.update(v => !v); }
  addRole() {
    if (this.roleInput.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const updatedRoles = [...(currentProfile.projectRoles || []), this.roleInput.value!];
      this.api.updateResource(currentProfile.id, { projectRoles: updatedRoles }).subscribe(res => {
        this.profile.set(res);
        this.roleInput.reset();
        this.showAddRole.set(false);
      });
    }
  }
  removeRole(roleName: string) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedRoles = currentProfile.projectRoles.filter(r => r !== roleName);
      this.api.updateResource(currentProfile.id, { projectRoles: updatedRoles }).subscribe(res => this.profile.set(res));
    }
  }

  // --- External Experience ---
  toggleAddExtExp() { this.showAddExtExp.update(v => !v); }
  addExtExp() {
    if (this.extExpForm.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const newExp = this.extExpForm.value as { projectName: string; company: string; role: string; startDate: string; endDate: string; comment?: string };
      const updatedExp = [...(currentProfile.externalExperience || []), newExp];
      this.api.updateResource(currentProfile.id, { externalExperience: updatedExp }).subscribe(res => {
        this.profile.set(res);
        this.extExpForm.reset();
        this.showAddExtExp.set(false);
      });
    }
  }
  removeExtExp(exp: { projectName: string }) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedExp = currentProfile.externalExperience.filter(e => e.projectName !== exp.projectName);
      this.api.updateResource(currentProfile.id, { externalExperience: updatedExp }).subscribe(res => this.profile.set(res));
    }
  }

  // --- File Uploads ---
  onProfilePictureSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file && this.profile()) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        this.api.updateResource(this.profile()!.id, { profilePicture: base64 }).subscribe(res => this.profile.set(res));
      };
      reader.readAsDataURL(file);
    }
  }

  onResumeSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file && this.profile()) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        this.api.updateResource(this.profile()!.id, { resume: base64 }).subscribe(res => this.profile.set(res));
      };
      reader.readAsDataURL(file);
    }
  }

  removeResume() {
    if (this.profile()) {
      this.api.updateResource(this.profile()!.id, { resume: '' }).subscribe(res => this.profile.set(res));
    }
  }
}
