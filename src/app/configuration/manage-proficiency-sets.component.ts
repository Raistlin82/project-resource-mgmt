import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormArray } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-proficiency-sets',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Proficiency Sets</h2>
        <button (click)="openCreateForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 shadow-sm hover:-translate-y-0.5">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Set
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50 backdrop-blur-sm">
          <form [formGroup]="setForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-3xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="setName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
                <input id="setName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
              </div>
              <div>
                <label for="setDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
                <input id="setDescription" type="text" formControlName="description" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-700 placeholder:text-slate-400 transition-all">
              </div>
            </div>

            <div formArrayName="levels" class="space-y-4 mt-8">
              <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                <h3 class="text-sm font-bold text-slate-700 uppercase tracking-wider">Proficiency Levels</h3>
                <button type="button" (click)="addLevel()" class="text-blue-700 hover:text-blue-800 text-sm font-bold flex items-center gap-1.5 transition-colors bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200 px-3 py-1.5 rounded-lg">
                  <mat-icon class="text-[18px] w-[18px] h-[18px]">add_circle</mat-icon> Add Level
                </button>
              </div>

              <div class="space-y-3">
                @for (level of levels.controls; track i; let i = $index) {
                  <div [formGroupName]="i" class="flex flex-col sm:flex-row gap-4 items-start bg-white p-4 rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-all group">
                    <div class="w-full sm:w-24">
                      <label [for]="'level' + i" class="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">Level</label>
                      <input [id]="'level' + i" type="number" formControlName="level" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white font-mono font-bold text-blue-700 placeholder:text-slate-400 transition-all text-center">
                    </div>
                    <div class="flex-1 w-full">
                      <label [for]="'levelName' + i" class="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">Name</label>
                      <input [id]="'levelName' + i" type="text" formControlName="name" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white font-bold text-slate-900 placeholder:text-slate-400 transition-all">
                    </div>
                    <div class="flex-1 w-full">
                      <label [for]="'levelDesc' + i" class="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">Description</label>
                      <input [id]="'levelDesc' + i" type="text" formControlName="description" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white font-medium text-slate-700 placeholder:text-slate-400 transition-all">
                    </div>
                    <button type="button" (click)="removeLevel(i)" class="mt-0 sm:mt-6 w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm self-end sm:self-auto">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">remove_circle</mat-icon>
                    </button>
                  </div>
                }
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-6 border-t border-slate-200">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="setForm.invalid" class="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/4">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Description</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Levels</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (set of proficiencySets(); track set.id) {
                <tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors group">
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ set.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">{{ set.description }}</td>
                  <td class="py-5 text-slate-600">
                    <div class="flex flex-wrap gap-2">
                      @for (lvl of set.levels; track lvl.id) {
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-700 ring-1 ring-slate-200" title="{{lvl.description}}">
                          <span class="text-blue-700 font-mono mr-1">{{ lvl.level }}:</span> {{ lvl.name }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="py-5 text-right">
                    @if (pendingDeleteId() === set.id) {
                      <div class="inline-flex items-center gap-2">
                        <span class="text-xs font-bold text-slate-600">Delete?</span>
                        <button (click)="confirmDelete(set.id)" class="px-3 py-1.5 text-xs font-bold text-red-700 bg-red-50 ring-1 ring-red-200 rounded-lg hover:bg-red-100 transition-all shadow-sm">Confirm</button>
                        <button (click)="cancelDelete()" class="px-3 py-1.5 text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-all shadow-sm">Cancel</button>
                      </div>
                    } @else {
                      <button (click)="requestDelete(set.id)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                      </button>
                    }
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
export class ManageProficiencySetsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notifications = inject(NotificationService);

  private setsRes = rxResource({ stream: () => this.api.getProficiencySets(), defaultValue: [] });
  proficiencySets = computed(() => this.setsRes.value());
  showForm = signal(false);
  pendingDeleteId = signal<string | null>(null);

  setForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    levels: this.fb.array([])
  });

  get levels() {
    return this.setForm.get('levels') as FormArray;
  }

  openCreateForm() {
    this.setForm.reset();
    this.levels.clear();
    this.addLevel(); // Add one empty level by default
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  addLevel() {
    this.levels.push(this.fb.group({
      id: [Date.now().toString()],
      level: [this.levels.length + 1, Validators.required],
      name: ['', Validators.required],
      description: ['']
    }));
  }

  removeLevel(index: number) {
    this.levels.removeAt(index);
  }

  onSubmit() {
    if (this.setForm.valid) {
      this.api.createProficiencySet(this.setForm.value).subscribe(() => {
        this.setsRes.reload();
        this.closeForm();
        this.notifications.show('Proficiency set created.', 'success');
      });
    }
  }

  requestDelete(id: string) {
    this.pendingDeleteId.set(id);
    this.notifications.show('Confirm deletion of this proficiency set.', 'info');
  }

  cancelDelete() {
    this.pendingDeleteId.set(null);
  }

  confirmDelete(id: string) {
    this.api.deleteProficiencySet(id).subscribe(() => {
      this.pendingDeleteId.set(null);
      this.setsRes.reload();
      this.notifications.show('Proficiency set deleted.', 'success');
    });
  }
}
