import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { of } from 'rxjs';
import { ApiService, RateCard, ProjectRole, ResourceOrganization, FxRate } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

/** Base/reporting currency — the default denomination for a rate card. */
const BASE_CURRENCY = 'EUR';

@Component({
  selector: 'app-manage-rate-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective, DecimalPipe],
  template: `
    <div class="max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <div class="command-section-label">Configuration</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Rate Cards</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">Default cost &amp; bill rates per role, in <strong>€ / day</strong>. A resource inherits the matching card unless it sets a per-resource override; an organization-specific card overrides the generic one.</p>
        </div>
        <button (click)="openForm()" class="command-button">
          <mat-icon class="text-sm">add</mat-icon> Add Rate Card
        </button>
      </div>

      <!-- HYBRID DAY MODEL: rates are per day; this factor converts them to the
           hourly rate used for margins (timesheets/assignments stay in hours). -->
      <div class="command-card p-4 flex flex-wrap items-center gap-3">
        <mat-icon class="text-accent-text">schedule</mat-icon>
        <span class="text-sm text-ink-secondary">Rates are <strong>daily</strong>. 1 working day =</span>
        <input type="number" min="1" max="24" step="0.5" [ngModel]="hoursPerDay()" (ngModelChange)="hoursPerDay.set($event)"
               class="command-input text-center" style="width:5rem" aria-label="Working hours per day">
        <span class="text-sm text-ink-secondary">hours (used to convert €/day → €/hour in the margin calculations).</span>
        <button type="button" (click)="saveHoursPerDay()" [disabled]="!validHoursPerDay()" class="command-button secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="p-4 border-b border-[var(--cc-line)] flex gap-4 bg-[var(--cc-panel-muted)]">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">search</mat-icon>
            <input type="text" placeholder="Search rate cards..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   aria-label="Search rate cards"
                   class="w-full pl-10 pr-4 py-2 bg-surface focus:bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
          </div>
        </div>

        <table class="command-data-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Organization</th>
              <th>Currency</th>
              <th class="text-right">Cost rate (€/day)</th>
              <th class="text-right">Bill rate (€/day)</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (it of filtered(); track it.id) {
              <tr>
                <td class="font-bold">{{ it.role }}</td>
                <td>{{ it.organization || 'All organizations' }}</td>
                <td><span class="font-mono text-[var(--cc-muted)]">{{ it.currency }}</span></td>
                <td class="text-right tabular-nums">{{ it.costRate | number:'1.0-2' }}</td>
                <td class="text-right tabular-nums">{{ it.billRate | number:'1.0-2' }}</td>
                <td class="text-right">
                  <button type="button" (click)="openForm(it)" [attr.aria-label]="'Edit ' + it.role" [attr.title]="'Edit ' + it.role" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteItem(it.id)" [attr.aria-label]="'Delete rate card for ' + it.role" [attr.title]="'Delete'" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (filtered().length === 0) {
              <tr>
                <td colspan="6" class="text-center"><span class="text-[var(--cc-muted)]">No rate cards defined yet.</span></td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="rateCardModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="command-card-header">
              <h2 id="rateCardModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Rate Card' : 'Add Rate Card' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <form [formGroup]="form" (ngSubmit)="save()" class="p-6 space-y-4">
              <div>
                <label for="rc-role" class="block text-sm font-medium text-ink-secondary mb-1">Role *</label>
                <!-- Role is a config FK to the project-roles catalog (store = name). -->
                <select id="rc-role" formControlName="role" class="command-select">
                  <option value="" disabled>Select a role...</option>
                  @for (r of roleOptions(); track r.id) {
                    <option [value]="r.name">{{ r.name }}</option>
                  }
                  @if (orphanRole(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
              </div>
              <div>
                <label for="rc-org" class="block text-sm font-medium text-ink-secondary mb-1">Organization</label>
                <!-- Optional: empty = applies to ALL organizations. An org-specific card wins. -->
                <select id="rc-org" formControlName="organization" class="command-select">
                  <option value="">All organizations</option>
                  @for (o of orgOptions(); track o.id) {
                    <option [value]="o.name">{{ o.name }}</option>
                  }
                  @if (orphanOrg(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
              </div>
              <div>
                <label for="rc-currency" class="block text-sm font-medium text-ink-secondary mb-1">Currency *</label>
                <select id="rc-currency" formControlName="currency" class="command-select">
                  @for (c of currencyOptions(); track c) {
                    <option [value]="c">{{ c }}</option>
                  }
                </select>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label for="rc-cost" class="block text-sm font-medium text-ink-secondary mb-1">Cost rate (€/day) *</label>
                  <input id="rc-cost" type="number" min="0" step="1" formControlName="costRate" class="command-input" placeholder="e.g. 600">
                </div>
                <div>
                  <label for="rc-bill" class="block text-sm font-medium text-ink-secondary mb-1">Bill rate (€/day) *</label>
                  <input id="rc-bill" type="number" min="0" step="1" formControlName="billRate" class="command-input" placeholder="e.g. 1120">
                </div>
              </div>
              @if (duplicateExists()) {
                <p role="alert" class="text-xs text-critical-text">A rate card already exists for this role / organization / currency. Edit that card instead of creating a duplicate.</p>
              }
              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!form.valid || duplicateExists()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save Rate Card</button>
              </div>
            </form>
          </div>
        </div>
      }

      @if (deletingId()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="rateCardDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="rateCardDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete Rate Card</h3>
              <p class="text-[var(--cc-muted)] text-sm">Resources inheriting this card will fall back to a more generic card (or to a manual rate). This cannot be undone.</p>
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
export class ManageRateCardsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);
  private notifications = inject(NotificationService);

  private itemsRes = rxResource<RateCard[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getRateCards() : of<RateCard[]>([])),
    defaultValue: [] as RateCard[],
  });
  items = this.itemsRes.value;

  // Reference-data sources for the bound selects (role / organization / currency).
  private rolesRes = rxResource({ stream: () => this.api.getProjectRoles(), defaultValue: [] as ProjectRole[] });
  roleOptions = this.rolesRes.value;
  private orgsRes = rxResource({ stream: () => this.api.getResourceOrganizations(), defaultValue: [] as ResourceOrganization[] });
  orgOptions = this.orgsRes.value;
  private fxRes = rxResource({ stream: () => this.api.getFxRates(), defaultValue: [] as FxRate[] });
  // Currency list = base currency + every configured fx-rate currency (deduped).
  currencyOptions = computed<string[]>(() => {
    const set = new Set<string>([BASE_CURRENCY, ...this.fxRes.value().map(f => f.currency)]);
    return [...set];
  });

  // Hybrid day model: working hours per day (converts €/day → €/hour for margins).
  hoursPerDay = signal<number | null>(null);
  validHoursPerDay = computed(() => { const v = this.hoursPerDay(); return v != null && v > 0 && v <= 24; });
  private hpdRes = rxResource({ stream: () => this.api.getHoursPerDay(), defaultValue: { value: 8 } });
  constructor() {
    // Seed the editable field from the persisted setting once it loads.
    effect(() => { const v = this.hpdRes.value()?.value; if (v != null && this.hoursPerDay() == null) this.hoursPerDay.set(v); });
  }
  saveHoursPerDay() {
    const v = this.hoursPerDay();
    if (v == null || !this.validHoursPerDay()) return;
    this.api.setHoursPerDay(v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.itemsRes.reload(); this.notifications.show('Working hours per day updated. The effective hourly rates have been recalculated.', 'success'); },
      error: (e) => this.notifications.show((e as { error?: { error?: string } })?.error?.error || 'Unable to save the working hours per day.', 'error'),
    });
  }

  search = signal('');
  filtered = computed(() => {
    const q = this.search().toLowerCase();
    return this.items().filter(c =>
      c.role.toLowerCase().includes(q) ||
      (c.organization ?? '').toLowerCase().includes(q) ||
      c.currency.toLowerCase().includes(q),
    );
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  form = new FormGroup({
    role: new FormControl('', Validators.required),
    organization: new FormControl(''),
    currency: new FormControl(BASE_CURRENCY, Validators.required),
    costRate: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
    billRate: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
  });

  // Proactive duplicate guard (mirrors the server's uniqueness rule): at most one
  // card per role + organization + currency. A null/'' organization is the single
  // "All organizations" key. The record being edited is excluded.
  private formRole = toSignal(this.form.controls.role.valueChanges, { initialValue: this.form.controls.role.value });
  private formOrg = toSignal(this.form.controls.organization.valueChanges, { initialValue: this.form.controls.organization.value });
  private formCurrency = toSignal(this.form.controls.currency.valueChanges, { initialValue: this.form.controls.currency.value });
  duplicateExists = computed<boolean>(() => {
    const role = this.formRole();
    if (!role) return false;
    const org = this.formOrg() ?? '';
    const currency = this.formCurrency() ?? '';
    const editId = this.editingId();
    return this.items().some(c => c.id !== editId && c.role === role && (c.organization ?? '') === org && c.currency === currency);
  });

  // ORPHAN VALUES: a stored role/org not in the catalog stays selectable (disabled).
  private editingRole = signal('');
  orphanRole = computed<string | null>(() => {
    const current = this.editingRole();
    if (!current) return null;
    return this.roleOptions().some(r => r.name === current) ? null : current;
  });
  private editingOrg = signal('');
  orphanOrg = computed<string | null>(() => {
    const current = this.editingOrg();
    if (!current) return null;
    return this.orgOptions().some(o => o.name === current) ? null : current;
  });

  openForm(it?: RateCard) {
    if (it) {
      this.editingId.set(it.id);
      this.editingRole.set(it.role ?? '');
      this.editingOrg.set(it.organization ?? '');
      this.form.reset({
        role: it.role,
        organization: it.organization ?? '',
        currency: it.currency || BASE_CURRENCY,
        costRate: it.costRate ?? null,
        billRate: it.billRate ?? null,
      });
    } else {
      this.editingId.set(null);
      this.editingRole.set('');
      this.editingOrg.set('');
      this.form.reset({ role: '', organization: '', currency: BASE_CURRENCY, costRate: null, billRate: null });
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.reset({ role: '', organization: '', currency: BASE_CURRENCY, costRate: null, billRate: null });
  }

  save() {
    if (!this.form.valid) return;
    const raw = this.form.getRawValue();
    const payload: Partial<RateCard> = {
      role: raw.role ?? '',
      organization: raw.organization ?? '',
      currency: raw.currency ?? BASE_CURRENCY,
      costRate: raw.costRate == null ? undefined : Number(raw.costRate),
      billRate: raw.billRate == null ? undefined : Number(raw.billRate),
    };
    const id = this.editingId();
    const done = () => { this.itemsRes.reload(); this.closeForm(); this.notifications.show('Rate card saved.', 'success'); };
    // Surface the server's reason (e.g. the uniqueness conflict) rather than a generic message.
    const fail = (e: unknown) => this.notifications.show((e as { error?: { error?: string } })?.error?.error || 'Could not save the rate card.', 'error');
    if (id) {
      this.api.updateRateCard(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: done, error: fail });
    } else {
      this.api.createRateCard(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: done, error: fail });
    }
  }

  deleteItem(id: string) { this.deletingId.set(id); }

  confirmDelete() {
    const id = this.deletingId();
    if (!id) return;
    this.api.deleteRateCard(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.itemsRes.reload();
      this.deletingId.set(null);
      this.notifications.show('Rate card deleted.', 'success');
    });
  }

  cancelDelete() { this.deletingId.set(null); }
}
