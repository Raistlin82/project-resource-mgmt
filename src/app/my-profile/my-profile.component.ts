import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource, Assignment, ResourceRequest, ProjectRole, Skill, ProficiencySet } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { NotificationService } from '../services/notification.service';
import { forkJoin, of } from 'rxjs';

@Component({
  selector: 'app-my-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, DecimalPipe],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">My Project Experience</h1>
        <div class="command-card flex items-center gap-3 px-5 py-2.5">
          <span class="text-sm font-semibold text-[var(--cc-muted)] uppercase tracking-wider">Average Utilization:</span>
          <span class="text-lg font-bold font-mono tabular-nums" [class]="getUtilizationColorText(profile()?.utilization || 0)">
            {{ profile()?.utilization | number:'1.0-0' }}%
          </span>
        </div>
      </div>

      @if (profile()) {
        <!-- Profile Details -->
        <div class="command-card overflow-hidden">
          <div class="p-8 sm:p-10 flex flex-col sm:flex-row items-center sm:items-start gap-6 sm:gap-8 bg-gradient-to-br from-surface-muted to-transparent">
            <div class="relative group shrink-0">
              <div class="w-28 h-28 sm:w-32 sm:h-32 bg-gradient-to-br from-accent to-accent rounded-full flex items-center justify-center text-white text-4xl font-bold overflow-hidden shadow-inner border-4 border-line">
                @if (profile()?.profilePicture) {
                  <img [src]="profile()?.profilePicture" alt="Profile" class="w-full h-full object-cover">
                } @else {
                  {{ profile()?.name?.charAt(0) }}
                }
              </div>
              <label class="absolute inset-0 bg-ink/40 backdrop-blur-sm rounded-full flex items-center justify-center opacity-100 transition-all duration-300 text-white cursor-pointer scale-100 sm:opacity-0 sm:scale-95 sm:group-hover:opacity-100 sm:group-hover:scale-100 sm:group-focus-within:opacity-100 sm:group-focus-within:scale-100" aria-label="Upload profile picture">
                <input type="file" class="sr-only" accept="image/*" aria-label="Upload profile picture" (change)="onProfilePictureSelected($event)">
                <mat-icon class="text-[28px] w-[28px] h-[28px]">photo_camera</mat-icon>
              </label>
            </div>
            <div class="text-center sm:text-left flex-1">
              <h2 class="font-display text-3xl font-bold text-[var(--cc-ink)] tracking-tight">{{ profile()?.name }}</h2>
              <p class="text-lg font-medium text-[var(--cc-primary-text)] mt-1">{{ profile()?.role }}</p>
              <div class="mt-4 flex flex-wrap justify-center sm:justify-start gap-2">
                <span class="inline-flex items-center px-3 py-1 rounded-lg text-xs font-bold tracking-wide bg-surface-muted text-ink-secondary border border-line">
                  <mat-icon class="text-[14px] w-[14px] h-[14px] mr-1">business</mat-icon> {{ profile()?.organization }}
                </span>
                <span class="inline-flex items-center px-3 py-1 rounded-lg text-xs font-bold tracking-wide bg-surface-muted text-ink-secondary border border-line">
                  <mat-icon class="text-[14px] w-[14px] h-[14px] mr-1">location_on</mat-icon> {{ profile()?.location || 'Remote' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Availability / Utilization -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Availability (Next 6 Months)</h3>
          </div>
          <div class="p-6 sm:p-8 overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr class="text-xs font-semibold text-ink-muted uppercase tracking-wider border-b border-line">
                  <th class="pb-4 pr-4">Month</th>
                  <th class="pb-4 px-4">Available (h)</th>
                  <th class="pb-4 px-4">Assigned (h)</th>
                  <th class="pb-4 px-4">Free (h)</th>
                  <th class="pb-4 pl-4">Utilization</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (month of nextSixMonths; track month.name) {
                  <tr class="text-sm text-ink-secondary hover:bg-surface-muted transition-colors group">
                    <td class="py-4 pr-4 font-bold text-[var(--cc-ink)]">{{ month.name }}</td>
                    <td class="py-4 px-4 font-medium font-mono tabular-nums">{{ profile()?.capacity! * 4 }}</td>
                    <td class="py-4 px-4 font-medium font-mono tabular-nums">{{ getAssignedHoursForMonth() }}</td>
                    <td class="py-4 px-4 font-medium font-mono tabular-nums">{{ (profile()?.capacity! * 4) - getAssignedHoursForMonth() }}</td>
                    <td class="py-4 pl-4">
                      @let util = ((getAssignedHoursForMonth() / (profile()?.capacity! * 4)) * 100);
                      <div class="flex items-center gap-3">
                        <span class="command-status w-16 justify-center" [class]="getUtilizationColorBg(util)">
                          {{ util | number:'1.0-0' }}%
                        </span>
                        <div class="w-24 h-2 bg-surface-muted rounded-full overflow-hidden hidden sm:block">
                          <div class="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-accent to-accent"
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
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Skills</h3>
            <button (click)="toggleAddSkill()" class="command-button secondary">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Add Skill
            </button>
          </div>
          <div class="p-6 sm:p-8">
            @if (showAddSkill()) {
              <form [formGroup]="skillForm" (ngSubmit)="addSkill()" class="command-card-muted flex flex-col sm:flex-row gap-4 mb-8 p-5">
                <!-- Skill NAME is a catalog value, never free text: select from /skills
                     (stored value = skill name). Skills already on the profile are filtered
                     out so they can't be added twice. -->
                <select formControlName="name" class="command-select flex-1" aria-label="Skill to add">
                  <option value="" disabled>Select a skill...</option>
                  @for (skill of addableSkillOptions(); track skill.id) {
                    <option [value]="skill.name">{{ skill.name }}</option>
                  }
                </select>
                <!-- Skill LEVEL is bound to the proficiency-set levels (label = level name
                     e.g. Beginner/Intermediate/Advanced/Expert, value = level number), not a
                     hardcoded 1/2/3 list. -->
                <select formControlName="level" class="command-select w-auto" aria-label="Skill proficiency level">
                  <option [ngValue]="null" disabled>Select a level...</option>
                  @for (lvl of levelOptions(); track lvl.level) {
                    <option [ngValue]="lvl.level">{{ lvl.name }} ({{ lvl.level }})</option>
                  }
                </select>
                <button type="submit" [disabled]="!skillForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  Save
                </button>
              </form>
            }
            <div class="flex flex-wrap gap-3">
              @for (skill of profile()?.skills; track skill.name) {
                <div class="command-card group flex items-center gap-2 px-4 py-2 hover:shadow-md transition-all">
                  <span class="font-bold text-ink-secondary text-sm tracking-wide">{{ skill.name }}</span>
                  <div class="flex gap-0.5 ml-2">
                    @for (i of [1, 2, 3]; track i) {
                      <div class="w-2 h-2 rounded-full transition-colors"
                           [class.bg-accent]="i <= skill.level"
                           [class.bg-surface-muted]="i > skill.level">
                      </div>
                    }
                  </div>
                  <button type="button" (click)="removeSkill(skill.name)" [attr.aria-label]="'Remove ' + skill.name" [attr.title]="'Remove ' + skill.name" class="ml-2 text-ink-muted hover:text-critical-text opacity-100 transition-all sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                    <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
                  </button>
                </div>
              }
              @if (!profile()?.skills?.length) {
                <p class="text-ink-muted italic text-sm">No skills added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- Project Roles -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Project Roles</h3>
            <button (click)="toggleAddRole()" class="command-button secondary">
              <mat-icon class="text-sm">add</mat-icon> Add
            </button>
          </div>
          <div class="p-6">
            @if (showAddRole()) {
              <div class="command-card-muted flex gap-4 mb-6 p-4">
                <!-- Project roles are catalog values: choose-then-add from /project-roles
                     (stored value = role name). Roles already on the profile are filtered
                     out so they can't be added twice. -->
                <select [formControl]="roleInput" class="command-select flex-1" aria-label="Project role to add">
                  <option value="" disabled>Select a role...</option>
                  @for (role of addableRoleOptions(); track role.id) {
                    <option [value]="role.name">{{ role.name }}</option>
                  }
                </select>
                <button (click)="addRole()" [disabled]="!roleInput.value" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
              </div>
            }
            <div class="flex flex-wrap gap-3">
              @for (role of profile()?.projectRoles; track role) {
                <div class="flex items-center gap-2 px-3 py-1.5 bg-surface-muted rounded-lg border border-line">
                  <span class="font-medium text-ink-secondary text-sm">{{ role }}</span>
                  <button type="button" (click)="removeRole(role)" [attr.aria-label]="'Remove ' + role" [attr.title]="'Remove ' + role" class="text-ink-muted hover:text-critical-text transition-colors ml-1">
                    <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
                  </button>
                </div>
              }
              @if (!profile()?.projectRoles?.length) {
                <p class="text-ink-muted text-sm">No project roles added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- External Work Experience -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">External Work Experience</h3>
            <button (click)="toggleAddExtExp()" class="command-button secondary">
              <mat-icon class="text-sm">add</mat-icon> Add
            </button>
          </div>
          <div class="p-6">
            @if (showAddExtExp()) {
              <form [formGroup]="extExpForm" (ngSubmit)="addExtExp()" class="command-card-muted mb-6 p-5 space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label for="projectName" class="block text-xs font-medium text-ink-secondary mb-1">Project Name *</label>
                    <input id="projectName" formControlName="projectName" class="command-input">
                  </div>
                  <div>
                    <label for="company" class="block text-xs font-medium text-ink-secondary mb-1">Company *</label>
                    <input id="company" formControlName="company" class="command-input">
                  </div>
                  <div>
                    <label for="role" class="block text-xs font-medium text-ink-secondary mb-1">Project Role *</label>
                    <input id="role" formControlName="role" class="command-input">
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label for="startDate" class="block text-xs font-medium text-ink-secondary mb-1">Start Date *</label>
                      <input id="startDate" type="date" formControlName="startDate" class="command-input">
                    </div>
                    <div>
                      <label for="endDate" class="block text-xs font-medium text-ink-secondary mb-1">End Date *</label>
                      <input id="endDate" type="date" formControlName="endDate" class="command-input">
                    </div>
                  </div>
                </div>
                <div>
                  <label for="comment" class="block text-xs font-medium text-ink-secondary mb-1">Comment</label>
                  <textarea id="comment" formControlName="comment" rows="2" class="command-textarea"></textarea>
                </div>
                <div class="flex justify-end gap-2">
                  <button type="button" (click)="toggleAddExtExp()" class="command-button secondary">Cancel</button>
                  <button type="submit" [disabled]="!extExpForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
                </div>
              </form>
            }

            <div class="space-y-4">
              @for (exp of profile()?.externalExperience; track exp.projectName) {
                <div class="command-card-muted p-4 relative group">
                  <button type="button" (click)="removeExtExp(exp)" [attr.aria-label]="'Remove ' + exp.projectName" [attr.title]="'Remove ' + exp.projectName" class="absolute top-4 right-4 text-ink-muted hover:text-critical-text opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                    <mat-icon>delete</mat-icon>
                  </button>
                  <h4 class="font-medium text-[var(--cc-ink)]">{{ exp.projectName }}</h4>
                  <p class="text-sm text-[var(--cc-muted)]">{{ exp.role }} at {{ exp.company }}</p>
                  <p class="text-xs text-[var(--cc-muted)] mt-1 font-mono">{{ exp.startDate }} to {{ exp.endDate }}</p>
                  @if (exp.comment) {
                    <p class="text-sm text-ink-secondary mt-3 bg-surface p-3 rounded-lg border border-line">{{ exp.comment }}</p>
                  }
                </div>
              }
              @if (!profile()?.externalExperience?.length) {
                <p class="text-ink-muted text-sm">No external experience added yet.</p>
              }
            </div>
          </div>
        </div>

        <!-- Internal Work Experience (Assignments) -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Internal Work Experience (Assignments)</h3>
          </div>
          <div class="p-6">
            <div class="space-y-3">
              @for (assignment of myAssignments(); track assignment.id) {
                <div class="command-card-muted flex items-center justify-between p-4">
                  <div>
                    <h4 class="font-medium text-[var(--cc-ink)]">{{ getRequestName(assignment.requestId) }}</h4>
                    <p class="text-sm text-[var(--cc-muted)] mt-1"><span class="font-mono tabular-nums text-[var(--cc-primary-text)]">{{ assignment.assignedHours }}</span> hours • <span class="capitalize">{{ assignment.status }}</span></p>
                  </div>
                  <mat-icon class="text-ink-muted">chevron_right</mat-icon>
                </div>
              }
              @if (!myAssignments().length) {
                <p class="text-ink-muted text-sm">No internal assignments found.</p>
              }
            </div>
          </div>
        </div>

        <!-- Resume / Attachments -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h3 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resume & Attachments</h3>
          </div>
          <div class="p-6">
            @if (profile()?.resume) {
              <div class="command-card-muted flex items-center justify-between p-4">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 bg-accent-tint text-accent-text ring-1 ring-accent rounded-lg flex items-center justify-center">
                    <mat-icon>description</mat-icon>
                  </div>
                  <div>
                    <h4 class="font-medium text-[var(--cc-ink)]">Resume</h4>
                    <p class="text-xs text-[var(--cc-muted)]">Uploaded</p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <a [href]="profile()?.resume" download="Resume" aria-label="Download resume" title="Download resume" class="text-ink-muted hover:text-accent-text transition-colors">
                    <mat-icon>download</mat-icon>
                  </a>
                  <button type="button" (click)="removeResume()" aria-label="Remove resume" title="Remove resume" class="text-ink-muted hover:text-critical-text transition-colors">
                    <mat-icon>delete</mat-icon>
                  </button>
                </div>
              </div>
            } @else {
              <label class="block border-2 border-dashed border-line-strong rounded-xl p-8 text-center hover:bg-surface-muted transition-colors cursor-pointer">
                <input type="file" class="hidden" accept=".pdf,.doc,.docx" aria-label="Upload resume" (change)="onResumeSelected($event)">
                <mat-icon class="text-ink-muted mb-2">cloud_upload</mat-icon>
                <p class="text-sm font-medium text-ink-secondary">Click to upload resume</p>
                <p class="text-xs text-ink-muted mt-1">PDF or DOCX up to 2MB</p>
              </label>
            }
          </div>
        </div>

      }
    </div>
  `
})
export class MyProfileComponent {
  private api = inject(ApiService);
  private notify = inject(NotificationService);
  private auth = inject(AuthService);

  // /self derives the resource id from the verified OIDC principal server-side.
  // Do not issue a request until the principal is both restored and linked; an
  // unmapped identity must render empty instead of querying an arbitrary person.
  private dataRes = rxResource<{ profile: Resource | null; assignments: Assignment[]; requests: ResourceRequest[] }, boolean>({
    params: () => this.auth.authReady() && this.auth.hasResourceIdentity(),
    stream: ({ params: canLoad }) => canLoad
      ? forkJoin({
          profile: this.api.getMyProfile(),
          assignments: this.api.getMyAssignments(),
          requests: this.api.getMyRequests(),
        })
      : of({ profile: null, assignments: [], requests: [] }),
    defaultValue: { profile: null, assignments: [], requests: [] },
  });

  // Project-role option source: the canonical /project-roles catalog. projectRoles[]
  // entries are catalog NAMES (Phase A). Open read, but keyed on authReady to mirror
  // the principal-gated profile read above.
  private rolesRes = rxResource<ProjectRole[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjectRoles() : of<ProjectRole[]>([])),
    defaultValue: [] as ProjectRole[],
  });
  roleOptions = this.rolesRes.value;

  // Skill option source (Phase C): the canonical /skills catalog. A profile skill's
  // `name` is a catalog NAME; the add-skill picker offers these names. Keyed on
  // authReady to mirror the principal-gated reads above.
  private skillsRes = rxResource<Skill[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getSkills() : of<Skill[]>([])),
    defaultValue: [] as Skill[],
  });
  skillOptions = this.skillsRes.value;

  // Proficiency-set source (Phase C): a skill LEVEL is bound to the proficiency-set
  // levels (label = level name, value = level number) instead of a hardcoded 1/2/3.
  private proficiencyRes = rxResource<ProficiencySet[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProficiencySets() : of<ProficiencySet[]>([])),
    defaultValue: [] as ProficiencySet[],
  });
  // Level options come from the default (first) proficiency set's levels, sorted by
  // ascending level number. Empty until the set loads.
  levelOptions = computed(() => {
    const sets = this.proficiencyRes.value();
    const levels = sets[0]?.levels ?? [];
    return [...levels].sort((a, b) => a.level - b.level);
  });

  profile = computed(() => this.dataRes.value().profile);

  // Roles still available to add: every catalog role not already on the profile.
  // (Existing projectRoles outside the catalog stay visible as chips and are simply
  // not re-offered here; this is the choose-then-add list, not an edit-in-place.)
  addableRoleOptions = computed<ProjectRole[]>(() => {
    const have = new Set(this.profile()?.projectRoles ?? []);
    return this.roleOptions().filter(r => !have.has(r.name));
  });

  // Skills still available to add: every catalog skill not already on the profile.
  // (Existing skills outside the catalog stay visible as chips and are simply not
  // re-offered here; this is the choose-then-add list, not an edit-in-place.)
  addableSkillOptions = computed<Skill[]>(() => {
    const have = new Set((this.profile()?.skills ?? []).map(s => s.name));
    return this.skillOptions().filter(s => !have.has(s.name));
  });
  myAssignments = computed(() => {
    const id = this.dataRes.value().profile?.id;
    return this.dataRes.value().assignments.filter(a => a.resourceId === id);
  });
  allRequests = computed(() => this.dataRes.value().requests);

  showAddSkill = signal(false);
  showAddRole = signal(false);
  showAddExtExp = signal(false);

  skillForm = new FormGroup({
    name: new FormControl('', Validators.required),
    level: new FormControl<number | null>(null, Validators.required)
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

  nextSixMonths: { name: string, index: number }[] = this.generateMonths();

  private generateMonths(): { name: string, index: number }[] {
    const months: { name: string, index: number }[] = [];
    const d = new Date();
    for (let i = 0; i < 6; i++) {
      months.push({
        name: d.toLocaleString('default', { month: 'short', year: 'numeric' }),
        index: d.getMonth()
      });
      d.setMonth(d.getMonth() + 1);
    }
    return months;
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  getAssignedHoursForMonth(): number {
    // Mock logic: distribute total assigned hours evenly across the 6 displayed months.
    // Assignments don't yet carry start/end dates, so per-month distribution isn't possible;
    // every month shows the same even share until date-aware scheduling is added.
    const totalAssigned = this.myAssignments().reduce((sum, a) => sum + a.assignedHours, 0);
    return Math.round(totalAssigned / 6);
  }

  getUtilizationColorText(utilization: number): string {
    if (utilization > 110) return 'text-critical-text';
    if (utilization >= 80) return 'text-positive-text';
    return 'text-caution-text';
  }

  /** command-status modifier for the utilization pill (visual class names only). */
  getUtilizationColorBg(utilization: number): string {
    if (utilization > 110) return 'red';
    if (utilization >= 80) return 'green';
    return 'amber';
  }

  // --- Skills ---
  toggleAddSkill() { this.showAddSkill.update(v => !v); }
  addSkill() {
    if (this.skillForm.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const newSkill = { name: this.skillForm.value.name!, level: Number(this.skillForm.value.level!) };
      const updatedSkills = [...currentProfile.skills, newSkill];
      this.api.updateMyProfile({ skills: updatedSkills }).subscribe(() => {
        this.dataRes.reload();
        this.skillForm.reset({ name: '', level: null });
        this.showAddSkill.set(false);
      });
    }
  }
  removeSkill(skillName: string) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedSkills = currentProfile.skills.filter(s => s.name !== skillName);
      this.api.updateMyProfile({ skills: updatedSkills }).subscribe(() => this.dataRes.reload());
    }
  }

  // --- Roles ---
  toggleAddRole() { this.showAddRole.update(v => !v); }
  addRole() {
    if (this.roleInput.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const updatedRoles = [...(currentProfile.projectRoles || []), this.roleInput.value!];
      this.api.updateMyProfile({ projectRoles: updatedRoles }).subscribe(() => {
        this.dataRes.reload();
        this.roleInput.reset();
        this.showAddRole.set(false);
      });
    }
  }
  removeRole(roleName: string) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedRoles = currentProfile.projectRoles.filter(r => r !== roleName);
      this.api.updateMyProfile({ projectRoles: updatedRoles }).subscribe(() => this.dataRes.reload());
    }
  }

  // --- External Experience ---
  toggleAddExtExp() { this.showAddExtExp.update(v => !v); }
  addExtExp() {
    if (this.extExpForm.valid && this.profile()) {
      const currentProfile = this.profile()!;
      const newExp = this.extExpForm.value as { projectName: string; company: string; role: string; startDate: string; endDate: string; comment?: string };
      const updatedExp = [...(currentProfile.externalExperience || []), newExp];
      this.api.updateMyProfile({ externalExperience: updatedExp }).subscribe(() => {
        this.dataRes.reload();
        this.extExpForm.reset();
        this.showAddExtExp.set(false);
      });
    }
  }
  removeExtExp(exp: { projectName: string }) {
    if (this.profile()) {
      const currentProfile = this.profile()!;
      const updatedExp = currentProfile.externalExperience.filter(e => e.projectName !== exp.projectName);
      this.api.updateMyProfile({ externalExperience: updatedExp }).subscribe(() => this.dataRes.reload());
    }
  }

  // --- File Uploads ---
  private static readonly MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB

  onProfilePictureSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file && this.profile()) {
      if (file.size > MyProfileComponent.MAX_UPLOAD_BYTES) {
        this.notify.show('Image is too large. Maximum size is 2MB.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        this.api.updateMyProfile({ profilePicture: base64 }).subscribe(() => this.dataRes.reload());
      };
      reader.readAsDataURL(file);
    }
  }

  onResumeSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file && this.profile()) {
      if (file.size > MyProfileComponent.MAX_UPLOAD_BYTES) {
        this.notify.show('Resume is too large. Maximum size is 2MB.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        this.api.updateMyProfile({ resume: base64 }).subscribe(() => this.dataRes.reload());
      };
      reader.readAsDataURL(file);
    }
  }

  removeResume() {
    if (this.profile()) {
      this.api.updateMyProfile({ resume: '' }).subscribe(() => this.dataRes.reload());
    }
  }
}
