import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, City, Country } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

/** Discriminates which delete confirmation is open. */
type PendingDelete = { kind: 'country'; code: string } | { kind: 'city'; id: string } | null;

@Component({
  selector: 'app-manage-locations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective],
  template: `
    <div class="max-w-6xl mx-auto space-y-8">
      <div>
        <div class="command-section-label">Configuration</div>
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Locations</h1>
        <p class="mt-1 text-sm text-[var(--cc-muted)]">Maintain the country catalog and the cities/comuni within each country.</p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Countries -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Countries</h2>
            <button (click)="openCountryForm()" class="command-button">
              <mat-icon class="text-sm">add</mat-icon> Add Country
            </button>
          </div>
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="w-24">Code</th>
                <th>Name</th>
                <th class="text-right">Cities</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (c of countries(); track c.code) {
                <tr [class.bg-accent-tint]="selectedCountry() === c.code"
                    [attr.aria-selected]="selectedCountry() === c.code"
                    class="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    tabindex="0"
                    (click)="selectCountry(c.code)"
                    (keydown.enter)="selectCountry(c.code)"
                    (keydown.space)="selectCountry(c.code); $event.preventDefault()">
                  <td><span class="font-mono font-bold tracking-wide text-[var(--cc-primary-text)]">{{ c.code }}</span></td>
                  <td class="font-bold">{{ c.name }}</td>
                  <td class="text-right">{{ cityCount(c.code) }}</td>
                  <td class="text-right">
                    <button type="button" (click)="openCountryForm(c); $event.stopPropagation()" [attr.aria-label]="'Edit ' + c.name" [attr.title]="'Edit ' + c.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                    </button>
                    <button type="button" (click)="askDeleteCountry(c.code); $event.stopPropagation()" [attr.aria-label]="'Delete ' + c.name" [attr.title]="'Delete ' + c.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
              @if (countries().length === 0) {
                <tr><td colspan="4" class="text-center"><span class="text-[var(--cc-muted)]">No countries defined yet.</span></td></tr>
              }
            </tbody>
          </table>
        </div>

        <!-- Cities for the selected country -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">
              Cities @if (selectedCountryName(); as n) { <span class="text-[var(--cc-muted)] font-normal">— {{ n }}</span> }
            </h2>
            <button (click)="openCityForm()" [disabled]="!selectedCountry()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              <mat-icon class="text-sm">add</mat-icon> Add City
            </button>
          </div>
          @if (!selectedCountry()) {
            <div class="p-8 text-center text-sm text-[var(--cc-muted)]">Select a country to view and manage its cities.</div>
          } @else {
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (city of citiesForSelected(); track city.id) {
                  <tr>
                    <td class="font-bold">{{ city.name }}</td>
                    <td class="text-right">
                      <button type="button" (click)="openCityForm(city)" [attr.aria-label]="'Edit ' + city.name" [attr.title]="'Edit ' + city.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                      </button>
                      <button type="button" (click)="askDeleteCity(city.id)" [attr.aria-label]="'Delete ' + city.name" [attr.title]="'Delete ' + city.name" class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                      </button>
                    </td>
                  </tr>
                }
                @if (citiesForSelected().length === 0) {
                  <tr><td colspan="2" class="text-center"><span class="text-[var(--cc-muted)]">No cities for this country yet.</span></td></tr>
                }
              </tbody>
            </table>
          }
        </div>
      </div>

      <!-- Country form modal -->
      @if (showCountryForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="countryModalTitle" (dismiss)="closeCountryForm()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="command-card-header">
              <h2 id="countryModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingCountryCode() ? 'Edit Country' : 'Add Country' }}</h2>
              <button type="button" (click)="closeCountryForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <form [formGroup]="countryForm" (ngSubmit)="saveCountry()" class="p-6 space-y-4">
              <div>
                <label for="countryCode" class="block text-sm font-medium text-ink-secondary mb-1">ISO-2 Code</label>
                <input id="countryCode" type="text" formControlName="code" maxlength="2" class="command-input font-mono uppercase" placeholder="e.g. IT">
                @if (editingCountryCode()) {
                  <p class="text-[10px] font-bold text-[var(--cc-muted)] uppercase tracking-wider mt-2">The code is the identifier and cannot be changed.</p>
                }
              </div>
              <div>
                <label for="countryName" class="block text-sm font-medium text-ink-secondary mb-1">Name</label>
                <input id="countryName" type="text" formControlName="name" class="command-input" placeholder="e.g. Italy">
              </div>
              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeCountryForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!countryForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save Country</button>
              </div>
            </form>
          </div>
        </div>
      }

      <!-- City form modal -->
      @if (showCityForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="cityModalTitle" (dismiss)="closeCityForm()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="command-card-header">
              <h2 id="cityModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingCityId() ? 'Edit City' : 'Add City' }}</h2>
              <button type="button" (click)="closeCityForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <form [formGroup]="cityForm" (ngSubmit)="saveCity()" class="p-6 space-y-4">
              <div>
                <label for="cityCountry" class="block text-sm font-medium text-ink-secondary mb-1">Country</label>
                <!-- A FK reference: bound to the countries catalog by code. -->
                <select id="cityCountry" formControlName="countryCode" class="command-select">
                  <option value="" disabled>Select a country...</option>
                  @for (c of countries(); track c.code) {
                    <option [value]="c.code">{{ c.name }} ({{ c.code }})</option>
                  }
                </select>
              </div>
              <div>
                <label for="cityName" class="block text-sm font-medium text-ink-secondary mb-1">Name</label>
                <input id="cityName" type="text" formControlName="name" class="command-input" placeholder="e.g. Roma">
              </div>
              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeCityForm()" class="command-button secondary">Cancel</button>
                <button type="submit" [disabled]="!cityForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save City</button>
              </div>
            </form>
          </div>
        </div>
      }

      <!-- Delete confirmation modal (country or city) -->
      @if (pendingDelete(); as pending) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="locationDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="locationDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete {{ pending.kind === 'country' ? 'Country' : 'City' }}</h3>
              <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this {{ pending.kind }}? This action cannot be undone.</p>
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
export class ManageLocationsComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private notifications = inject(NotificationService);

  private countriesRes = rxResource({ stream: () => this.api.getCountries(), defaultValue: [] as Country[] });
  countries = this.countriesRes.value;

  private citiesRes = rxResource({ stream: () => this.api.getCities(), defaultValue: [] as City[] });
  cities = this.citiesRes.value;

  selectedCountry = signal<string | null>(null);
  selectedCountryName = computed(() => this.countries().find(c => c.code === this.selectedCountry())?.name ?? null);
  citiesForSelected = computed(() => this.cities().filter(c => c.countryCode === this.selectedCountry()));

  cityCount(code: string): number {
    return this.cities().filter(c => c.countryCode === code).length;
  }

  selectCountry(code: string) {
    this.selectedCountry.set(code);
  }

  // --- Country form ---
  showCountryForm = signal(false);
  editingCountryCode = signal<string | null>(null);
  countryForm = new FormGroup({
    code: new FormControl({ value: '', disabled: false }, [Validators.required, Validators.pattern('^[A-Za-z]{2}$')]),
    name: new FormControl('', Validators.required),
  });

  openCountryForm(c?: Country) {
    if (c) {
      this.editingCountryCode.set(c.code);
      this.countryForm.reset({ code: c.code, name: c.name });
      this.countryForm.controls.code.disable();
    } else {
      this.editingCountryCode.set(null);
      this.countryForm.reset({ code: '', name: '' });
      this.countryForm.controls.code.enable();
    }
    this.showCountryForm.set(true);
  }

  closeCountryForm() {
    this.showCountryForm.set(false);
    this.editingCountryCode.set(null);
  }

  saveCountry() {
    if (!this.countryForm.valid) return;
    const raw = this.countryForm.getRawValue();
    const code = (raw.code ?? '').toUpperCase();
    const name = raw.name ?? '';
    const editing = this.editingCountryCode();
    const done = () => { this.countriesRes.reload(); this.closeCountryForm(); this.notifications.show('Country saved.', 'success'); };
    if (editing) {
      this.api.updateCountry(editing, { name }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    } else {
      this.api.createCountry({ code, name }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    }
  }

  // --- City form ---
  showCityForm = signal(false);
  editingCityId = signal<string | null>(null);
  cityForm = new FormGroup({
    name: new FormControl('', Validators.required),
    countryCode: new FormControl('', Validators.required),
  });

  openCityForm(city?: City) {
    if (city) {
      this.editingCityId.set(city.id);
      this.cityForm.reset({ name: city.name, countryCode: city.countryCode });
    } else {
      this.editingCityId.set(null);
      this.cityForm.reset({ name: '', countryCode: this.selectedCountry() ?? '' });
    }
    this.showCityForm.set(true);
  }

  closeCityForm() {
    this.showCityForm.set(false);
    this.editingCityId.set(null);
  }

  saveCity() {
    if (!this.cityForm.valid) return;
    const raw = this.cityForm.getRawValue();
    const payload: Partial<City> = { name: raw.name ?? '', countryCode: raw.countryCode ?? '' };
    const id = this.editingCityId();
    const done = () => {
      this.citiesRes.reload();
      // Keep the selected country in sync with the city just added/edited.
      if (payload.countryCode) this.selectedCountry.set(payload.countryCode);
      this.closeCityForm();
      this.notifications.show('City saved.', 'success');
    };
    if (id) {
      this.api.updateCity(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    } else {
      this.api.createCity(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(done);
    }
  }

  // --- Delete (country or city) ---
  pendingDelete = signal<PendingDelete>(null);

  askDeleteCountry(code: string) { this.pendingDelete.set({ kind: 'country', code }); }
  askDeleteCity(id: string) { this.pendingDelete.set({ kind: 'city', id }); }
  cancelDelete() { this.pendingDelete.set(null); }

  confirmDelete() {
    const pending = this.pendingDelete();
    if (!pending) return;
    if (pending.kind === 'country') {
      this.api.deleteCountry(pending.code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.countriesRes.reload();
        if (this.selectedCountry() === pending.code) this.selectedCountry.set(null);
        this.pendingDelete.set(null);
        this.notifications.show('Country deleted.', 'success');
      });
    } else {
      this.api.deleteCity(pending.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.citiesRes.reload();
        this.pendingDelete.set(null);
        this.notifications.show('City deleted.', 'success');
      });
    }
  }
}
