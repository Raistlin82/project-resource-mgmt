import { Component, inject, signal, computed, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin } from 'rxjs';
import { ApiService, Skill, SkillCatalog, ProficiencySet } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { MultiSelectChipsComponent, type MultiSelectOption } from '../shared/multi-select-chips.component';

@Component({
  selector: 'app-manage-skills',
  imports: [ReactiveFormsModule, MatIconModule, MultiSelectChipsComponent],
  template: `
    <div class="command-card overflow-hidden">
      <div class="command-card-header flex-wrap">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Skills</h2>
        <div class="flex flex-wrap gap-3">
          <button (click)="triggerUpload()" class="command-button secondary">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
          <button (click)="downloadCsv()" class="command-button secondary">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Download CSV
          </button>
          <button (click)="openCreateForm()" class="command-button">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Skill
          </button>
        </div>
      </div>

      <input type="file" id="csvUpload" accept=".csv" class="hidden" aria-label="Upload skills CSV" (change)="onFileSelected($event)">

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="skillForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-2xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="skillName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
                <input id="skillName" type="text" formControlName="name" class="command-input"
                       [attr.aria-invalid]="skillForm.get('name')!.invalid && (skillForm.get('name')!.touched || skillForm.get('name')!.dirty)"
                       [attr.aria-describedby]="skillForm.get('name')!.invalid && (skillForm.get('name')!.touched || skillForm.get('name')!.dirty) ? 'skillNameError' : null">
                @if (skillForm.get('name')!.invalid && (skillForm.get('name')!.touched || skillForm.get('name')!.dirty)) {
                  <p id="skillNameError" class="command-field-error" role="alert">Name is required.</p>
                }
              </div>
              <div>
                <label for="skillProficiencySet" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Proficiency Set</label>
                <select id="skillProficiencySet" formControlName="proficiencySetId" class="command-select">
                  <option [ngValue]="null">Not specified</option>
                  @for (set of proficiencySets(); track set.id) {
                    <option [value]="set.id">{{ set.name }}</option>
                  }
                </select>
              </div>
            </div>

            <div>
              <label for="skillDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
              <textarea id="skillDescription" formControlName="description" rows="3" class="command-textarea"></textarea>
            </div>

            <div>
              <label for="skillCatalogs" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Catalogs</label>
              <!-- UX register P2-19: this was a <select multiple>, which needs a
                   Ctrl/Cmd-click to hold a second catalog — impossible on touch, where
                   picking a second one silently replaced the first. Now the shared
                   choose-then-add + removable-chip primitive, which also renders an
                   ORPHAN catalog id (one the catalog list no longer offers) as a chip
                   instead of dropping it: the control stores raw ids and the primitive
                   never intersects the model with its options. -->
              <app-multi-select-chips formControlName="catalogs" inputId="skillCatalogs"
                                      [options]="catalogOptions()"
                                      pickerLabel="Catalog to add"
                                      placeholder="Select a catalog..."
                                      emptyText="No catalogs assigned yet." />
            </div>

            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="skillForm.invalid" class="command-button disabled:opacity-50">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="overflow-x-auto">
        <table class="command-data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Catalogs</th>
              <th>Proficiency Set</th>
              <th>Status</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (skill of skills(); track skill.id) {
              <tr [class.opacity-60]="skill.restricted">
                <td><span class="font-mono text-xs font-bold tracking-wide text-[var(--cc-primary-text)]">{{ skill.conceptUri }}</span></td>
                <td class="font-bold">{{ skill.name }}</td>
                <td>
                  <div class="flex flex-wrap gap-2">
                    @for (catId of skill.catalogs; track catId) {
                      <span class="command-status">
                        {{ getCatalogName(catId) }}
                      </span>
                    }
                  </div>
                </td>
                <td>{{ getProficiencySetName(skill.proficiencySetId) }}</td>
                <td>
                  @if (skill.restricted) {
                    <span class="command-status red">Restricted</span>
                  } @else {
                    <span class="command-status green">Active</span>
                  }
                </td>
                <td class="text-right">
                  <!-- The restrict toggle gets the SAME row-rendered arm/Confirm shape as
                       the delete beside it (and as manage-project-roles). It used to PUT on
                       a single click with no arming and no confirmation, so one control on
                       this screen was guarded and its sibling was not.
                       The armed label follows the ROW's direction, because this one control
                       both restricts and unrestricts. -->
                  @if (pendingRestrictId() === skill.id) {
                    <div class="inline-flex items-center gap-2 mr-2">
                      <span class="text-xs font-bold text-[var(--cc-muted)]">{{ skill.restricted ? 'Unrestrict' : 'Restrict' }} {{ skill.name }}?</span>
                      <button type="button" (click)="confirmRestrict(skill)" class="px-3 py-1.5 text-xs font-bold text-caution-text bg-caution-tint ring-1 ring-caution rounded-lg hover:bg-[color-mix(in_oklch,var(--color-caution)_16%,var(--color-surface))] transition-all shadow-sm">Confirm</button>
                      <button type="button" (click)="cancelRestrict()" class="px-3 py-1.5 text-xs font-bold text-ink-secondary bg-surface border border-line rounded-lg hover:bg-surface-muted transition-all shadow-sm">Cancel</button>
                    </div>
                  } @else {
                    <button type="button" (click)="requestRestrict(skill)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-caution-text hover:border-caution hover:bg-caution-tint transition-all inline-flex items-center justify-center shadow-sm mr-2" [attr.aria-label]="(skill.restricted ? 'Unrestrict ' : 'Restrict ') + skill.name" [title]="skill.restricted ? 'Unrestrict' : 'Restrict'">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ skill.restricted ? 'lock_open' : 'block' }}</mat-icon>
                    </button>
                  }
                  <!-- ARMED STATE IS RENDERED IN THE ROW, not announced in a toast.
                       The previous shape armed pendingDeleteId invisibly and never
                       expired it, while its only warning was a toast that auto-dismisses
                       after 5s: ten minutes later the same trash icon deleted the skill
                       outright. Confirm/Cancel live inside the armed row, so the armed
                       object is always the object the admin can see. -->
                  @if (pendingDeleteId() === skill.id) {
                    <div class="inline-flex items-center gap-2">
                      <span class="text-xs font-bold text-[var(--cc-muted)]">Delete {{ skill.name }}?</span>
                      <button type="button" (click)="confirmDelete(skill.id)" class="px-3 py-1.5 text-xs font-bold text-critical-text bg-critical-tint ring-1 ring-critical rounded-lg hover:bg-[color-mix(in_oklch,var(--color-critical)_16%,var(--color-surface))] transition-all shadow-sm">Confirm</button>
                      <button type="button" (click)="cancelDelete()" class="px-3 py-1.5 text-xs font-bold text-ink-secondary bg-surface border border-line rounded-lg hover:bg-surface-muted transition-all shadow-sm">Cancel</button>
                    </div>
                  } @else {
                    <button type="button" (click)="requestDelete(skill.id)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete ' + skill.name" [attr.title]="'Delete ' + skill.name">
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
export class ManageSkillsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);
  private platformId = inject(PLATFORM_ID);

  private dataRes = authGatedResource(
    () => forkJoin({
      skills: this.api.getSkills(),
      catalogs: this.api.getSkillCatalogs(),
      proficiencySets: this.api.getProficiencySets(),
    }),
    { skills: [] as Skill[], catalogs: [] as SkillCatalog[], proficiencySets: [] as ProficiencySet[] },
  );

  skills = computed(() => this.dataRes.value().skills);
  catalogs = computed(() => this.dataRes.value().catalogs);
  proficiencySets = computed(() => this.dataRes.value().proficiencySets);
  showForm = signal(false);
  /** Read by the template: the armed row renders its own Confirm/Cancel pair. */
  protected pendingDeleteId = signal<string | null>(null);
  /** Same, for the restrict toggle — one armed row at a time, per control. */
  protected pendingRestrictId = signal<string | null>(null);

  /**
   * Catalog picker options for the chips control: the STORED value is the catalog
   * id, the label is its name. Mapping only — never a filter over the model.
   */
  catalogOptions = computed<MultiSelectOption[]>(() =>
    this.catalogs().map(c => ({ value: c.id, label: c.name })));

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

  /**
   * Arms the restrict toggle. Deliberately CANNOT write: the only path to the PUT is
   * the Confirm control rendered inside the armed row, so a stale click on this icon
   * — or on another row's — can never flip a skill.
   *
   * The toast is corroboration, not the warning: it names the skill and the
   * direction. It deliberately does NOT promise that restricting takes the skill out
   * of use. NOTHING enforces the flag today: all three consumers of /skills
   * (my-profile, resource-requests and this screen) list every skill and none filters
   * on `restricted`, and the server's own reference check builds its valid-name set
   * from every row (`skillNames()` in src/server.ts) so a restricted skill still
   * validates on a resource or a request. So the honest statement is that the catalog
   * entry is marked — promising an enforcement that does not exist is the same defect
   * the vendors dialog was corrected for.
   */
  requestRestrict(skill: Skill) {
    this.pendingRestrictId.set(skill.id);
    const action = skill.restricted ? 'unrestricting' : 'restricting';
    this.notificationService.show(
      `Confirm ${action} "${skill.name}". This marks the catalog entry only: profiles and requests that already name the skill keep it, and it stays selectable.`,
      'info',
    );
  }

  cancelRestrict() {
    this.pendingRestrictId.set(null);
  }

  confirmRestrict(skill: Skill) {
    this.api.updateSkill(skill.id, { restricted: !skill.restricted }).subscribe(() => {
      this.pendingRestrictId.set(null);
      this.dataRes.reload();
    });
  }

  /**
   * Arms the row. Deliberately CANNOT delete: the only path to the DELETE is the
   * Confirm control rendered inside the armed row, so a stale click on a trash
   * icon — the same one, or another row's — can never destroy anything.
   *
   * The toast is now corroboration, not the warning: it names the skill and the
   * consequence the old copy left out (resources whose profile lists this skill
   * keep a name that is no longer in the catalog, and POST/PUT of a resource
   * validates skills against that catalog, so those profiles can no longer be
   * re-saved as they stand).
   */
  requestDelete(id: string) {
    this.pendingDeleteId.set(id);
    const name = this.skills().find(s => s.id === id)?.name ?? 'this skill';
    this.notificationService.show(
      `Confirm deletion of "${name}". Resource profiles that list it keep a skill name no longer in the catalog and cannot be re-saved until it is removed from them.`,
      'info',
    );
  }

  cancelDelete() {
    this.pendingDeleteId.set(null);
  }

  confirmDelete(id: string) {
    this.api.deleteSkill(id).subscribe(() => {
      this.pendingDeleteId.set(null);
      this.dataRes.reload();
    });
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
