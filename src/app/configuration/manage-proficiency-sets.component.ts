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
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Proficiency Sets</h2>
        <button (click)="openCreateForm()" class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Set
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="setForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-3xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="setName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
                <input id="setName" type="text" formControlName="name" class="command-input">
              </div>
              <div>
                <label for="setDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
                <input id="setDescription" type="text" formControlName="description" class="command-input">
              </div>
            </div>

            <div formArrayName="levels" class="space-y-4 mt-8">
              <div class="flex justify-between items-center pb-2 border-b border-[var(--cc-line)]">
                <h3 class="command-section-label">Proficiency Levels</h3>
                <button type="button" (click)="addLevel()" class="command-button secondary">
                  <mat-icon class="text-[18px] w-[18px] h-[18px]">add_circle</mat-icon> Add Level
                </button>
              </div>

              <div class="space-y-3">
                @for (level of levels.controls; track i; let i = $index) {
                  <div [formGroupName]="i" class="flex flex-col sm:flex-row gap-4 items-start command-card p-4">
                    <div class="w-full sm:w-24">
                      <label [for]="'level' + i" class="block text-[10px] font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-1.5">Level</label>
                      <input [id]="'level' + i" type="number" formControlName="level" [attr.aria-label]="'Level number for proficiency level ' + (i + 1)" class="command-input text-center">
                    </div>
                    <div class="flex-1 w-full">
                      <label [for]="'levelName' + i" class="block text-[10px] font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-1.5">Name</label>
                      <input [id]="'levelName' + i" type="text" formControlName="name" [attr.aria-label]="'Name for proficiency level ' + (i + 1)" class="command-input">
                    </div>
                    <div class="flex-1 w-full">
                      <label [for]="'levelDesc' + i" class="block text-[10px] font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-1.5">Description</label>
                      <input [id]="'levelDesc' + i" type="text" formControlName="description" [attr.aria-label]="'Description for proficiency level ' + (i + 1)" class="command-input">
                    </div>
                    <button type="button" (click)="removeLevel(i)" [attr.aria-label]="'Remove level ' + (i + 1)" [attr.title]="'Remove level ' + (i + 1)" class="mt-0 sm:mt-6 w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm self-end sm:self-auto">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">remove_circle</mat-icon>
                    </button>
                  </div>
                }
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-6 border-t border-[var(--cc-line)]">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="setForm.invalid" class="command-button disabled:opacity-50">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="overflow-x-auto">
        <table class="command-data-table">
          <thead>
            <tr>
              <th class="w-1/4">Name</th>
              <th class="w-1/3">Description</th>
              <th>Levels</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (set of proficiencySets(); track set.id) {
              <tr>
                <td class="font-bold">{{ set.name }}</td>
                <td>{{ set.description }}</td>
                <td>
                  <div class="flex flex-wrap gap-2">
                    @for (lvl of set.levels; track lvl.id) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-surface-muted text-ink-secondary ring-1 ring-line" title="{{lvl.description}}">
                        <span class="text-accent-text font-mono mr-1">{{ lvl.level }}:</span> {{ lvl.name }}
                      </span>
                    }
                  </div>
                </td>
                <td class="text-right">
                  @if (pendingDeleteId() === set.id) {
                    <div class="inline-flex items-center gap-2">
                      <span class="text-xs font-bold text-[var(--cc-muted)]">Delete?</span>
                      <button (click)="confirmDelete(set.id)" class="px-3 py-1.5 text-xs font-bold text-critical-text bg-critical-tint ring-1 ring-critical rounded-lg hover:bg-[color-mix(in_oklch,var(--color-critical)_16%,var(--color-surface))] transition-all shadow-sm">Confirm</button>
                      <button (click)="cancelDelete()" class="px-3 py-1.5 text-xs font-bold text-ink-secondary bg-surface border border-line rounded-lg hover:bg-surface-muted transition-all shadow-sm">Cancel</button>
                    </div>
                  } @else {
                    <button (click)="requestDelete(set.id)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete proficiency set ' + set.name" [attr.title]="'Delete proficiency set ' + set.name">
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
