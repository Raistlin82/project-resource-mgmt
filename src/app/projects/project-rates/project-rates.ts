import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import { ApiService, BASE_CURRENCY, FxRate, NegotiatedRate, Project, ProjectRole } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

/**
 * Negotiated sell rates for a project (design spec §7). The project's own
 * table is an OVERRIDE: it lists a per-profile €/day sell price that beats the
 * rate negotiated on the project's contract for that role (see `sellRateFor`,
 * `src/app/services/sell-rate.util.ts`). Every contract-level row this project
 * does NOT override is rendered greyed out — `data-test="inherited-rate"` —
 * because that grey is what shows a margin auditor WHERE the applied price
 * comes from before anything else.
 *
 * A contract-level rate and a project override are paired on (role, currency):
 * the DB's uniqueness key is (contractId|projectId, role, currency), and
 * `sellRateFor` itself only ever consumes the base-currency (EUR) row for a
 * role, so pairing on the same two fields keeps this table's "is this
 * overridden" reading in sync with what actually prices revenue.
 */
@Component({
  selector: 'app-project-rates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ModalDialogDirective, DecimalPipe],
  template: `
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <div>
          <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Negotiated Rates</h2>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">
            Per-profile sell price for Time &amp; Materials revenue on this project. Rows inherited from the
            contract are greyed out until this project overrides them.
          </p>
        </div>
        <button type="button" (click)="openRateForm()" class="command-button">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon>
          Add Override
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="command-data-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Currency</th>
              <th class="text-right">Bill rate (€/day)</th>
              <th>Source</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (rate of projectRates(); track rate.id) {
              <tr data-test="project-rate-row">
                <td class="font-medium">{{ rate.role }}</td>
                <td class="font-mono text-ink-secondary">{{ rate.currency }}</td>
                <td class="text-right font-mono tabular-nums">{{ rate.billRate | number:'1.0-2' }}</td>
                <td>
                  <span class="command-status green">Override</span>
                  @if (rate.currency !== BASE_CURRENCY) {
                    <span class="command-status amber ml-1.5" title="sellRateFor only reads EUR-denominated rates; this row is not yet applied to any invoice.">Not applied (EUR only)</span>
                  }
                </td>
                <td class="text-right">
                  <button type="button" (click)="openRateForm(rate)" [attr.aria-label]="'Edit override for ' + rate.role" class="text-ink-muted hover:text-accent-text p-1.5 rounded-lg transition-colors">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteRate(rate)" [attr.aria-label]="'Delete override for ' + rate.role" class="text-ink-muted hover:text-critical-text p-1.5 rounded-lg transition-colors ml-1">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @for (rate of inheritedRates(); track rate.id) {
              <tr data-test="inherited-rate" class="bg-surface-muted text-ink-muted italic">
                <td class="font-medium">{{ rate.role }}</td>
                <td class="font-mono">{{ rate.currency }}</td>
                <td class="text-right font-mono tabular-nums">{{ rate.billRate | number:'1.0-2' }}</td>
                <td>
                  <span class="command-status">Inherited from contract</span>
                  @if (rate.currency !== BASE_CURRENCY) {
                    <span class="command-status amber ml-1.5" title="sellRateFor only reads EUR-denominated rates; this row is not yet applied to any invoice.">Not applied (EUR only)</span>
                  }
                </td>
                <td class="text-right">
                  <button type="button" (click)="openRateForm(undefined, rate)" [attr.aria-label]="'Override rate for ' + rate.role" class="text-ink-muted hover:text-accent-text p-1.5 rounded-lg transition-colors not-italic">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">edit</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (!projectRates().length && !inheritedRates().length) {
              <tr>
                <td colspan="5" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                  No negotiated rates apply to this project.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (showRateForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="projectRateModalTitle" (dismiss)="closeRateForm()">
        <div class="command-card w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="projectRateModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">
              {{ editingRateId() ? 'Edit Negotiated Rate' : 'Add Negotiated Rate' }}
            </h2>
            <button type="button" (click)="closeRateForm()" aria-label="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          <div class="p-6 sm:p-8 overflow-y-auto flex-1 space-y-6">
            <div>
              <label for="projectRateRole" class="block text-sm font-semibold text-ink-secondary mb-1.5">Role *</label>
              <!-- Never [value] on a <select> whose <option>s come from an @for — the
                   write lands before Angular has inserted the options and is silently
                   dropped. Per-option [selected], driven by a plain (change) handler. -->
              <select id="projectRateRole" (change)="onRateRoleChange($event)" class="command-select">
                <option value="" [selected]="rateRole() === ''">Select a role...</option>
                @for (role of roleOptions(); track role) {
                  <option [value]="role" [selected]="role === rateRole()">{{ role }}</option>
                }
              </select>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="projectRateCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                <select id="projectRateCurrency" (change)="onRateCurrencyChange($event)" class="command-select">
                  @for (code of currencyOptions(); track code) {
                    <option [value]="code" [selected]="code === rateCurrency()">{{ code }}</option>
                  }
                </select>
              </div>
              <div>
                <label for="projectRateBillRate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Bill rate (€/day) *</label>
                <input id="projectRateBillRate" type="number" min="0" step="1" [value]="rateBillRate()" (input)="onRateBillRateChange($event)" class="command-input" placeholder="e.g. 1000">
              </div>
            </div>
            @if (rateError(); as err) {
              <p role="alert" data-test="negotiated-rate-error" class="text-xs text-critical-text">{{ err }}</p>
            }
          </div>
          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeRateForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="saveRate()" [disabled]="!rateFormValid()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              Save Rate
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ProjectRates {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notification = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  /** Exposed for the template's "not applied" check — sellRateFor only ever reads a BASE_CURRENCY row. */
  readonly BASE_CURRENCY = BASE_CURRENCY;

  projectId = input<string>();

  // getProjects is an OPEN read (no principal gate) — leave ungated; needed
  // here only to look up this project's OWN contractId.
  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private project = computed<Project | undefined>(() => this.projectsRes.value().find(p => p.id === this.projectId()));

  // /negotiated-rates is principal-gated to the commercial role set
  // (sales/finance/delivery-executive/admin — src/server.ts, same rule as
  // /orders and /order-lines). Gate on canManageCommercial() too, not just
  // authReady(), so a non-commercial role (e.g. an employee viewing this
  // project's tab) never fires a request that 403s and toasts.
  private negotiatedRatesRes = rxResource<NegotiatedRate[], boolean>({
    params: () => this.auth.authReady() && this.auth.canManageCommercial(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getNegotiatedRates() : of<NegotiatedRate[]>([])),
    defaultValue: [] as NegotiatedRate[],
  });
  private negotiatedRates = this.negotiatedRatesRes.value;

  // ROLE OPTIONS COME FROM THE PROJECT-ROLES CATALOG — the SAME authority the
  // server validates a rate's role against (validateRoleRefs, src/server.ts),
  // widened to the catalog this wave precisely so a price can be negotiated
  // BEFORE anyone with that profile is hired. Building the picker from
  // `resources.map(r => r.role)` made that workflow unreachable from the UI
  // (hand-posting to the API was the only way) while the shipped SOP described
  // it. It also read a collection this screen's own audience cannot always see:
  // /resources is gated to the staffing roles, which EXCLUDES `sales` — one of
  // the roles allowed to manage negotiated rates — so for a sales user the old
  // picker was empty AND fired a 403. /project-roles is an open read.
  private rolesRes = rxResource<ProjectRole[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjectRoles() : of<ProjectRole[]>([])),
    defaultValue: [] as ProjectRole[],
  });
  private fxRatesRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [] as FxRate[],
  });

  /** Catalog role NAMES — the stored value on a rate, matching what the server checks. */
  roleOptions = computed<string[]>(() => [...new Set(this.rolesRes.value().map(r => r.name))].sort());
  currencyOptions = computed<string[]>(() => [...new Set([BASE_CURRENCY, ...this.fxRatesRes.value().map(r => r.currency)])]);

  /**
   * This project's own override rows — full CRUD, never greyed.
   *
   * MEMBERSHIP IS DECIDED BY THE FIELD, NEVER BY TWO ABSENCES AGREEING. This
   * tab renders even with no resolved project (the tab strip in
   * project-details.ts sits outside its `@if (project(); as p)`), so
   * `projectId()` — an `input<string>()` with no default — can be `undefined`;
   * a CONTRACT-level rate has no `projectId` either. Written as
   * `r.projectId === this.projectId()` the filter therefore matched
   * `undefined === undefined` and claimed every contract-scoped rate in the
   * system as this project's own override, complete with a live edit and a
   * DELETE wired to the real contract rate's id — one click from destroying a
   * negotiated contract price from a phantom project's tab. No project, no
   * overrides.
   */
  projectRates = computed(() => {
    const pId = this.projectId();
    if (!pId) return [];
    return this.negotiatedRates().filter(r => r.projectId === pId);
  });

  /** Every rate on this project's contract (empty when the project has no contract). */
  private contractRatesForProject = computed<NegotiatedRate[]>(() => {
    const contractId = this.project()?.contractId;
    if (!contractId) return [];
    return this.negotiatedRates().filter(r => r.contractId === contractId);
  });

  /**
   * Contract-level rows this project does NOT override, paired on (role,
   * currency) — the requirement that matters (design spec §7): shows where
   * the applied price comes from. A row disappears from here the instant a
   * matching project override exists (see the paired absence assertion in
   * project-rates.spec.ts).
   */
  inheritedRates = computed<NegotiatedRate[]>(() => {
    const overrides = this.projectRates();
    return this.contractRatesForProject().filter(
      contractRate => !overrides.some(o => o.role === contractRate.role && o.currency === contractRate.currency),
    );
  });

  showRateForm = signal(false);
  editingRateId = signal<string | null>(null);
  rateRole = signal('');
  rateCurrency = signal(BASE_CURRENCY);
  rateBillRate = signal<number | null>(null);
  rateError = signal<string | null>(null);

  rateFormValid = computed(() => !!this.rateRole() && !!this.rateCurrency() && this.rateBillRate() !== null && this.rateBillRate()! >= 0);

  onRateRoleChange(event: Event): void {
    this.rateRole.set((event.target as HTMLSelectElement).value);
  }

  onRateCurrencyChange(event: Event): void {
    this.rateCurrency.set((event.target as HTMLSelectElement).value);
  }

  onRateBillRateChange(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.rateBillRate.set(raw === '' ? null : Number(raw));
  }

  /**
   * `existing` opens the edit form for one of THIS project's own override
   * rows. `seed` opens the ADD form pre-filled from an inherited (contract)
   * row — role/currency/starting price — so overriding one is a single edit
   * away rather than retyping the key.
   */
  openRateForm(existing?: NegotiatedRate, seed?: NegotiatedRate): void {
    this.rateError.set(null);
    if (existing) {
      this.editingRateId.set(existing.id);
      this.rateRole.set(existing.role);
      this.rateCurrency.set(existing.currency);
      this.rateBillRate.set(existing.billRate);
    } else {
      this.editingRateId.set(null);
      // Plain "Add Override" (no seed) must force an explicit role pick — defaulting to
      // roleOptions()[0] let a user save a rate keyed to the wrong role without noticing
      // (Task 5 review, Finding 2). Only the seeded-from-an-inherited-row path pre-fills.
      this.rateRole.set(seed?.role ?? '');
      this.rateCurrency.set(seed?.currency ?? BASE_CURRENCY);
      this.rateBillRate.set(seed?.billRate ?? null);
    }
    this.showRateForm.set(true);
  }

  closeRateForm(): void {
    this.showRateForm.set(false);
    this.editingRateId.set(null);
    this.rateError.set(null);
  }

  saveRate(): void {
    if (!this.rateFormValid()) return;
    const pId = this.projectId();
    if (!pId) return;
    // projectId ONLY — contractId is never sent from this surface (spec §3's xor).
    const payload: Partial<NegotiatedRate> = {
      projectId: pId,
      role: this.rateRole(),
      currency: this.rateCurrency(),
      billRate: this.rateBillRate() ?? 0,
    };
    const id = this.editingRateId();
    const done = () => {
      this.negotiatedRatesRes.reload();
      this.notification.show('Negotiated rate saved', 'success');
      this.closeRateForm();
    };
    // Surface the server's own refusal text (400s from validateNegotiatedRate,
    // src/server.ts) INLINE, and do not close the form — the coordinator's
    // requirement, not just the generic toast the error interceptor also fires.
    const fail = (e: unknown) => {
      this.rateError.set((e as { error?: { error?: string } })?.error?.error ?? 'Could not save the negotiated rate.');
    };
    if (id) {
      this.api.updateNegotiatedRate(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: done, error: fail });
    } else {
      this.api.createNegotiatedRate(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: done, error: fail });
    }
  }

  deleteRate(rate: NegotiatedRate): void {
    this.api.deleteNegotiatedRate(rate.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.negotiatedRatesRes.reload();
      this.notification.show('Negotiated rate deleted', 'success');
    });
  }
}
