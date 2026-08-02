import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Resource, ProjectRole, Country, City, ResourceOrganization, RateCard, Vendor } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { ListStateComponent } from '../shared/list-state.component';
import { ResourceKindBadgeComponent, RESOURCE_KIND_LABELS } from '../shared/resource-kind-badge.component';
import { RESOURCE_KINDS, kindOf, type ResourceKind } from '../services/resource-kind.util';

/** Today as an ISO 'YYYY-MM-DD' string, used for status derivation + the terminate default. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Allowed location sentinel for fully-remote staff (mirrors the server + seed). */
const REMOTE_LOCATION = 'Remote';

/**
 * People management screen — the full RESOURCE (employee) lifecycle:
 *   - LIST (visualizzazione): every resource with an Active/Terminated badge
 *     derived from terminationDate, plus an "Active only / All" filter toggle.
 *   - CREATE (creazione): onboard a new employee (hireDate required).
 *   - EDIT (modifica): edit master data (NOT utilization — that's derived server-side).
 *   - TERMINATE (cessazione logica): set terminationDate (logical deletion, never
 *     a hard delete); REACTIVATE clears it.
 *
 * Follows the established config-CRUD idiom (manage-cost-centers): signals +
 * OnPush + rxResource keyed on auth.authReady (resources is a principal-gated
 * read), ModalDialogDirective for dialogs, ListStateComponent for load/error,
 * semantic Ledger tokens + command-* primitives only.
 */
