import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import { ApiService, AuditLog } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ListStateComponent } from '../shared/list-state.component';

/**
 * Query param that focuses the register on ONE entity — RPT's "Storico per riga"
 * (manual §3.4 / §4.1.3), where the history icon on a planning row opens the
 * changes made to that row. An audit `path` is `/resources/2`, `/assignments/AL5`,
 * … so a caller links to `/audit-trail?entity=/resources/2` and lands with the
 * filter already applied. Named `entity` rather than reusing `q`
 * (SEARCH_FOCUS_PARAM) because it matches on the PATH, not on a name.
 */
export const AUDIT_FOCUS_PARAM = 'entity';

/**
 * How many entries this screen asks for per page.
 *
 * `GET /audit-logs` is bounded (`AUDIT_LOG_DEFAULT_LIMIT` 200, `AUDIT_LOG_MAX_LIMIT`
 * 1000, server.ts) and answers with a bare array — no total, no "hasMore". So the
 * limit is sent EXPLICITLY: omitting it does not mean "everything", it means the
 * server's default silently, which is how a truncated list comes to be read as
 * complete (the defect already corrected on /search).
 *
 * 200 rather than the server's 1000 maximum, deliberately: every entry renders a
 * per-key diff block, and the honesty requirement is discharged by the explicit
 * paging plus {@link AuditTrail.isTruncated} — not by grabbing the largest page
 * the API will hand over. A reader who needs older entries walks back a page at a
 * time and is told that is what they are doing.
 */
export const AUDIT_PAGE_LIMIT = 200;

/**
 * One side (before or after) of ONE changed key.
 *
 * The four kinds exist because collapsing them loses the meaning of the record.
 * `absent` is "the key was not on that snapshot at all" — a field set for the
 * first time, or a DELETE whose `after` does not exist. `empty` is "the field was
 * there and held an empty string". Rendering both as a blank cell (or as an em
 * dash) turns two different facts into one, and in an audit trail that is the
 * whole point of the record.
 */
export type DiffSide =
  | { kind: 'absent' }
  | { kind: 'null' }
  | { kind: 'empty' }
  | { kind: 'value'; text: string; exact: string | null };

/** One changed key, with both sides resolved. */
export interface DiffLine {
  key: string;
  before: DiffSide;
  after: DiffSide;
}

/**
 * What an entry can say about field-level change. Three cases, kept apart:
 *  - `created`: `changedKeys` is absent. The middleware only diffs PUT/DELETE, so
 *    this is a POST — there is no prior state to compare against, and saying "no
 *    fields changed" about a creation would be false.
 *  - `no-diff`: `changedKeys` is `[]`. A mutation was recorded and no value moved.
 *  - `lines`: the per-key diff.
 */
export type DiffState =
  | { kind: 'created' }
  | { kind: 'no-diff' }
  | { kind: 'lines'; lines: DiffLine[] };

/**
 * Format a number for display with AT MOST 2 decimals (the project-wide rule),
 * while keeping the exact stored value available.
 *
 * An audit trail is the one place where a rounded figure could misrepresent the
 * record, so `exact` is populated whenever rounding actually changed the digits
 * — the template hangs it off `title` so the full precision is still reachable
 * and nothing is silently rewritten.
 */
function formatNumber(value: number): DiffSide {
  if (!Number.isFinite(value)) return { kind: 'value', text: String(value), exact: null };
  const rounded = Math.round(value * 100) / 100;
  return { kind: 'value', text: String(rounded), exact: rounded === value ? null : String(value) };
}

/** Render one raw snapshot value into a {@link DiffSide}. */
export function renderValue(value: unknown): DiffSide {
  if (value === undefined) return { kind: 'absent' };
  if (value === null) return { kind: 'null' };
  if (value === '') return { kind: 'empty' };
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return { kind: 'value', text: value, exact: null };
  if (typeof value === 'boolean') return { kind: 'value', text: value ? 'true' : 'false', exact: null };
  return { kind: 'value', text: JSON.stringify(value) ?? String(value), exact: null };
}

