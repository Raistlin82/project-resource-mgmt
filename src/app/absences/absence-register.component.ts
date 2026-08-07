import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import {
  ABSENCE_REASON_CODES,
  AbsenceReasonCode,
  ApiService,
  Resource,
  ResourceAbsence,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { ListStateComponent } from '../shared/list-state.component';
import { ABSENCE_WRITE_ROLES } from '../guards/role.guard';

/**
 * The already-booked days a newly recorded absence collides with, as returned
 * alongside the row by `POST`/`PUT /absences`.
 *
 * Declared here rather than in `api.service` because it is a property of the
 * WRITE RESPONSE, not of the stored entity: an absence read back from
 * `GET /absences` never carries it. Typing it into `ResourceAbsence` would
 * assert that every absence has a conflict list, which is false everywhere
 * except the two write paths.
 */
interface AbsenceWriteResponse extends ResourceAbsence {
  bookedDayConflicts?: { date: string; hours: number }[];
}

/** Human label for a reason code. Sentence case, never an abbreviation. */
const REASON_LABELS: Readonly<Record<AbsenceReasonCode, string>> = {
  Maternity: 'Maternity',
  ParentalLeave: 'Parental leave',
  Vacation: 'Vacation',
  Sickness: 'Sickness',
  Indisposition: 'Indisposition',
  Other: 'Other',
};

/**
 * THE ABSENCE REGISTER — block H, task T8. The ONE screen in the product that
 * may display an absence REASON, because displaying the reason is its purpose.
 *
 * PRIVACY (spec §7.3, GDPR art. 9). Every other surface reads either the
 * `ABSENT` bench state or the redacted `/absences/calendar` projection. This
 * screen calls `getAbsences()`, which carries `reasonCode` and `note`, and it
 * therefore:
 *   - is route-gated to `ABSENCE_REASON_READ_ROLES` (role.guard.ts), the same
 *     set the server's `/absences` READ_RULE admits;
 *   - passes the reason to NO shared component (`app-list-state` receives
 *     loading/error flags only) and to no existing screen;
 *   - offers NO export. That omission is deliberate and not an oversight: a CSV
 *     leaves the application and gets forwarded by mail, which is the classic
 *     escape path for exactly this class of data (spec U19).
 *
 * TWO SEPARATE GATES, and conflating them would be wrong in both directions:
 *   1. READING the reason — `ABSENCE_REASON_READ_ROLES`, the route gate.
 *      Includes `employee`, whose rows the SERVER narrows to their own; see
 *      {@link scope}.
 *   2. RECORDING one — {@link ABSENCE_WRITE_ROLES}, a strict subset. A
 *      `delivery-executive` reads the reason (product decision Q5) and cannot
 *      write, so the write controls are disabled with the reason beside them
 *      (P2-18) rather than left live to collect a 403.
 */
@Component({
  selector: 'app-absence-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ModalDialogDirective, ListStateComponent],
  template: `
    <div class="command-page max-w-6xl mx-auto space-y-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="command-section-label">Resource Control</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Absences</h1>
          <p class="mt-1 text-sm text-[var(--cc-muted)]">
            Recorded periods during which a person cannot be staffed. An absence is an HR fact:
            it carries no customer, raises no allocation approval and costs nothing.
          </p>
        </div>
        <!-- P2-18 — the role gate, stated before the click. The only possible
             outcome of this button for a reader-without-write is a 403, so it is
             disabled with the reason beside it and the hint is its accessible
             description WHILE it is disabled. -->
        <div class="flex flex-col items-start gap-1 sm:items-end">
          <button type="button" (click)="openCreate()" [disabled]="!canWrite()"
                  [attr.aria-describedby]="canWrite() ? null : 'absenceWriteRoleHint'"
                  data-test="record-absence"
                  class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
            <mat-icon class="text-sm">event_busy</mat-icon> Record absence
          </button>
          @if (!canWrite()) {
            <p id="absenceWriteRoleHint" data-test="record-absence-role-hint"
               class="max-w-xs text-xs text-[var(--cc-muted)] sm:text-right">{{ WRITE_ROLE_HINT }}</p>
          }
        </div>
      </div>

      <!-- The reason is special-category data and the reader should know they are
           looking at it, not discover it from a support ticket. Text, not colour
           alone (WCAG 1.4.1): the icon has aria-hidden and the sentence carries
           the whole message. -->
      <p class="command-chip is-info items-start gap-2 px-3 py-2 text-xs leading-snug"
         data-test="absence-privacy-notice">
        <mat-icon aria-hidden="true" class="text-[16px] w-[16px] h-[16px] shrink-0">lock</mat-icon>
        <span>Absence reasons are special-category personal data. They appear on this screen only and are never exported.</span>
      </p>

      @if (scope() === 'own') {
        <p class="text-sm text-[var(--cc-muted)]" data-test="absence-own-scope-note">
          You are seeing your own absences. The server does not return anyone else's to your role.
        </p>
      }

      <app-list-state [loading]="absencesRes.isLoading()" [error]="absencesRes.status() === 'error'"
                      skeleton="table-rows" [rows]="5" [columns]="5" label="absences"
                      (retry)="absencesRes.reload()">
        <ng-template>
          <div class="command-card overflow-x-auto">
            <table class="command-data-table min-w-[52rem]" data-test="absence-table">
              <thead>
                <tr>
                  <th class="px-6 py-4 font-medium">Person</th>
                  <th class="px-6 py-4 font-medium">From</th>
                  <th class="px-6 py-4 font-medium">To</th>
                  <th class="px-6 py-4 font-medium">Reason</th>
                  <th class="px-6 py-4 font-medium">Note</th>
                  <th class="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (row of rows(); track row.id) {
                  <tr [attr.data-test]="'absence-row-' + row.id">
                    <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ row.who }}</td>
                    <td class="px-6 py-4 text-[var(--cc-muted)]">{{ row.startDate }}</td>
                    <td class="px-6 py-4 text-[var(--cc-muted)]">{{ row.endDate }}</td>
                    <td class="px-6 py-4">
                      <span class="command-chip is-neutral" [attr.data-test]="'absence-reason-' + row.id">{{ row.reason }}</span>
                    </td>
                    <td class="px-6 py-4 text-[var(--cc-muted)]">{{ row.note }}</td>
                    <td class="px-6 py-4 text-right whitespace-nowrap">
                      <button type="button" (click)="openEdit(row.absence)" [disabled]="!canWrite()"
                              [attr.aria-label]="'Edit absence for ' + row.who"
                              [attr.title]="'Edit absence for ' + row.who"
                              class="text-ink-muted hover:text-accent-text transition-colors p-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                      </button>
                      <button type="button" (click)="askDelete(row.absence)" [disabled]="!canWrite()"
                              [attr.aria-label]="'Delete absence for ' + row.who"
                              [attr.title]="'Delete absence for ' + row.who"
                              class="text-ink-muted hover:text-critical-text transition-colors p-1 ml-2 disabled:opacity-40 disabled:cursor-not-allowed">
                        <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                      </button>
                    </td>
                  </tr>
                } @empty {
                  <!-- THE EMPTY STATE IS SCOPE-DEPENDENT. For an employee the server
                       returned only their OWN rows, so "no absences recorded" would be
                       a claim about the organization that this reader was never shown. -->
                  <tr>
                    <td colspan="6" class="px-6 py-8 text-center text-[var(--cc-muted)]" data-test="absence-empty">
                      {{ emptyMessage() }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </ng-template>
      </app-list-state>

      @if (conflicts(); as report) {
        <!-- SPEC §6.4 — a new absence over already-booked days is ACCEPTED and
             REPORTS the collision. Rendering it is what stops the acceptance being
             a silent success: the planner is told exactly which days to un-book. -->
        <div role="status" data-test="absence-conflicts"
             class="rounded-xl bg-caution-tint text-caution-text ring-1 ring-caution p-4 flex items-start gap-3">
          <mat-icon aria-hidden="true" class="shrink-0">event_repeat</mat-icon>
          <div class="text-sm">
            <p class="font-semibold">
              Absence recorded. {{ report.length }} already-booked day(s) now fall inside it.
            </p>
            <p>
              The booking was not removed — un-book these days or the person reads as both allocated and away:
              @for (day of report; track day.date) {
                <span class="whitespace-nowrap">{{ day.date }} ({{ day.hours | number:'1.0-2' }} h)@if (!$last) {<span>,</span>}&nbsp;</span>
              }
            </p>
          </div>
          <button type="button" (click)="conflicts.set(null)" aria-label="Dismiss conflict report"
                  class="ml-auto p-1 hover:opacity-70">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon>
          </button>
        </div>
      }

      @if (showForm()) {
        <div data-test="absence-form-overlay"
             class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="absenceModalTitle" (dismiss)="closeForm()">
          <div data-test="absence-form-panel" class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="absenceModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">
                {{ editingId() ? 'Edit absence' : 'Record absence' }}
              </h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close"
                      class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
              <!-- Rendered INLINE rather than left to the interceptor's toast: error
                   toasts auto-dismiss in this app, and a dialog left open under a
                   vanished toast is an unexplained refusal. -->
              @if (saveError(); as err) {
                <p role="alert" data-test="absence-save-error" class="text-sm text-critical-text">{{ err }}</p>
              }

              <div>
                <label for="absenceResource" class="block text-sm font-semibold text-ink-secondary mb-1.5">Person *</label>
                <!-- Options come from an async rxResource, so (change) + per-option
                     [selected] rather than [value] on the <select> or [(ngModel)]:
                     a value binding evaluated before the options exist silently
                     resets the control to the first option. -->
                <select id="absenceResource" (change)="subjectId.set(readValue($event))"
                        data-test="absence-resource" class="command-select">
                  <option value="" [selected]="subjectId() === ''">Select a person...</option>
                  @for (r of subjectOptions(); track r.id) {
                    <option [value]="r.id" [selected]="r.id === subjectId()">{{ optionLabel(r) }}</option>
                  }
                </select>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label for="absenceStart" class="block text-sm font-semibold text-ink-secondary mb-1.5">From *</label>
                  <input id="absenceStart" type="date" [value]="startDate()" (input)="startDate.set(readValue($event))"
                         data-test="absence-start" class="command-input">
                </div>
                <div>
                  <label for="absenceEnd" class="block text-sm font-semibold text-ink-secondary mb-1.5">To *</label>
                  <input id="absenceEnd" type="date" [value]="endDate()" (input)="endDate.set(readValue($event))"
                         data-test="absence-end" class="command-input">
                </div>
              </div>
              <p class="text-xs text-[var(--cc-muted)]">Both dates are inclusive. A one-day absence has the same start and end.</p>

              <div>
                <label for="absenceReason" class="block text-sm font-semibold text-ink-secondary mb-1.5">Reason *</label>
                <select id="absenceReason" (change)="reasonCode.set(readReason($event))"
                        data-test="absence-reason" class="command-select">
                  @for (code of REASON_CODES; track code) {
                    <option [value]="code" [selected]="code === reasonCode()">{{ reasonLabel(code) }}</option>
                  }
                </select>
              </div>

              <div>
                <label for="absenceNote" class="block text-sm font-semibold text-ink-secondary mb-1.5">Note</label>
                <input id="absenceNote" type="text" [value]="note()" (input)="note.set(readValue($event))"
                       data-test="absence-note" class="command-input" placeholder="Optional — cover arrangements, handover">
              </div>
            </div>

            <div class="px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <!-- P2-18 AGAIN, for the rule the server answers 403 on. The blocking
                   reason is computed from the LIVE subject and the LIVE principal,
                   never snapshotted, so it flips the moment the picker moves off
                   the signed-in person. -->
              @if (saveBlocker(); as blocker) {
                <p [id]="blocker.id" [attr.data-test]="blocker.test"
                   class="order-last flex-1 text-xs text-[var(--cc-muted)] sm:order-first">{{ blocker.text }}</p>
              }
              <div class="flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
                <button type="button" (click)="save()" [disabled]="saveBlocker() !== null"
                        [attr.aria-describedby]="saveBlocker()?.id ?? null"
                        data-test="absence-save"
                        class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ editingId() ? 'Save changes' : 'Record absence' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      }

      @if (deleting(); as row) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="absenceDeleteTitle" (dismiss)="cancelDelete()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col" data-test="absence-delete-confirm">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="absenceDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete absence</h3>
              <p class="text-[var(--cc-muted)] text-sm">
                {{ nameOf(row.resourceId) }} becomes staffable again for {{ row.startDate }} to {{ row.endDate }}:
                those months return to the bench counts, to available capacity and to the reallocation panel.
                This cannot be undone from this screen.
              </p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelDelete()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmDelete()" data-test="absence-delete-action"
                      class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm">Delete</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AbsenceRegisterComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly REASON_CODES = ABSENCE_REASON_CODES;
  protected readonly WRITE_ROLE_HINT =
    'Recording an absence is restricted to resource managers and admins — it is an HR fact, and it moves the bench.';
  /**
   * The SoD refusal, worded as the operational consequence rather than as the
   * rule's name. Matches the server's 403 on `POST /absences`.
   */
  protected readonly SELF_RECORD_HINT =
    'You cannot record your own absence. Segregation of duties requires a colleague or an admin to record it.';

  /**
   * May this principal WRITE? Read reactively inside a computed, never
   * snapshotted at field-init: a deep link evaluates the field initializer
   * before the OIDC bootstrap settles, and a snapshot would freeze the
   * anonymous default and disable the controls for a resource manager.
   */
  readonly canWrite = computed(() => this.auth.hasAnyRole([...ABSENCE_WRITE_ROLES]));

  /**
   * Does the server return every row to this principal, or only their own?
   * Mirrors `absenceReadScope` — the reason audience sees all, an `employee`
   * sees theirs. Drives the empty-state wording and whether `/resources` is
   * fetched at all.
   */
  readonly scope = computed<'all' | 'own'>(() =>
    this.auth.hasAnyRole(['resource-manager', 'delivery-executive', 'admin']) ? 'all' : 'own');

  readonly absencesRes = rxResource<ResourceAbsence[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getAbsences() : of<ResourceAbsence[]>([])),
    defaultValue: [] as ResourceAbsence[],
  });

  /**
   * People, for the subject picker and for naming rows.
   *
   * GATED ON `scope() === 'all'`, NOT merely on readiness. The server's
   * `/resources` READ_RULE admits pm/resource-manager/delivery-executive/
   * finance/admin and NOT `employee` — while its `/absences` rule DOES admit
   * `employee`, precisely so a person can see their own leave. Firing this read
   * for an employee would answer 403 and tip the whole screen into its error
   * state for the one audience the privacy design went out of its way to admit.
   * The three roles in `scope() === 'all'` are all inside the `/resources` set,
   * so the gate is exact rather than approximate.
   */
  private readonly resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady() && this.scope() === 'all',
    stream: ({ params: canLoad }) => (canLoad ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });

  /**
   * Who an absence may be recorded against. Dummy and subco rows are people-like
   * for staffing but only a real person takes leave — except a subco, who can be
   * off sick (seed row AB1 is exactly that), so subco stays. A DUMMY is an
   * unfilled position: it cannot be absent, and offering it would let a planner
   * record leave for a vacancy.
   */
  readonly subjectOptions = computed(() =>
    this.resourcesRes.value().filter(r => (r.kind ?? 'internal') !== 'dummy'));

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deleting = signal<ResourceAbsence | null>(null);
  saveError = signal<string | null>(null);
  conflicts = signal<{ date: string; hours: number }[] | null>(null);

  subjectId = signal('');
  startDate = signal('');
  endDate = signal('');
  reasonCode = signal<AbsenceReasonCode>('Vacation');
  note = signal('');

  /** Rows as rendered: name resolved, reason spelled out, note normalised. */
  readonly rows = computed(() =>
    [...this.absencesRes.value()]
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.resourceId.localeCompare(b.resourceId))
      .map(absence => ({
        id: absence.id,
        absence,
        who: this.nameOf(absence.resourceId),
        startDate: absence.startDate,
        endDate: absence.endDate,
        reason: REASON_LABELS[absence.reasonCode] ?? absence.reasonCode,
        note: absence.note ?? '—',
      })));

  readonly emptyMessage = computed(() =>
    this.scope() === 'own'
      ? 'You have no recorded absences. This list shows only your own.'
      : 'No absences recorded.');

  /**
   * SoD, evaluated against the LIVE principal and the LIVE subject.
   *
   * `auth.userId()` is the signed-in principal's RESOURCE id (the OIDC
   * `resource_id` claim), which is the same namespace the server resolves
   * through `actorResourceId` before comparing — so this predicate asks the
   * server's question rather than a lookalike.
   */
  readonly selfRecordBlocked = computed(() => {
    const me = this.auth.userId();
    return me !== '' && this.subjectId() === me;
  });

  /** `end >= start` and every required field present. */
  private readonly formComplete = computed(() =>
    this.subjectId() !== '' && this.startDate() !== '' && this.endDate() !== ''
    && this.endDate() >= this.startDate());

  /**
   * The single reason the save control is blocked, or null when it is live.
   *
   * ORDERED BY AUTHORITY: the role gate outranks SoD, which outranks form
   * completeness. Showing "fill in the dates" to someone who could never save
   * anyway would send them round a loop that ends in a 403.
   */
  readonly saveBlocker = computed<{ id: string; text: string; test: string } | null>(() => {
    if (!this.canWrite()) {
      return { id: 'absenceSaveRoleHint', text: this.WRITE_ROLE_HINT, test: 'absence-save-role-hint' };
    }
    if (this.selfRecordBlocked()) {
      return { id: 'absenceSaveSodHint', text: this.SELF_RECORD_HINT, test: 'absence-save-sod-hint' };
    }
    if (!this.formComplete()) {
      return {
        id: 'absenceSaveFormHint',
        text: 'Pick a person and a date range; the end date cannot precede the start.',
        test: 'absence-save-form-hint',
      };
    }
    return null;
  });

  protected reasonLabel(code: AbsenceReasonCode): string {
    return REASON_LABELS[code] ?? code;
  }

  /**
   * Display name for a resource id. Falls back to "You" only for the signed-in
   * principal — which is the whole of an employee's list, and the only case in
   * which the roster is legitimately unavailable. Any other unresolved id shows
   * the raw id rather than an invented name.
   */
  nameOf(resourceId: string): string {
    const match = this.resourcesRes.value().find(r => r.id === resourceId);
    if (match) return match.name;
    return resourceId === this.auth.userId() ? 'You' : resourceId;
  }

  protected optionLabel(r: Resource): string {
    return r.id === this.auth.userId() ? `${r.name} (you)` : r.name;
  }

  protected readValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  }

  protected readReason(event: Event): AbsenceReasonCode {
    const raw = this.readValue(event);
    return (ABSENCE_REASON_CODES as readonly string[]).includes(raw)
      ? (raw as AbsenceReasonCode)
      : 'Other';
  }

  openCreate(): void {
    this.editingId.set(null);
    this.subjectId.set('');
    this.startDate.set('');
    this.endDate.set('');
    this.reasonCode.set('Vacation');
    this.note.set('');
    this.saveError.set(null);
    this.showForm.set(true);
  }

  openEdit(absence: ResourceAbsence): void {
    this.editingId.set(absence.id);
    this.subjectId.set(absence.resourceId);
    this.startDate.set(absence.startDate);
    this.endDate.set(absence.endDate);
    this.reasonCode.set(absence.reasonCode);
    this.note.set(absence.note ?? '');
    this.saveError.set(null);
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.saveError.set(null);
  }

  save(): void {
    // Re-checked here, not only in the template: a disabled attribute is a UI
    // affordance, and this method is reachable from a spec, a keyboard quirk or
    // a future caller. The server still refuses either way; this keeps the
    // client from claiming it sent something it did not.
    if (this.saveBlocker() !== null) return;
    const payload: Partial<ResourceAbsence> = {
      resourceId: this.subjectId(),
      startDate: this.startDate(),
      endDate: this.endDate(),
      reasonCode: this.reasonCode(),
      note: this.note(),
    };
    const id = this.editingId();
    const request = id
      ? this.api.updateAbsence(id, payload)
      : this.api.createAbsence(payload);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: saved => {
        const written = saved as AbsenceWriteResponse;
        const clashes = written.bookedDayConflicts ?? [];
        this.conflicts.set(clashes.length > 0 ? clashes : null);
        this.absencesRes.reload();
        this.closeForm();
      },
      error: (e: unknown) => {
        this.saveError.set(
          (e as { error?: { error?: string } })?.error?.error ?? 'Could not record the absence.',
        );
      },
    });
  }

  askDelete(absence: ResourceAbsence): void {
    this.deleting.set(absence);
  }

  cancelDelete(): void {
    this.deleting.set(null);
  }

  confirmDelete(): void {
    const row = this.deleting();
    if (!row) return;
    this.api.deleteAbsence(row.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.absencesRes.reload();
        this.deleting.set(null);
      },
      error: () => this.deleting.set(null),
    });
  }
}
