import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { ListStateComponent } from '../shared/list-state.component';

/** Today as an ISO 'YYYY-MM-DD' string, used for status derivation + the terminate default. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective, ListStateComponent],
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
                   class="size-4 rounded border-line-strong text-accent focus:ring-2 focus:ring-accent/25">
            Active only
          </label>
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
                  <td class="font-bold">{{ r.name }}</td>
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
                <input id="res-role" type="text" formControlName="role" class="command-input" placeholder="e.g. Developer"
                       [attr.aria-invalid]="invalid('role')">
                @if (invalid('role')) {
                  <p role="alert" class="mt-1 text-xs text-critical-text">Role is required.</p>
                }
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="res-org" class="block text-sm font-medium text-ink-secondary mb-1">Organization</label>
                  <input id="res-org" type="text" formControlName="organization" class="command-input" placeholder="e.g. Engineering">
                </div>
                <div>
                  <label for="res-loc" class="block text-sm font-medium text-ink-secondary mb-1">Location</label>
                  <input id="res-loc" type="text" formControlName="location" class="command-input" placeholder="e.g. Milan, IT">
                </div>
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

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="res-cost" class="block text-sm font-medium text-ink-secondary mb-1">Cost rate</label>
                  <input id="res-cost" type="number" min="0" step="1" formControlName="costRate" class="command-input" placeholder="e.g. 75">
                </div>
                <div>
                  <label for="res-bill" class="block text-sm font-medium text-ink-secondary mb-1">Bill rate</label>
                  <input id="res-bill" type="number" min="0" step="1" formControlName="billRate" class="command-input" placeholder="e.g. 140">
                </div>
              </div>

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

  search = signal('');
  /** "Active only" filter toggle — true by default (terminated rows hidden). */
  activeOnly = signal(true);

  filteredResources = computed(() => {
    const q = this.search().toLowerCase();
    const activeOnly = this.activeOnly();
    return this.resources().filter(r => {
      if (activeOnly && this.isTerminated(r)) return false;
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
    organization: new FormControl(''),
    location: new FormControl(''),
    capacity: new FormControl<number | null>(40, [Validators.required, Validators.min(1)]),
    costRate: new FormControl<number | null>(null),
    billRate: new FormControl<number | null>(null),
    hireDate: new FormControl('', Validators.required),
  });

  /** A resource is Terminated when terminationDate is set to a date on/before today. */
  isTerminated(r: Resource): boolean {
    return !!r.terminationDate && r.terminationDate <= todayIso();
  }

  /** Whether a control should show its inline error (touched/dirty + invalid). */
  invalid(name: 'name' | 'role' | 'capacity' | 'hireDate'): boolean {
    const c = this.form.get(name);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  openForm(r?: Resource) {
    if (r) {
      this.editingId.set(r.id);
      this.form.reset({
        name: r.name,
        role: r.role,
        organization: r.organization ?? '',
        location: r.location ?? '',
        capacity: r.capacity ?? 40,
        costRate: r.costRate ?? null,
        billRate: r.billRate ?? null,
        hireDate: r.hireDate ?? '',
      });
    } else {
      this.editingId.set(null);
      this.form.reset({ name: '', role: '', organization: '', location: '', capacity: 40, costRate: null, billRate: null, hireDate: '' });
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
      organization: raw.organization ?? '',
      location: raw.location ?? '',
      capacity: Number(raw.capacity),
      costRate: raw.costRate == null ? undefined : Number(raw.costRate),
      billRate: raw.billRate == null ? undefined : Number(raw.billRate),
      hireDate: raw.hireDate ?? '',
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