/**
 * Resolve one key against one snapshot.
 *
 * Presence is tested on the OBJECT, not on the value: a missing snapshot (a POST
 * has no `before`; a DELETE has no `after`) and a key the entity never carried
 * are both `absent`, and both are true statements. JSON transport drops
 * undefined-valued keys, so `hasOwnProperty` and `value === undefined` coincide
 * on the wire — the presence test is used anyway because it is the question
 * actually being asked.
 */
export function diffSide(snapshot: Record<string, unknown> | undefined, key: string): DiffSide {
  if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, key)) return { kind: 'absent' };
  return renderValue(snapshot[key]);
}

/**
 * Turn one audit entry into its field-level story.
 *
 * ONLY the keys named in `changedKeys` are read. That is both the requirement
 * (key / before / after) and data minimisation: `before`/`after` are FULL entity
 * snapshots on the wire — despite the "snapshots of just those keys" wording in
 * server.ts and in the `AuditLog` doc comment — so rendering them whole would put
 * every untouched field of an `/absences` row, `reasonCode` and `note` included,
 * on screen for a change that only moved a date.
 */
export function diffState(entry: AuditLog): DiffState {
  const keys = entry.changedKeys;
  if (keys === undefined) return { kind: 'created' };
  if (keys.length === 0) return { kind: 'no-diff' };
  return {
    kind: 'lines',
    lines: [...keys].sort().map(key => ({
      key,
      before: diffSide(entry.before, key),
      after: diffSide(entry.after, key),
    })),
  };
}

/**
 * `at` is `new Date().toISOString()` server-side, i.e. UTC. Rendered by slicing
 * the ISO string rather than through a locale formatter: the zone is stated
 * explicitly, and the same entry reads identically under SSR, in the browser and
 * in a test, with no hidden dependency on the host's locale or offset.
 */
