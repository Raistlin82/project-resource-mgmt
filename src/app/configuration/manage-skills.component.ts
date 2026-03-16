import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin } from 'rxjs';
import { ApiService, Skill, SkillCatalog, ProficiencySet } from '../services/api.service';

@Component({
  selector: 'app-manage-skills',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Skills</h2>
        <div class="flex flex-wrap gap-3">
          <button (click)="triggerUpload()" class="bg-white text-slate-700 border border-slate-200/60 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
          <button (click)="downloadCsv()" class="bg-white text-slate-700 border border-slate-200/60 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Download CSV
          </button>
          <button (click)="openCreateForm()" class="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Skill
          </button>
        </div>
      </div>

      <input type="file" id="csvUpload" accept=".csv" class="hidden" (change)="onFileSelected($event)">

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200/60 bg-slate-50/80 backdrop-blur-sm">
          <form [formGroup]="skillForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-2xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="skillName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
                <input id="skillName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-bold text-slate-900 transition-all">
              </div>
              <div>
                <label for="skillProficiencySet" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Proficiency Set</label>
                <select id="skillProficiencySet" formControlName="proficiencySetId" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-medium text-slate-700 transition-all appearance-none">
                  <option [ngValue]="null">Not specified</option>
                  @for (set of proficiencySets(); track set.id) {
                    <option [value]="set.id">{{ set.name }}</option>
                  }
                </select>
              </div>
            </div>
            
            <div>
              <label for="skillDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
              <textarea id="skillDescription" formControlName="description" rows="3" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-medium text-slate-700 transition-all"></textarea>
            </div>

            <div>
              <label for="skillCatalogs" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Catalogs</label>
              <select id="skillCatalogs" formControlName="catalogs" multiple class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-medium text-slate-700 transition-all min-h-[120px]">
                @for (cat of catalogs(); track cat.id) {
                  <option [value]="cat.id" class="py-1">{{ cat.name }}</option>
                }
              </select>
              <p class="text-xs font-medium text-slate-500 mt-2">Hold Ctrl/Cmd to select multiple catalogs.</p>
            </div>

            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200/60 rounded-xl hover:bg-slate-50 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="skillForm.invalid" class="px-6 py-2.5 text-sm font-bold text-white bg-indigo-600 border border-transparent rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200/60">
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
                <tr class="border-b border-slate-100 hover:bg-slate-50/80 transition-colors group" [class.opacity-60]="skill.restricted">
                  <td class="py-5 text-slate-500 font-mono text-xs font-bold tracking-wide">{{ skill.conceptUri }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-indigo-700 transition-colors">{{ skill.name }}</td>
                  <td class="py-5 text-slate-600">
                    <div class="flex flex-wrap gap-2">
                      @for (catId of skill.catalogs; track catId) {
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-blue-50 text-blue-700 border border-blue-200/60">
                          {{ getCatalogName(catId) }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="py-5 text-slate-600 font-medium">{{ getProficiencySetName(skill.proficiencySetId) }}</td>
                  <td class="py-5 text-center">
                    @if (skill.restricted) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-red-50 text-red-700 border border-red-200/60 uppercase">Restricted</span>
                    } @else {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200/60 uppercase">Active</span>
                    }
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="toggleRestrict(skill)" class="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-amber-600 hover:border-amber-200 hover:bg-amber-50 transition-all inline-flex items-center justify-center shadow-sm mr-2" [title]="skill.restricted ? 'Unrestrict' : 'Restrict'">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ skill.restricted ? 'lock_open' : 'block' }}</mat-icon>
                    </button>
                    <button (click)="deleteSkill(skill.id)" class="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
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
export class ManageSkillsComponent implements OnInit {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);

  skills = signal<Skill[]>([]);
  catalogs = signal<SkillCatalog[]>([]);
  proficiencySets = signal<ProficiencySet[]>([]);
  showForm = signal(false);

  skillForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    catalogs: [[]],
    proficiencySetId: [null]
  });

  ngOnInit() {
    this.loadData();
  }

  loadData() {
    forkJoin({
      skills: this.api.getSkills(),
      catalogs: this.api.getSkillCatalogs(),
      proficiencySets: this.api.getProficiencySets()
    }).subscribe(data => {
      this.skills.set(data.skills);
      this.catalogs.set(data.catalogs);
      this.proficiencySets.set(data.proficiencySets);
    });
  }

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
        this.loadData();
        this.closeForm();
      });
    }
  }

  toggleRestrict(skill: Skill) {
    this.api.updateSkill(skill.id, { restricted: !skill.restricted }).subscribe(() => {
      this.loadData();
    });
  }

  deleteSkill(id: string) {
    if (confirm('Are you sure you want to delete this skill?')) {
      this.api.deleteSkill(id).subscribe(() => {
        this.loadData();
      });
    }
  }

  triggerUpload() {
    document.getElementById('csvUpload')?.click();
  }

  onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      // Mock upload process
      alert(`File ${file.name} uploaded successfully. Skills would be processed here.`);
      target.value = ''; // Reset
    }
  }

  downloadCsv() {
    // Mock download process
    const csvContent = "conceptType,conceptUri,skillType,preferredLabel,altLabels,description,usage,catalogs,proficiencySet\n" +
      this.skills().map(s => `KnowledgeSkillCompetence,${s.conceptUri},skill/competence,${s.name},,${s.description},${s.restricted ? 'restricted' : 'unrestricted'},,`).join('\n');
    
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