@Component({
  selector: 'app-resources',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective, ListStateComponent, ResourceKindBadgeComponent],
  template: `
    <div class="max-w-6xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <div class="command-section-label">Resource Control</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Resources</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">Onboard, view, edit and terminate employees (assunzione &amp; cessazione).</p>
        </div>
        <button type="button" (click)="openForm()" class="command-button">
          <mat-icon class="text-sm">person_add</mat-icon> New employee
        </button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="p-4 border-b border-[var(--cc-line)] flex flex-col sm:flex-row gap-4 bg-[var(--cc-panel-muted)]">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">search</mat-icon>
            <input type="text" placeholder="Search resources..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   aria-label="Search resources"
                   class="w-full pl-10 pr-4 py-2 bg-surface focus:bg-surface border border-line-strong rounded-xl text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/25 transition-all outline-none">
          </div>
          <label class="inline-flex items-center gap-2 text-sm font-medium text-ink-secondary select-none">
            <input type="checkbox" [ngModel]="activeOnly()" (ngModelChange)="activeOnly.set($event)"
                   aria-label="Show active resources only"
                   class="size-4 rounded border-line-strong text-accent focus:ring-2 focus:ring-accent/25">
            Active only
          </label>
          <!-- Kind filter (C1): isolate internal / dummy / subco rows. -->
          <select [ngModel]="kindFilter()" (ngModelChange)="kindFilter.set($event)"
                  aria-label="Filter by kind" class="command-select sm:w-52">
            <option value="">All kinds</option>
            @for (opt of resourceKindOptions; track opt.value) {
              <option [value]="opt.value">{{ opt.label }}</option>
            }
          </select>
        </div>

        <app-list-state
          [loading]="resourcesRes.isLoading()"
          [error]="resourcesRes.status() === 'error'"
          skeleton="table-rows" [rows]="6" [columns]="6"
          label="resources"
          (retry)="resourcesRes.reload()">
          <table class="command-data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Organization</th>
                <th>Location</th>
                <th class="text-right">Capacity (h/wk)</th>
                <th>Hire date</th>
                <th>Status</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (r of filteredResources(); track r.id) {
                <tr>
                  <td class="font-bold">
                    <span class="inline-flex items-center gap-2">
                      {{ r.name }}
                      <app-resource-kind-badge [kind]="r.kind" />
                    </span>
                  </td>
                  <td>{{ r.role }}</td>
                  <td>{{ r.organization || '—' }}</td>
                  <td>{{ r.location || '—' }}</td>
                  <td class="text-right tabular-nums">{{ r.capacity }}</td>
                  <td class="tabular-nums">{{ r.hireDate || '—' }}</td>
                  <td>
                    @if (isTerminated(r)) {
                      <span class="command-chip is-neutral" [title]="'Terminated ' + r.terminationDate">
                        Terminated
                      </span>
                    } @else {
                      <span class="command-chip is-positive">Active</span>
                    }
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <button type="button" (click)="openForm(r)" [attr.aria-label]="'Edit ' + r.name" [attr.title]="'Edit ' + r.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                    </button>
                    @if (isTerminated(r)) {
                      <button type="button" (click)="reactivate(r)" [attr.aria-label]="'Reactivate ' + r.name" [attr.title]="'Reactivate ' + r.name" class="text-ink-muted hover:text-positive-text transition-colors p-1 ml-2">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">restart_alt</mat-icon>
                      </button>
                    } @else {
                      <button type="button" (click)="askTerminate(r)" [attr.aria-label]="'Terminate ' + r.name" [attr.title]="'Terminate contract for ' + r.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">person_off</mat-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
              @if (filteredResources().length === 0) {
                <tr>
                  <td colspan="8" class="text-center"><span class="text-[var(--cc-muted)]">No resources match the current filter.</span></td>
                </tr>
              }
            </tbody>
          </table>
        </app-list-state>
      </div>

      <!-- Create / Edit Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="resourceModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="resourceModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit employee' : 'New employee' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <form [formGroup]="form" (ngSubmit)="save()" class="p-6 space-y-4 overflow-y-auto">
              <div>
                <label for="res-name" class="block text-sm font-medium text-ink-secondary mb-1">Name *</label>
                <input id="res-name" type="text" formControlName="name" class="command-input" placeholder="e.g. Maria Rossi"
                       [attr.aria-invalid]="invalid('name')">
                @if (invalid('name')) {
                  <p role="alert" class="mt-1 text-xs text-critical-text">Name is required.</p>
                }
              </div>

              <div>
                <label for="res-role" class="block text-sm font-medium text-ink-secondary mb-1">Role *</label>
                <select id="res-role" formControlName="role" class="command-select"
                        [attr.aria-invalid]="invalid('role')">
                  <option value="" disabled>Select a role...</option>
                  @for (role of roleOptions(); track role.id) {
                    <option [value]="role.name">{{ role.name }}</option>
                  }
                  <!-- ORPHAN VALUE: a stored role not in the catalog stays selectable as a
                       disabled "(not in catalog)" option so editing never silently wipes it. -->
                  @if (orphanRole(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
                @if (invalid('role')) {
                  <p role="alert" class="mt-1 text-xs text-critical-text">Role is required.</p>
                }
              </div>

              <div>
                <label for="res-kind" class="block text-sm font-medium text-ink-secondary mb-1">Kind *</label>
                <!-- Resource kind (C1): 'internal' is a real employee; 'dummy' is a
                     placeholder awaiting hire; 'subco' is an external collaborator
                     tied to a vendor (the field below, shown only for 'subco'). -->
                <select id="res-kind" formControlName="kind" class="command-select">
                  @for (opt of resourceKindOptions; track opt.value) {
                    <option [value]="opt.value">{{ opt.label }}</option>
                  }
                </select>
              </div>

              @if (kindValue() === 'subco') {
                <div>
                  <label for="res-vendor" class="block text-sm font-medium text-ink-secondary mb-1">Vendor *</label>
                  <!-- Vendor is a config FK bound to the vendors catalog by ID, required
                       exactly when kind is 'subco' (validator toggled dynamically —
                       see the constructor). -->
                  <select id="res-vendor" data-test="res-vendor" formControlName="vendorId" class="command-select"
                          [attr.aria-invalid]="invalid('vendorId')">
                    <option value="">Select a vendor...</option>
                    @for (v of vendorOptions(); track v.id) {
                      <option [value]="v.id">{{ v.name }}</option>
                    }
                    @if (orphanVendorId(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                  @if (invalid('vendorId')) {
                    <p role="alert" class="mt-1 text-xs text-critical-text">A vendor is required for a subcontractor.</p>
                  }
                </div>
              }

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="res-org" class="block text-sm font-medium text-ink-secondary mb-1">Organization</label>
                  <!-- Resource organization is a config FK, bound to the resource-organizations
                       catalog by NAME (the stored value). Optional. -->
                  <select id="res-org" formControlName="organization" class="command-select">
                    <option value="">Unassigned</option>
                    @for (org of orgOptions(); track org.id) {
                      <option [value]="org.name">{{ org.name }}</option>
                    }
                    @if (orphanOrg(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
                <div>
                  <label for="res-country" class="block text-sm font-medium text-ink-secondary mb-1">Country</label>
                  <!-- Location = Country + City. Country filters the City list; the stored
                       value is the City NAME (the 'location' field). 'Remote' is a sentinel
                       location (no country/city). Optional. -->
                  <select id="res-country" [ngModel]="locationCountry()" (ngModelChange)="onCountryChange($event)" [ngModelOptions]="{ standalone: true }" class="command-select">
                    <option value="">— No country —</option>
                    <option value="__REMOTE__">Remote</option>
                    @for (c of countryOptions(); track c.code) {
                      <option [value]="c.code">{{ c.name }}</option>
                    }
                  </select>
                </div>
              </div>

              @if (locationCountry() && locationCountry() !== '__REMOTE__') {
                <div>
                  <label for="res-loc" class="block text-sm font-medium text-ink-secondary mb-1">City</label>
                  <select id="res-loc" formControlName="location" class="command-select">
                    <option value="">Select a city...</option>
                    @for (city of citiesForCountry(); track city.id) {
                      <option [value]="city.name">{{ city.name }}</option>
                    }
                    @if (orphanCity(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
              }

              <div>
                <label for="res-manager" class="block text-sm font-medium text-ink-secondary mb-1">People Manager</label>
                <!-- The People Manager (managerId) is another resource. Only ACTIVE
                     resources are eligible, and never this resource itself. Optional. -->
                <select id="res-manager" formControlName="managerId" class="command-select">
                  <option value="">Unassigned</option>
                  @for (m of managerOptions(); track m.id) {
                    <option [value]="m.id">{{ m.name }}</option>
                  }
                  @if (orphanManager(); as orphan) {
                    <option [value]="orphan.id" disabled>{{ orphan.name }} (not selectable)</option>
                  }
                </select>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="res-capacity" class="block text-sm font-medium text-ink-secondary mb-1">Capacity (h/wk) *</label>
                  <input id="res-capacity" type="number" min="1" step="1" formControlName="capacity" class="command-input" placeholder="e.g. 40"
                         [attr.aria-invalid]="invalid('capacity')">
                  @if (invalid('capacity')) {
                    <p role="alert" class="mt-1 text-xs text-critical-text">Capacity must be a positive number.</p>
                  }
                </div>
                <div>
                  <label for="res-hire" class="block text-sm font-medium text-ink-secondary mb-1">Hire date *</label>
                  <input id="res-hire" type="date" formControlName="hireDate" class="command-input"
                         [attr.aria-invalid]="invalid('hireDate')">
                  @if (invalid('hireDate')) {
                    <p role="alert" class="mt-1 text-xs text-critical-text">Hire date is required.</p>
                  }
                </div>
              </div>

              <!-- RATE CARDS (Phase E): cost/bill default to the role's rate card.
                   Leaving an input empty INHERITS the card; a typed value OVERRIDES it. -->
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="res-cost" class="block text-sm font-medium text-ink-secondary mb-1">Cost rate (€/gg)</label>
                  <input id="res-cost" type="number" min="0" step="1" formControlName="costRateOverride" class="command-input"
                         [placeholder]="inheritedRate() ? ('Inherited: ' + inheritedRate()!.costRate) : 'e.g. 600'">
                </div>
                <div>
                  <label for="res-bill" class="block text-sm font-medium text-ink-secondary mb-1">Bill rate (€/gg)</label>
                  <input id="res-bill" type="number" min="0" step="1" formControlName="billRateOverride" class="command-input"
                         [placeholder]="inheritedRate() ? ('Inherited: ' + inheritedRate()!.billRate) : 'e.g. 1120'">
                </div>
              </div>
              @if (inheritedRate(); as ir) {
                <p class="-mt-2 text-xs text-[var(--cc-muted)]">
                  Leave empty to inherit the <strong class="text-ink-secondary">{{ form.controls.role.value }}</strong>
                  rate card (cost {{ ir.costRate }} · bill {{ ir.billRate }} {{ ir.currency }}/giorno). Enter a value to override.
                </p>
              } @else if (form.controls.role.value) {
                <p class="-mt-2 text-xs text-[var(--cc-muted)]">No rate card for this role — enter cost/bill rates manually, or define one under Configuration → Rate Cards.</p>
              }

              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="form.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ editingId() ? 'Save changes' : 'Create employee' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }

      <!-- Terminate (cessazione logica) Confirmation Modal -->
      @if (terminating(); as t) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="resourceTerminateTitle" (dismiss)="cancelTerminate()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">person_off</mat-icon>
              </div>
              <h3 id="resourceTerminateTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Terminate contract</h3>
              <p class="text-[var(--cc-muted)] text-sm">End the contract for <strong class="text-ink">{{ t.name }}</strong>. The resource is marked Terminated (logical deletion) and can be reactivated later.</p>
              <div class="mt-4 text-left">
                <label for="res-term-date" class="block text-sm font-medium text-ink-secondary mb-1">Termination date</label>
                <input id="res-term-date" type="date" [ngModel]="terminationDate()" (ngModelChange)="terminationDate.set($event)" class="command-input">
              </div>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelTerminate()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmTerminate()" [disabled]="!terminationDate()" class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">Terminate contract</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class ResourcesComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  // resources is a principal-gated read: key on authReady so it fires only after
  // the OAuth bootstrap settles and the bearer is attached (firing earlier 401s
  // and latches the list empty — same fix as the other screens).
  protected readonly resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resources = this.resourcesRes.value;

  // Role option source: the canonical /project-roles catalog. Stored value = name
  // (see reference-data-integrity plan, Phase A). Open read but keyed on authReady
  // to mirror the other gated config reads on this screen.
  protected readonly rolesRes = rxResource<ProjectRole[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjectRoles() : of<ProjectRole[]>([])),
    defaultValue: [] as ProjectRole[],
  });
  roleOptions = this.rolesRes.value;

  // ORPHAN VALUE: when editing a resource whose stored role isn't in the catalog
  // (e.g. legacy free-text data), expose it so the select can still show it and a
  // save doesn't silently discard it. null when the current value is a catalog name.
  orphanRole = computed<string | null>(() => {
    const current = this.editingRole();
    if (!current) return null;
    return this.roleOptions().some(r => r.name === current) ? null : current;
  });
  /** The role value currently loaded into the form (drives orphan detection). */
  private editingRole = signal<string>('');

  // Location = Country + City and Organization are config FKs (Phase F2). All three
  // option sources are open reads but keyed on authReady to mirror the gated reads.
  protected readonly countriesRes = rxResource<Country[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCountries() : of<Country[]>([])),
    defaultValue: [] as Country[],
  });
  countryOptions = this.countriesRes.value;
  protected readonly citiesRes = rxResource<City[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCities() : of<City[]>([])),
    defaultValue: [] as City[],
  });
  cityOptions = this.citiesRes.value;
  protected readonly orgsRes = rxResource<ResourceOrganization[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResourceOrganizations() : of<ResourceOrganization[]>([])),
    defaultValue: [] as ResourceOrganization[],
  });
  orgOptions = this.orgsRes.value;

  // RATE CARDS (Phase E): the role's default cost/bill rates. The cost/bill inputs
  // are per-resource OVERRIDES — empty inherits the matching card. We surface the
  // inherited value as a placeholder/hint so the default is visible before saving.
  protected readonly rateCardsRes = rxResource<RateCard[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getRateCards() : of<RateCard[]>([])),
    defaultValue: [] as RateCard[],
  });
  rateCards = this.rateCardsRes.value;

  // VENDOR (C1): the catalog a 'subco' resource's vendorId references. Open read,
  // gated on authReady like the other config catalogs above.
  protected readonly vendorsRes = rxResource<Vendor[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getVendors() : of<Vendor[]>([])),
    defaultValue: [] as Vendor[],
  });
  vendorOptions = this.vendorsRes.value;

  // The selected country in the location picker. '' = none, '__REMOTE__' = the Remote
  // sentinel (stored location 'Remote'); else an ISO-2 country code filtering the city
  // list. A manual override (null = "derive from the stored location") lets the user
  // change the country interactively while editing without losing the initial derive,
  // which matters because the cities list loads async after openForm() runs.
  private countryOverride = signal<string | null>(null);
  locationCountry = computed<string>(() => {
    const override = this.countryOverride();
    if (override !== null) return override;
    return this.countryForLocation(this.editingLocation());
  });
  /** Cities belonging to the selected country (the City select option list). */
  citiesForCountry = computed<City[]>(() => {
    const code = this.locationCountry();
    if (!code || code === '__REMOTE__') return [];
    return this.cityOptions().filter(c => c.countryCode === code);
  });

  // ORPHAN VALUE: a stored location/city not in the catalog stays selectable as a
  // disabled "(not in catalog)" option (drives off the form's location value).
  private editingLocation = signal<string>('');
  orphanCity = computed<string | null>(() => {
    const current = this.editingLocation();
    if (!current || current === REMOTE_LOCATION) return null;
    return this.cityOptions().some(c => c.name === current) ? null : current;
  });

  // ORPHAN VALUE: a stored organization name not in the catalog stays selectable.
  private editingOrg = signal<string>('');
  orphanOrg = computed<string | null>(() => {
    const current = this.editingOrg();
    if (!current) return null;
    return this.orgOptions().some(o => o.name === current) ? null : current;
  });

  // ORPHAN VALUE: a stored vendorId not in the catalog (e.g. the vendor was
  // deleted) stays selectable as a disabled option. Unlike organization/city/role
  // above, vendor is keyed by ID rather than name, so there is no catalog-independent
  // display name to recover for a vendor that's gone — the raw id is shown, same as
  // those name-keyed fields show their raw stored value when it's no longer listed.
  private editingVendorId = signal<string>('');
  orphanVendorId = computed<string | null>(() => {
    const current = this.editingVendorId();
    if (!current) return null;
    return this.vendorOptions().some(v => v.id === current) ? null : current;
  });

  // PEOPLE MANAGER (allocation-approval workflow): managerId points at another
  // resource. The dropdown offers only ACTIVE resources (terminated excluded) and
  // never the resource being edited (nobody manages themselves). Sorted by name.
  managerOptions = computed<Resource[]>(() => {
    const editingId = this.editingId();
    return this.resources()
      .filter(r => !this.isTerminated(r) && r.id !== editingId)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  // ORPHAN VALUE: when editing, a stored managerId that isn't in the active option
  // list (e.g. the manager has since been terminated) stays selectable as a disabled
  // option so saving never silently drops it.
  private editingManagerId = signal<string>('');
  orphanManager = computed<Resource | null>(() => {
    const current = this.editingManagerId();
    if (!current) return null;
    if (this.managerOptions().some(r => r.id === current)) return null;
    return this.resources().find(r => r.id === current) ?? null;
  });

  /** Derive the country/Remote selection from a stored city/sentinel location value. */
  private countryForLocation(location: string): string {
    if (!location) return '';
    if (location === REMOTE_LOCATION) return '__REMOTE__';
    const city = this.cityOptions().find(c => c.name === location);
    return city ? city.countryCode : '';
  }

  /** Country select change: 'Remote' stores the sentinel; otherwise clear the city. */
  onCountryChange(code: string) {
    this.countryOverride.set(code);
    if (code === '__REMOTE__') {
      this.form.controls.location.setValue(REMOTE_LOCATION);
    } else {
      // Switching/clearing the country invalidates any previously chosen city.
      this.form.controls.location.setValue('');
    }
    this.editingLocation.set(this.form.controls.location.value ?? '');
  }

  search = signal('');
  /** "Active only" filter toggle — true by default (terminated rows hidden). */
  activeOnly = signal(true);
  /** Kind filter (C1): '' = all kinds; otherwise isolate internal/dummy/subco rows. */
  kindFilter = signal<'' | ResourceKind>('');
  /** Kind `<select>` option list (value + readable label), shared by the kind filter and the form's kind select. */
  protected readonly resourceKindOptions: { value: ResourceKind; label: string }[] =
    RESOURCE_KINDS.map(k => ({ value: k, label: RESOURCE_KIND_LABELS[k] }));

  filteredResources = computed(() => {
    const q = this.search().toLowerCase();
    const activeOnly = this.activeOnly();
    const kind = this.kindFilter();
    return this.resources().filter(r => {
      if (activeOnly && this.isTerminated(r)) return false;
      if (kind && kindOf(r) !== kind) return false;
      return [r.name, r.role, r.organization, r.location].some(
        v => (v ?? '').toLowerCase().includes(q),
      );
    });
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);

  // Terminate (cessazione) confirm flow: the resource being terminated + a date.
  terminating = signal<Resource | null>(null);
  terminationDate = signal<string>(todayIso());

  form = new FormGroup({
    name: new FormControl('', Validators.required),
    role: new FormControl('', Validators.required),
    managerId: new FormControl(''),
    organization: new FormControl(''),
    location: new FormControl(''),
    capacity: new FormControl<number | null>(40, [Validators.required, Validators.min(1)]),
    // Per-resource rate OVERRIDES (Phase E). null/empty = inherit the role's rate card.
    costRateOverride: new FormControl<number | null>(null),
    billRateOverride: new FormControl<number | null>(null),
    hireDate: new FormControl('', Validators.required),
    // C1: resource kind + the vendor FK, required only for 'subco'. The
    // required-ness is wired dynamically in the constructor below (kind's
    // valueChanges), not as a static validator here — see that comment for why.
    kind: new FormControl<ResourceKind>('internal', { nonNullable: true }),
    vendorId: new FormControl(''),
  });

  // Live role/organization values drive the inherited-rate lookup as the user edits.
  private roleValue = toSignal(this.form.controls.role.valueChanges, { initialValue: this.form.controls.role.value });
  private orgValue = toSignal(this.form.controls.organization.valueChanges, { initialValue: this.form.controls.organization.value });
  /** The rate card matching the current role+org (org-specific wins over generic). */
  inheritedRate = computed<RateCard | null>(() => {
    const role = this.roleValue();
    const org = this.orgValue();
    if (!role) return null;
    const forRole = this.rateCards().filter(c => c.role === role && (c.currency ?? 'EUR') === 'EUR');
    return forRole.find(c => c.organization && c.organization === org) ?? forRole.find(c => !c.organization) ?? null;
  });

  // Live kind value drives the vendor field's visibility in the template (C1).
  protected readonly kindValue = toSignal(this.form.controls.kind.valueChanges, { initialValue: this.form.controls.kind.value });

  constructor() {
    // C1: vendorId must be required exactly when kind === 'subco', and react
    // when the user switches kind — a validator set once at construction
    // wouldn't. Chosen approach: subscribe to kind's valueChanges and toggle
    // Validators.required on vendorId directly (rather than a form-level
    // cross-field validator), because the invalid state needs to live on the
    // vendorId CONTROL itself — that's what the template's invalid('vendorId')
    // check and the vendor select's aria-invalid read, and what the tests
    // assert via form.controls.vendorId.valid. RxJS's valueChanges emits
    // synchronously on setValue, so this takes effect immediately with no
    // extra change-detection plumbing.
    this.form.controls.kind.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(kind => {
      const vendorId = this.form.controls.vendorId;
      if (kind === 'subco') {
        vendorId.setValidators(Validators.required);
      } else {
        vendorId.clearValidators();
        // A non-subco resource must not carry a vendor (the server REFUSES it) —
        // clear any selection made before the user switched kind away from subco.
        if (vendorId.value) vendorId.setValue('', { emitEvent: false });
      }
      vendorId.updateValueAndValidity({ emitEvent: false });
    });
  }

  /** A resource is Terminated when terminationDate is set to a date on/before today. */
  isTerminated(r: Resource): boolean {
    return !!r.terminationDate && r.terminationDate <= todayIso();
  }

  /** Whether a control should show its inline error (touched/dirty + invalid). */
  invalid(name: 'name' | 'role' | 'capacity' | 'hireDate' | 'vendorId'): boolean {
    const c = this.form.get(name);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  openForm(r?: Resource) {
    if (r) {
      this.editingId.set(r.id);
      this.editingRole.set(r.role ?? '');
      this.editingLocation.set(r.location ?? '');
      this.editingOrg.set(r.organization ?? '');
      this.editingManagerId.set(r.managerId ?? '');
      this.editingVendorId.set(r.vendorId ?? '');
      this.countryOverride.set(null); // derive country from the stored location
      this.form.reset({
        name: r.name,
        role: r.role,
        managerId: r.managerId ?? '',
        organization: r.organization ?? '',
        location: r.location ?? '',
        capacity: r.capacity ?? 40,
        // Show the stored OVERRIDE only; an inheriting resource leaves these empty
        // so the rate-card default surfaces as the placeholder hint.
        costRateOverride: r.costRateOverride ?? null,
        billRateOverride: r.billRateOverride ?? null,
        hireDate: r.hireDate ?? '',
        kind: kindOf(r),
        vendorId: r.vendorId ?? '',
      });
    } else {
      this.editingId.set(null);
      this.editingRole.set('');
      this.editingLocation.set('');
      this.editingOrg.set('');
      this.editingManagerId.set('');
      this.editingVendorId.set('');
      this.countryOverride.set('');
      this.form.reset({ name: '', role: '', managerId: '', organization: '', location: '', capacity: 40, costRateOverride: null, billRateOverride: null, hireDate: '', kind: 'internal', vendorId: '' });
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.reset();
  }

  save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue();
    // utilization is NOT sent — it is derived server-side from assignments.
    const payload: Partial<Resource> = {
      name: raw.name ?? '',
      role: raw.role ?? '',
      // '' = unassigned (clears any previously-set People Manager).
      managerId: raw.managerId ?? '',
      organization: raw.organization ?? '',
      location: raw.location ?? '',
      capacity: Number(raw.capacity),
      // Phase E: send the rate OVERRIDES. null = inherit the role's rate card; the
      // server maps these onto the cost_rate/bill_rate columns.
      costRateOverride: raw.costRateOverride == null ? null : Number(raw.costRateOverride),
      billRateOverride: raw.billRateOverride == null ? null : Number(raw.billRateOverride),
      hireDate: raw.hireDate ?? '',
      // C1: kind + vendor. vendorId is cleared to '' whenever kind isn't 'subco'
      // (see the constructor), so it's always safe to send as-is — the server
      // normalises an empty string to absent.
      kind: raw.kind,
      vendorId: raw.vendorId ?? '',
    };
    const id = this.editingId();
    const op = id ? this.api.updateResource(id, payload) : this.api.createResource(payload);
    op.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.notifications.show(id ? 'Resource updated' : 'Employee onboarded', 'success');
        this.resourcesRes.reload();
        this.closeForm();
      },
      error: () => this.notifications.show('Could not save the resource', 'error'),
    });
  }

  askTerminate(r: Resource) {
    this.terminating.set(r);
    this.terminationDate.set(todayIso());
  }

  cancelTerminate() {
    this.terminating.set(null);
  }

  confirmTerminate() {
    const r = this.terminating();
    const date = this.terminationDate();
    if (!r || !date) return;
    this.api.updateResource(r.id, { terminationDate: date }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.notifications.show(`${r.name}'s contract terminated`, 'success');
        this.resourcesRes.reload();
        this.terminating.set(null);
      },
      error: () => this.notifications.show('Could not terminate the contract', 'error'),
    });
  }

  reactivate(r: Resource) {
    // Reactivate: clear terminationDate (send null so the server unsets it).
    this.api.updateResource(r.id, { terminationDate: null as unknown as string }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.notifications.show(`${r.name} reactivated`, 'success');
        this.resourcesRes.reload();
      },
      error: () => this.notifications.show('Could not reactivate the resource', 'error'),
    });
  }
}