export function formatAt(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/** One entry as the table renders it. */
interface TrailRow {
  id: string;
  at: string;
  rawAt: string;
  actorId: string;
  actorRole: string;
  method: string;
  path: string;
  statusCode: number;
  diff: DiffState;
}

/**
 * THE HISTORY REGISTER — the reader for the append-only audit trail (RPT parity
 * row 22, "Dettaglio Storico per riga").
 *
 * The trail itself predates this screen and is richer than RPT's: actor, role,
 * method, path, and a per-key diff, over every collection in the audit registry
 * including the master data that moves money. What was missing was any way to
 * read it — `GET /audit-logs` had no Angular route at all.
 *
 * FOUR THINGS DECIDE THIS DESIGN, and each is a constraint rather than a taste:
 *
 * 1. AUDIENCE = `admin` + `delivery-executive`, matching the server's
 *    `/audit-logs` READ_RULE exactly. The route gate is
 *    `auditTrailGuard`/`AUDIT_TRAIL_READ_ROLES` (app.routes.ts) and the nav entry
 *    reads the same constant. A reachable route that then answers 403 is the twin
 *    of the defect this screen fixes, so the agreement is asserted against the
 *    server's own rule table, role by role, in both directions.
 *
 * 2. IT CAN CARRY SPECIAL-CATEGORY DATA, and it says so. `/absences` is in the
 *    audit registry deliberately, so an absence diff carries `reasonCode` —
 *    admissible only because product decision Q5 (2026-08-07) put
 *    `delivery-executive` in the reason audience, with per-field redaction in the
 *    middleware considered and REJECTED. This screen therefore adds no redaction
 *    of its own (a third convention contradicting a recorded decision) and
 *    instead states the consequence in the interface. It also offers NO export,
 *    for the same reason the absence register offers none: a file leaves the
 *    application and gets forwarded.
 *
 * 3. IT IS APPEND-ONLY, so it is read-only. There is no edit, no delete, no
 *    "correct this entry" — not for an administrator either. A control that
 *    looked like it could change an entry would misrepresent the guarantee the
 *    trail exists to provide.
 *
 * 4. THE FEED IS BOUNDED. A full page is the only truncation signal the API
 *    gives (bare array, no total), so a full page says so and "Older" is enabled
 *    only then — a short page PROVES nothing older exists, and a full one proves
 *    nothing either way, which is exactly what the copy claims.
 *
 * FILTERS ARE CLIENT-SIDE, over the loaded page only, because `/audit-logs`
 * accepts `limit`/`offset` and nothing else. That limitation is stated next to
 * the filters rather than left for a reader to infer from a short result.
 */
@Component({
  selector: 'app-audit-trail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Governance</div>
          <h1 class="command-title">History</h1>
          <p class="command-subtitle">
            Every recorded change, newest first: who made it, from which role, on which record, and
            which fields moved.
          </p>
        </div>
      </header>

      <!-- The reader must know what class of data can appear here, rather than
           learn it from an incident. Text carries the whole message; the icon is
           aria-hidden and colour is never the only signal (WCAG 1.4.1).
           NOT "command-chip is-info": that primitive is white-space: nowrap, so a
           sentence this long pushed the page into a horizontal scroll. The info
           tone tokens are applied directly, the same trio reporting.ts uses. -->
      <p class="rounded-xl bg-info-tint text-info-text ring-1 ring-info p-4 flex items-start gap-3 text-sm leading-snug"
         data-test="audit-privacy-notice">
        <mat-icon aria-hidden="true" class="text-[18px] w-[18px] h-[18px] shrink-0">lock</mat-icon>
        <span>
          This register can contain special-category personal data — an absence reason, for example,
          appears in the diff of an <code>/absences</code> change. It is restricted to administrators
          and delivery executives, and it offers no export.
        </span>
      </p>

      <p class="text-sm text-[var(--cc-muted)]" data-test="audit-append-only-notice">
        The trail is append-only. Entries cannot be edited or deleted from here, or anywhere else,
        by any role — including an administrator.
      </p>

      <app-list-state [loading]="loading()" [error]="auditRes.status() === 'error'"
                      skeleton="table-rows" [rows]="6" [columns]="4" label="the history"
                      (retry)="auditRes.reload()">
        <ng-template>
          <!-- THE FILTERS LIVE INSIDE THE RESOLVED BRANCH, and that placement is
               load-bearing twice over. They describe the LOADED page, so offering
               them over a page that failed to load would invite a reader to narrow
               nothing and read the result as an answer. And mechanically: their
               options come from entries(), which reads auditRes.value() bare —
               that throws while the resource is in its error state, and only this
               template is inert until the resource resolves. Hoisting this section
               out of app-list-state reintroduces both. -->
          <section class="command-card p-4 space-y-3 mb-4" aria-labelledby="auditFilterHeading">
            <h2 id="auditFilterHeading" class="command-section-label">Narrow this page</h2>
            <div class="grid gap-4 sm:grid-cols-3">
              <div>
                <label for="auditEntity" class="block text-sm font-semibold text-ink-secondary mb-1.5">Record or path</label>
                <input id="auditEntity" type="text" class="command-input" data-test="audit-entity-filter"
                       placeholder="e.g. /resources/2"
                       [value]="entityFilter()" (input)="entityFilter.set(readValue($event))">
              </div>
              <div>
                <label for="auditActor" class="block text-sm font-semibold text-ink-secondary mb-1.5">Actor</label>
                <!-- Options are derived from an async rxResource, so (change) plus
                     per-option [selected] — never [(ngModel)] or [value] on the
                     <select>: a value binding evaluated before the options exist
                     silently resets the control to the first option. -->
                <select id="auditActor" class="command-select" data-test="audit-actor-filter"
                        (change)="actorFilter.set(readValue($event))">
                  <option value="" [selected]="actorFilter() === ''">Anyone</option>
                  @for (actor of actorOptions(); track actor) {
                    <option [value]="actor" [selected]="actor === actorFilter()">{{ actor }}</option>
                  }
                </select>
              </div>
              <div>
                <label for="auditMethod" class="block text-sm font-semibold text-ink-secondary mb-1.5">Operation</label>
                <select id="auditMethod" class="command-select" data-test="audit-method-filter"
                        (change)="methodFilter.set(readValue($event))">
                  <option value="" [selected]="methodFilter() === ''">Any operation</option>
                  @for (method of methodOptions(); track method) {
                    <option [value]="method" [selected]="method === methodFilter()">{{ method }}</option>
                  }
                </select>
              </div>
            </div>
            <p class="text-xs text-[var(--cc-muted)]" data-test="audit-filter-scope-note">
              These filters narrow the entries already loaded below. They do not search the rest of the
              trail — use Older to load further back.
            </p>
          </section>

          @if (rangeLabel(); as range) {
            <p class="text-sm text-[var(--cc-muted)]" data-test="audit-range">{{ range }}</p>
          }
          @if (isTruncated()) {
            <p class="mt-1 text-sm text-[var(--cc-muted)]" data-test="audit-truncation-hint">
              This page came back full at {{ pageLimit }} entries, so older changes may exist beyond
              it. Nothing here says these are all of them.
            </p>
          }

          <p class="mt-3 text-xs text-[var(--cc-muted)]" data-test="audit-diff-legend">
            In a diff, <strong>not present</strong> means the field did not exist on that side of the
            change — a field set for the first time, or a record that no longer exists.
            <strong>empty text</strong> means the field was there and held an empty string. They are
            not the same thing, and only the fields that changed are listed.
          </p>

          <div class="command-card overflow-x-auto mt-3">
            <table class="command-data-table min-w-[60rem]" data-test="audit-table">
              <thead>
                <tr>
                  <th class="px-6 py-4 font-medium">When (UTC)</th>
                  <th class="px-6 py-4 font-medium">Actor</th>
                  <th class="px-6 py-4 font-medium">Operation</th>
                  <th class="px-6 py-4 font-medium">Fields changed</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (row of visibleRows(); track row.id) {
                  <tr [attr.data-test]="'audit-row-' + row.id">
                    <td class="px-6 py-4 whitespace-nowrap text-[var(--cc-muted)]">{{ row.at }}</td>
                    <td class="px-6 py-4">
                      <span class="font-medium text-[var(--cc-ink)]">{{ row.actorId }}</span>
                      <span class="block text-xs text-[var(--cc-muted)]">as {{ row.actorRole }}</span>
                    </td>
                    <td class="px-6 py-4">
                      <!-- The method is spelled out as text, not encoded in a
                           colour: colour is never the only signal. -->
                      <span class="command-chip is-neutral font-mono text-xs">{{ row.method }}</span>
                      <span class="block mt-1 font-mono text-xs break-all text-[var(--cc-muted)]">{{ row.path }}</span>
                      <span class="block text-xs text-[var(--cc-muted)]">responded {{ row.statusCode }}</span>
                    </td>
                    <td class="px-6 py-4 align-top">
                      <!-- Three mutually exclusive outcomes, kept apart on purpose:
                           a per-key diff, a creation with no prior state, and a
                           recorded mutation that moved nothing. Collapsing the last
                           two would state something false about a POST. -->
                      @if (diffLinesOf(row.diff); as lines) {
                        <ul class="space-y-2" [attr.data-test]="'audit-diff-' + row.id">
                          @for (line of lines; track line.key) {
                            <li class="text-sm" [attr.data-test]="'audit-diff-line-' + row.id + '-' + line.key">
                              <span class="font-mono text-xs font-semibold text-[var(--cc-ink)]">{{ line.key }}</span>
                              <span class="block sm:inline sm:ml-2">
                                <span class="text-xs uppercase tracking-wide text-[var(--cc-muted)]">was</span>
                                <span class="ml-1 break-all"
                                      [class]="sideClass(line.before)"
                                      [attr.data-kind]="line.before.kind"
                                      [attr.title]="sideTitle(line.before)"
                                      [attr.data-test]="'audit-before-' + row.id + '-' + line.key">{{ sideText(line.before) }}</span>
                                <span aria-hidden="true" class="mx-1 text-[var(--cc-muted)]">&rarr;</span>
                                <span class="text-xs uppercase tracking-wide text-[var(--cc-muted)]">now</span>
                                <span class="ml-1 break-all"
                                      [class]="sideClass(line.after)"
                                      [attr.data-kind]="line.after.kind"
                                      [attr.title]="sideTitle(line.after)"
                                      [attr.data-test]="'audit-after-' + row.id + '-' + line.key">{{ sideText(line.after) }}</span>
                              </span>
                            </li>
                          }
                        </ul>
                      } @else if (row.diff.kind === 'created') {
                        <span class="text-sm text-[var(--cc-muted)]" [attr.data-test]="'audit-created-' + row.id">
                          New record — there was no prior state to compare against.
                        </span>
                      } @else {
                        <span class="text-sm text-[var(--cc-muted)]" [attr.data-test]="'audit-no-diff-' + row.id">
                          No field value changed on this entry.
                        </span>
                      }
                    </td>
                  </tr>
                } @empty {
                  <!-- THE EMPTY STATE IS SCOPE-DEPENDENT. "Nothing has been
                       recorded" is a strong claim about the whole system, and it
                       is false when a filter is on or when the reader has paged
                       past the start of the trail. -->
                  <tr>
                    <td colspan="4" class="px-6 py-8 text-center text-[var(--cc-muted)]" data-test="audit-empty">
                      {{ emptyMessage() }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <div class="mt-4 flex items-center justify-between gap-3">
            <button type="button" class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    data-test="audit-newer" [disabled]="page() === 0" (click)="newer()">
              <mat-icon class="text-sm">arrow_upward</mat-icon> Newer
            </button>
            <!-- Enabled ONLY on a full page. A short page proves there is nothing
                 older; a full one proves nothing either way, which is why the
                 hint above says "may exist" rather than "there are more". -->
            <button type="button" class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    data-test="audit-older" [disabled]="!isTruncated()" (click)="older()">
              Older <mat-icon class="text-sm">arrow_downward</mat-icon>
            </button>
          </div>
        </ng-template>
      </app-list-state>
    </div>
  `,
})
export class AuditTrail {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  /** Exposed so the copy and the request carry the SAME number. */
  protected readonly pageLimit = AUDIT_PAGE_LIMIT;

  /**
   * Zero-based page. `offset` is derived from it rather than stored, so the
   * request, the range label and the paging controls cannot disagree.
   */
  protected readonly page = signal(0);

  /**
   * The entity filter, seeded from `?entity=` the way `/resources`, `/customers`
   * and `/orders` seed theirs from `?q=` — a route snapshot for a FILTER value.
   * (The "never snapshot" rule is about `auth.userId()`/`auth.role()`, whose
   * anonymous defaults are the ones that freeze; a query param is already
   * resolved when the component is constructed.)
   */
  protected readonly entityFilter = signal(
    inject(ActivatedRoute).snapshot.queryParamMap.get(AUDIT_FOCUS_PARAM)?.trim() ?? '',
  );
  protected readonly actorFilter = signal('');
  protected readonly methodFilter = signal('');

  /**
   * The page itself. Gated on `authReady()`: a principal-gated read fired before
   * the OIDC bootstrap settles goes out with no bearer, 401s, and latches the
   * view — and on an audit register that failure would read as "no trace".
   */
  readonly auditRes = rxResource<AuditLog[], { ready: boolean; offset: number }>({
    params: () => ({ ready: this.auth.authReady(), offset: this.page() * AUDIT_PAGE_LIMIT }),
    stream: ({ params }) => (params.ready
      ? this.api.getAuditLogs({ limit: AUDIT_PAGE_LIMIT, offset: params.offset })
      : of<AuditLog[]>([])),
    defaultValue: [] as AuditLog[],
  });

  /**
   * "Not loaded yet" FOLDS IN "the OIDC bootstrap has not settled", the same way
   * `what-if.ts`'s `dataState()` and `search.component.ts`'s `sectionState()` fold
   * it in.
   *
   * Without it the resource resolves its empty default while `authReady()` is
   * false — which is the whole of SSR, since `authReady` never flips true on the
   * server — and the server-rendered HTML said, verbatim, "No changes have been
   * recorded yet." That is the strongest false claim this screen can make, shipped
   * in the initial payload before a single read had been attempted. Now the
   * skeleton holds that space until an answer exists.
   */
  protected readonly loading = computed(() => !this.auth.authReady() || this.auditRes.isLoading());

  /**
   * The loaded page, read STRAIGHT off the resource.
   *
   * Never `status() === 'error' ? [] : value()`: that turns a failed read into
   * "no entries", and on this screen "no entries" is a claim that nothing was
   * ever changed. The error state belongs to `app-list-state`, which renders it
   * with a real Retry.
   *
   * The consequence of keeping it bare: `value()` THROWS while the resource is in
   * its error state, so every reader of this signal — the rows, the filters'
   * options, the range label, the truncation test — must live inside
   * `app-list-state`'s `<ng-template>`, which is not instantiated until the
   * resource resolves. That is why the filter panel is in there too.
   */
  private readonly entries = computed(() => this.auditRes.value());

  private readonly rows = computed<TrailRow[]>(() => this.entries().map(entry => ({
    id: entry.id,
    at: formatAt(entry.at),
    rawAt: entry.at,
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    method: entry.method,
    path: entry.path,
    statusCode: entry.statusCode,
    diff: diffState(entry),
  })));

  /** Distinct actors on THIS page, for the actor picker. */
  protected readonly actorOptions = computed(() =>
    [...new Set(this.rows().map(row => row.actorId))].sort());

  /** Distinct operations on THIS page, for the operation picker. */
  protected readonly methodOptions = computed(() =>
    [...new Set(this.rows().map(row => row.method))].sort());

  protected readonly hasFilter = computed(() =>
    this.entityFilter().trim() !== '' || this.actorFilter() !== '' || this.methodFilter() !== '');

  protected readonly visibleRows = computed(() => {
    const needle = this.entityFilter().trim().toLowerCase();
    const actor = this.actorFilter();
    const method = this.methodFilter();
    return this.rows().filter(row =>
      (needle === '' || row.path.toLowerCase().includes(needle))
      && (actor === '' || row.actorId === actor)
      && (method === '' || row.method === method));
  });

  /**
   * A page that came back exactly full is the ONLY truncation signal available:
   * the response is a bare array with no total. It errs toward "there may be
   * more" rather than presenting a possibly-cut register as the whole of it.
   */
  protected readonly isTruncated = computed(() => this.entries().length >= AUDIT_PAGE_LIMIT);

  /**
   * Where in the trail this page sits. Absent when the page carried nothing.
   *
   * When a filter is on, the match count comes FIRST. Without it the line read
   * "Entries 1–3, newest first" above a single visible row, which invites the
   * reader to conclude the other two were not entries at all rather than that they
   * were filtered out.
   */
  protected readonly rangeLabel = computed(() => {
    const count = this.entries().length;
    if (count === 0) return '';
    const first = this.page() * AUDIT_PAGE_LIMIT + 1;
    const window = `Entries ${first}–${first + count - 1}, newest first.`;
    if (!this.hasFilter()) return window;
    return `${this.visibleRows().length} of ${count} shown by the filters. ${window}`;
  });

  protected readonly emptyMessage = computed(() => {
    if (this.hasFilter()) {
      return 'No entry on this page matches the filters. Older entries are not searched — clear a filter, or load an older page.';
    }
    if (this.page() > 0) return 'This page is past the end of the trail. Go back to newer entries.';
    return 'No changes have been recorded yet.';
  });

  protected readValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  }

  /**
   * The diff lines, or `null` when this entry has none. A method rather than a
   * `@switch` on `diff.kind` in the template: `@if (diffLinesOf(...); as lines)`
   * narrows in one place, instead of relying on the template compiler narrowing a
   * loop variable's property chain across branches.
   */
  protected diffLinesOf(diff: DiffState): DiffLine[] | null {
    return diff.kind === 'lines' ? diff.lines : null;
  }

  /**
   * The visible marker for a side. `not present` and `empty text` are spelled
   * out, and differently, because the difference between them is a fact about the
   * record; a shared blank cell or a shared em dash would erase it.
   */
  protected sideText(side: DiffSide): string {
    switch (side.kind) {
      case 'absent': return 'not present';
      case 'null': return 'null';
      case 'empty': return 'empty text';
      case 'value': return side.text;
    }
  }

  /** The exact stored number when the 2-decimal rendering rounded it; else none. */
  protected sideTitle(side: DiffSide): string | null {
    return side.kind === 'value' && side.exact !== null ? `Exact stored value: ${side.exact}` : null;
  }

  /** Markers read as commentary, real values as data. Never colour alone. */
  protected sideClass(side: DiffSide): string {
    return side.kind === 'value'
      ? 'font-mono text-xs text-[var(--cc-ink)]'
      : 'text-xs italic text-[var(--cc-muted)]';
  }

  protected older(): void {
    this.page.update(current => current + 1);
  }

  protected newer(): void {
    this.page.update(current => (current > 0 ? current - 1 : 0));
  }
}
