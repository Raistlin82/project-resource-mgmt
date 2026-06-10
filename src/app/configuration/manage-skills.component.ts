import { Component, inject, signal, computed, PLATFORM_ID } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { isPlatformBrowser } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin } from 'rxjs';
import { ApiService, Skill, SkillCatalog, ProficiencySet } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-skills',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Skills</h2>
        <div class="flex flex-wrap gap-3">
          <button (click)="triggerUpload()" class="bg-white text-slate-700 border border-slate-200 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
          <button (click)="downloadCsv()" class="bg-white text-slate-700 border border-slate-200 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Download CSV
          </button>
          <button (click)="openCreateForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Skill
          </button>
        </div>
      </div>

      <input type="file" id="csvUpload" accept=".csv" class="hidden" (change)="onFileSelected($event)">

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
          <form [formGroup]="skillForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-2xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="skillName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
                <input id="skillName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
              </div>
              <div>
                <label for="skillProficiencySet" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Proficiency Set</label>
                <select id="skillProficiencySet" formControlName="proficiencySetId" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 transition-all appearance-none">
                  <option [ngValue]="null">Not specified</option>
                  @for (set of proficiencySets(); track set.id) {
                    <option [value]="set.id">{{ set.name }}</option>
                  }
                </select>
              </div>
            </div>

            <div>
              <label for="skillDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
              <textarea id="skillDescription" formControlName="description" rows="3" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 placeholder:text-slate-400 transition-all"></textarea>
            </div>

            <div>
              <label for="skillCatalogs" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Catalogs</label>
              <select id="skillCatalogs" formControlName="catalogs" multiple class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 transition-all min-h-[120px]">
                @for (cat of catalogs(); track cat.id) {
                  <option [value]="cat.id" class="py-1">{{ cat.name }}</option>
                }
              </select>
              <p class="text-xs font-medium text-slate-500 mt-2">Hold Ctrl/Cmd to select multiple catalogs.</p>
            </div>

            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="skillForm.invalid" class="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">ID</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Catalogs</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Proficiency Set</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-center">Status</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (skill of skills(); track skill.id) {
                <tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors group" [class.opacity-60]="skill.restricted">
                  <td class="py-5 text-blue-700 font-mono text-xs font-bold tracking-wide">{{ skill.conceptUri }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ skill.name }}</td>
                  <td class="py-5 text-slate-600">
                    <div class="flex flex-wrap gap-2">
                      @for (catId of skill.catalogs; track catId) {
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-blue-50 text-blue-700 ring-1 ring-blue-200">
                          {{ getCatalogName(catId) }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="py-5 text-slate-600 font-medium">{{ getProficiencySetName(skill.proficiencySetId) }}</td>
                  <td class="py-5 text-center">
                    @if (skill.restricted) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-red-50 text-red-700 ring-1 ring-red-200 uppercase">Restricted</span>
                    } @else {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 uppercase">Active</span>
                    }
                  </td>
                  <td class="py-5 text-right">
                    <button type="button" (click)="toggleRestrict(skill)" class="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-amber-700 hover:border-amber-200 hover:bg-amber-50 transition-all inline-flex items-center justify-center shadow-sm mr-2" [attr.aria-label]="(skill.restricted ? 'Unrestrict ' : 'Restrict ') + skill.name" [title]="skill.restricted ? 'Unrestrict' : 'Restrict'">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ skill.restricted ? 'lock_open' : 'block' }}</mat-icon>
                    </button>
                    <button type="button" (click)="deleteSkill(skill.id)" class="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-red-700 hover:border-red-200 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete ' + skill.name" [attr.title]="'Delete ' + skill.name">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
})
export class ManageSkillsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);
  private platformId = inject(PLATFORM_ID);

  private dataRes = rxResource({
    stream: () => forkJoin({
      skills: this.api.getSkills(),
      catalogs: this.api.getSkillCatalogs(),
      proficiencySets: this.api.getProficiencySets(),
    }),
    defaultValue: { skills: [] as Skill[], catalogs: [] as SkillCatalog[], proficiencySets: [] as ProficiencySet[] },
  });

  skills = computed(() => this.dataRes.value().skills);
  catalogs = computed(() => this.dataRes.value().catalogs);
  proficiencySets = computed(() => this.dataRes.value().proficiencySets);
  showForm = signal(false);
  private pendingDeleteId = signal<string | null>(null);

  skillForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    catalogs: [[]],
    proficiencySetId: [null]
  });

  getCatalogName(id: string): string {
    return this.catalogs().find(c => c.id === id)?.name || 'Unknown';
  }

  getProficiencySetName(id?: string): string {
    if (!id) return 'Not specified';
    return this.proficiencySets().find(s => s.id === id)?.name || 'Unknown';
  }

  openCreateForm() {
    this.skillForm.reset({ catalogs: [], proficiencySetId: null });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  onSubmit() {
    if (this.skillForm.valid) {
      this.api.createSkill(this.skillForm.value).subscribe(() => {
        this.dataRes.reload();
        this.closeForm();
      });
    }
  }

  toggleRestrict(skill: Skill) {
    this.api.updateSkill(skill.id, { restricted: !skill.restricted }).subscribe(() => {
      this.dataRes.reload();
    });
  }

  deleteSkill(id: string) {
    if (this.pendingDeleteId() === id) {
      this.pendingDeleteId.set(null);
      this.api.deleteSkill(id).subscribe(() => {
        this.dataRes.reload();
      });
    } else {
      this.pendingDeleteId.set(id);
      this.notificationService.show('Click delete again to confirm removing this skill', 'info');
    }
  }

  triggerUpload() {
    if (!isPlatformBrowser(this.platformId)) return;
    document.getElementById('csvUpload')?.click();
  }

  onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      this.notificationService.show('CSV import is not available yet', 'info');
      target.value = ''; // Reset
    }
  }

  private escapeCsv(v: string): string {
    const s = String(v ?? '');
    const out = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
  }

  downloadCsv() {
    if (!isPlatformBrowser(this.platformId)) return;
    const csvContent = "conceptType,conceptUri,skillType,preferredLabel,altLabels,description,usage,catalogs,proficiencySet\n" +
      this.skills().map(s => `KnowledgeSkillCompetence,${this.escapeCsv(s.conceptUri)},skill/competence,${this.escapeCsv(s.name)},,${this.escapeCsv(s.description)},${s.restricted ? 'restricted' : 'unrestricted'},,`).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "Skills_en.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
