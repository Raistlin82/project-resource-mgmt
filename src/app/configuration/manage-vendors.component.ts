import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Vendor, Country } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-vendors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective],
  template: `
    <div class="max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <div class="command-section-label">Configuration</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Vendors</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">Maintain the partner/supplier company catalog.</p>
        </div>
        <button (click)="openForm()" class="command-button">
          <mat-icon class="text-sm">add</mat-icon> Add Vendor
        </button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="p-4 border-b border-[var(--cc-line)] flex gap-4 bg-[var(--cc-panel-muted)]">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">search</mat-icon>
            <input type="text" placeholder="Search vendors..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   aria-label="Search vendors"
                   class="w-full pl-10 pr-4 py-2 bg-surface focus:bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
          </div>
        </div>

        <table class="command-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>VAT ID</th>
              <th>Country</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (it of filtered(); track it.id) {
              <tr>
                <td class="font-bold">{{ it.name }}</td>
                <td><span class="font-mono text-[var(--cc-muted)]">{{ it.vatId || '—' }}</span></td>
                <td>{{ it.country || '—' }}</td>
                <td class="text-right">
                  <button type="button" (click)="openForm(it)" [attr.aria-label]="'Edit ' + it.name" [attr.title]="'Edit ' + it.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteItem(it.id)" [attr.aria-label]="'Delete ' + it.name" [attr.title]="'Delete ' + it.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (filtered().length === 0) {
              <tr>
                <td colspan="4" class="text-center"><span class="text-[var(--cc-muted)]">No vendors defined yet.</span></td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="vendorModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="command-card-header">
              <h2 id="vendorModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Vendor' : 'Add Vendor' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <form [formGroup]="form" (ngSubmit)="save()" class="p-6 space-y-4">
              <div>
                <label for="name" class="block text-sm font-medium text-ink-secondary mb-1">Name</label>
                <input id="name" type="text" formControlName="name" class="command-input" placeholder="e.g. TechCorp Inc.">
              </div>
              <div>
                <label for="vatId" class="block text-sm font-medium text-ink-secondary mb-1">VAT ID</label>
                <input id="vatId" type="text" formControlName="vatId" class="command-input font-mono" placeholder="e.g. IT-1234567890">
              </div>
              <div>
                <label for="country" class="block text-sm font-medium text-ink-secondary mb-1">Country</label>
                <!-- Country is a config FK to the countries catalog (store = ISO-2 code). -->
                <select id="country" formControlName="country" class="command-select">
                  <option value="">— None —</option>
                  @for (c of countryOptions(); track c.code) {
                    <option [value]="c.code">{{ c.name }} ({{ c.code }})</option>
                  }
                  @if (orphanCountry(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
              </div>
              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!form.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save Vendor</button>
              </div>
            </form>
          </div>
        </div>
      }

      @if (deletingId()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="vendorDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="vendorDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete Vendor</h3>
              <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this vendor? This action cannot be undone.</p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button (click)="cancelDelete()" class="command-button secondary">Cancel</button>
              <button (click)="confirmDelete()" class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm">Delete</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ManageVendorsComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private notifications = inject(NotificationService);

  private itemsRes = rxResource({ stream: () => this.api.getVendors(), defaultValue: [] as Vendor[] });
  items = this.itemsRes.value;

  search = signal('');
  filtered = computed(() => {
    const q = this.search().toLowerCase();
    return this.items().filter(v =>
      v.name.toLowerCase().includes(q) ||
      (v.vatId ?? '').toLowerCase().includes(q) ||
      (v.country ?? '').toLowerCase().includes(q),
    );
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  form = new FormGroup({
    name: new FormControl('', Validators.required),
    vatId: new FormControl(''),
    country: new FormControl(''),
  });

  // PHASE F2 — `country` is a config FK to the countries catalog (store = ISO-2 code).
  private countriesRes = rxResource({ stream: () => this.api.getCountries(), defaultValue: [] as Country[] });
  countryOptions = this.countriesRes.value;

  // ORPHAN VALUE: a stored country code not in the catalog stays selectable as a disabled option.
  private countryValue = toSignal(this.form.controls.country.valueChanges, { initialValue: this.form.controls.country.value });
  orphanCountry = computed<string | null>(() => {
    const current = this.countryValue();
    if (!current) return null;
    return this.countryOptions().some(c => c.code === current) ? null : current;
  });

  openForm(it?: Vendor) {
    if (it) {
      this.editingId.set(it.id);
      this.form.patchValue({ name: it.name, vatId: it.vatId ?? '', country: it.country ?? '' });
    } else {
      this.editingId.set(null);
      this.form.reset({ name: '', vatId: '', country: '' });
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.reset();
  }

  save() {
    if (!this.form.valid) return;
    const raw = this.form.getRawValue();
    const payload: Partial<Vendor> = {
      name: raw.name ?? '',
      vatId: raw.vatId ?? '',
      country: raw.country ?? '',
    };
    const id = this.editingId();
    const done = () => { this.itemsRes.reload(); this.closeForm(); this.notifications.show('Vendor saved.', 'success'); };
    if (id) {
      this.api.updateVendor(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    } else {
      this.api.createVendor(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    }
  }

  deleteItem(id: string) { this.deletingId.set(id); }

  confirmDelete() {
    const id = this.deletingId();
    if (!id) return;
    this.api.deleteVendor(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.itemsRes.reload();
      this.deletingId.set(null);
      this.notifications.show('Vendor deleted.', 'success');
    });
  }

  cancelDelete() { this.deletingId.set(null); }
}
