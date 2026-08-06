import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, forkJoin, map, of, type Observable } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { RouterLink } from '@angular/router';
import { ListStateComponent } from '../shared/list-state.component';
import { searchFocusLabel, searchTargetFor, type SearchTarget, type SearchSectionKey } from '../services/search-target.util';
import { SEARCH_MAX_LIMIT } from '../services/search.util';
import type { Resource, ResourceRequest, Project, Customer, Contract, Order } from '../services/api.service';

/** One collection's outcome for this search (design spec §5's four states, minus
 *  "loading" which is the whole rxResource's own isLoading(), not per-leg). */
type SectionResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'forbidden' }
  | { status: 'error' };

type SectionKey = 'resources' | 'requests' | 'projects' | 'customers' | 'contracts' | 'orders';

/**
 * Design spec §6, Decision 4 (CLOSED — a deliberate product decision the human
 * owner made, not a wiring choice left to implementation): which of the six
 * sections wait for an explicit submit (Enter) versus live-search with a
 * debounce. This is the ONLY place that split is decided — every consumer
 * below reads through this map rather than re-testing entity names, so a
 * future section added here cannot silently pick up the wrong timing mode in
 * one spot while the rest of the code assumes another.
 *
 *  - 'submit' (Resources, Requests): the highest-cardinality collections in
 *    the app (hundreds of rows in production, not the seed's handful) — even
 *    a debounce still fires one request per typing pause, so these wait for
 *    an explicit Enter to keep server load predictable.
 *  - 'live' (Projects, Customers, Contracts, Orders): lower-cardinality
 *    collections — Customers/Contracts/Orders never had ANY filter before
 *    this block (spec §1) — where a per-pause request is an acceptable cost
 *    in exchange for a more fluid search experience.
 */
const SEARCH_TIMING: Record<SectionKey, 'submit' | 'live'> = {
  resources: 'submit',
  requests: 'submit',
  projects: 'live',
  customers: 'live',
  contracts: 'live',
  orders: 'live',
};

/** How long a 'live' section waits after the last keystroke before firing
 *  (spec §6, Decision 4). */
const LIVE_SEARCH_DEBOUNCE_MS = 300;

/**
 * How many rows this screen asks each collection for, per section.
 *
 * The server ALWAYS paginates these six reads (`clampSearchPage`,
 * search.util.ts): omitting `limit` does not mean "everything", it means
 * `SEARCH_DEFAULT_LIMIT` — 20 — with no total in the response body. This screen
 * used to send no `limit` at all and render whatever came back as if it were the
 * complete answer, so a search matching 400 people showed exactly 20 rows and
 * looked exhaustive: a resource-manager could conclude nobody else matched and
 * staff the wrong person.
 *
 * Two halves fix that, and both are needed. Ask for the server's own maximum
 * (`clampSearchPage` caps at 100, so nothing above it is honoured anyway), AND
 * tell the user when the page came back full — because a full page is the only
 * signal available that the wire may have carried less than the whole match set.
 */
const SEARCH_PAGE_LIMIT = SEARCH_MAX_LIMIT;

interface SearchResults {
  resources: SectionResult<Resource> | undefined; // undefined = not attempted (RBAC pre-filter, or no active query yet for this section's mode)
  requests: SectionResult<ResourceRequest> | undefined;
  // Symmetric with the other five (was hard-coded {status:'ok', rows:[]} --
  // an accidental exemption nobody recorded; sectionState() below is now the
  // ONE place that decides what an absent/undefined leg renders as, for all
  // six sections alike, Projects included).
  projects: SectionResult<Project> | undefined;
  customers: SectionResult<Customer> | undefined;
  contracts: SectionResult<Contract> | undefined;
  orders: SectionResult<Order> | undefined;
}

const EMPTY_RESULTS: SearchResults = {
  resources: undefined, requests: undefined, projects: undefined,
  customers: undefined, contracts: undefined, orders: undefined,
};

/**
 * The four states design spec §5 requires for a section, as ONE discriminated
 * union -- so 'loading' and 'forbidden' can never again be derived from the
 * same signal by accident. That was the CRITICAL this type fixes: both used
 * to collapse to "this section's resolved value is undefined", and
 * `rxResource` resets `.value()` to `defaultValue` for the ENTIRE duration of
 * a fetch driven by new params (verified against Angular's own source,
 * `_resource-chunk.mjs`'s loading-vs-reloading split) -- so a SECOND search
 * made an already-permitted, already-populated section look identical to one
 * the caller was never allowed to see in the first place.
 */
type SectionViewState<T> =
  /** Omitted entirely -- header, count, everything (spec §5, "non permesso").
   *  Three distinct reasons collapse into this ONE rendering, recorded here
   *  rather than left for someone to rediscover later: (a) the client-known
   *  capability check says this role can't read this collection at all
   *  (`sectionAllowed`); (b) this section's OWN timing mode (SEARCH_TIMING)
   *  has no active query yet -- a 'live' section before its debounce has
   *  ever fired, or a 'submit' section before the first Enter; (c) defense
   *  in depth -- an actual 403 despite (a), which should not happen but is
   *  handled the same way as (a) if it ever does. */
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ok'; rows: T[] };

/** Wraps one section's HTTP call: success -> {status:'ok', rows}; a 403 (an
 *  UNEXPECTED one, since the caller pre-filters with capability getters below)
 *  -> {status:'forbidden'}; anything else -> {status:'error'}. Mirrors the
 *  established "wrap one forkJoin leg in catchError so it can't kill the
 *  others" idiom (utilization.component.ts's 'orgs' leg) but reports WHY,
 *  instead of degrading to a fixed empty default. */
function sectionCall<T>(source: Observable<T[]>): Observable<SectionResult<T>> {
  return source.pipe(
    map(rows => ({ status: 'ok' as const, rows })),
    catchError((err: HttpErrorResponse) => of(err.status === 403 ? { status: 'forbidden' as const } : { status: 'error' as const })),
  );
}

@Component({
  selector: 'app-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ListStateComponent, RouterLink],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Find</div>
          <h1 class="command-title">Search</h1>
          <p class="command-subtitle">Find resources, projects, requests, and commercial records by name.</p>
        </div>
      </header>

      <input
        class="command-input w-full"
        type="text"
        placeholder="Search by name..."
        [value]="draftQuery()"
        (input)="onInput($any($event.target).value)"
        (keydown.enter)="submitNow()"
      />

      <!--
        Each section below binds its state ONCE via @if ... as state (a
        second, separate call to the same computed cannot be narrowed by the
        template compiler -- confirmed the hard way during Task 6, see
        progress.md), then switches on state.kind: 'forbidden' renders
        NOTHING (the whole section, header included, is absent -- spec §5's
        "non permesso"); the other three all render the SAME section shell,
        differing only in what they hand to app-list-state, which already
        owns the loading-vs-error-vs-content split. This is the structural
        fix for the CRITICAL: 'forbidden' and 'loading' are now two branches
        of one switch on an explicit kind, never both derived from "is this
        value present" the way results().key used to be.
      -->
      @if (hasActiveQuery()) {
        @if (resourcesState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-resources">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resources</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="resources" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (r of state.rows; track r.id) {
                        @if (targetFor('resources', r); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-resources"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ r.name }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ r.name }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('resources') }}" in Resources.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
        @if (projectsState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-projects">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Projects</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="projects" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (p of state.rows; track p.id) {
                        @if (targetFor('projects', p); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-projects"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ p.name }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ p.name }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('projects') }}" in Projects.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
        @if (requestsState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-requests">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Requests</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="requests" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (r of state.rows; track r.id) {
                        @if (targetFor('requests', r); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-requests"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ r.name }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ r.name }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('requests') }}" in Requests.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
        @if (customersState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-customers">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Customers</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="customers" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (c of state.rows; track c.id) {
                        @if (targetFor('customers', c); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-customers"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ c.name }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ c.name }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('customers') }}" in Customers.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
        @if (contractsState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-contracts">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Contracts</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="contracts" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (c of state.rows; track c.id) {
                        @if (targetFor('contracts', c); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-contracts"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ c.name }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ c.name }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('contracts') }}" in Contracts.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
        @if (ordersState(); as state) {
          @switch (state.kind) {
            @case ('forbidden') {}
            @default {
              <section class="command-card" data-test="section-orders">
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Orders</h2>
                <app-list-state [loading]="state.kind === 'loading'" [error]="state.kind === 'error'" label="orders" (retry)="reload()">
                  <ng-template>
                    @if (state.kind === 'ok') {
                      @for (o of state.rows; track o.id) {
                        @if (targetFor('orders', o); as t) {
                          <a [routerLink]="t.link" [queryParams]="t.queryParams ?? null"
                             data-test="search-hit-orders"
                             class="block rounded px-2 py-1 -mx-2 text-[var(--cc-primary)] hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cc-primary)]">{{ o.invoiceNumber ?? o.id }}</a>
                        } @else {
                          <div class="px-2 py-1 -mx-2">{{ o.invoiceNumber ?? o.id }}</div>
                        }
                      }
                      @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('orders') }}" in Orders.</p> }
                      @if (isTruncated(state.rows)) { <p data-test="truncation-hint" class="mt-3 text-sm text-[var(--cc-muted)]">Showing the first {{ pageLimit }} matches — there may be more. Refine the query to narrow the results.</p> }
                    }
                  </ng-template>
                </app-list-state>
              </section>
            }
          }
        }
      }
    </div>
  `,
})
export class SearchComponent {
  private api = inject(ApiService);
  protected auth = inject(AuthService);

  /**
   * Where this row navigates, or `null` to leave it inert text.
   *
   * Reads the capabilities REACTIVELY, inside the call — never snapshotted at
   * field init, or a deep-link into /search freezes the anonymous default and
   * every row renders inert for the rest of the session.
   *
   * The gate is `search-target.util`'s, which mirrors each TARGET ROUTE's own
   * `canMatch` guard rather than this component's `sectionAllowed()`. The two
   * disagree for all six sections, and `projects` is the extreme: its section is
   * open to any authenticated principal while `/projects/:id` demands staffing
   * read. Gating the link on `sectionAllowed()` would advertise a route the
   * router then refuses — the defect already corrected once on the project
   * cards. The full table lives in that util's header.
   */
  protected targetFor(
    section: SearchSectionKey,
    item: { id: string; name?: string; invoiceNumber?: string },
  ): SearchTarget | null {
    return searchTargetFor(
      section,
      { id: item.id, name: searchFocusLabel(section, item) },
      {
        canReadStaffing: this.auth.canReadStaffing(),
        canManageStaffing: this.auth.canManageStaffing(),
        canManageCommercial: this.auth.canManageCommercial(),
        roles: this.auth.role() ? [this.auth.role()] : [],
      },
    );
  }
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  // Draft text (every keystroke) vs the two things that actually trigger a
  // fetch, per spec §6, Decision 4: `submittedQuery` (Resources/Requests,
  // explicit Enter only) and `liveQuery` (Projects/Customers/Contracts/
  // Orders, a debounced mirror of the draft). `submitQuery` is the seam a
  // real Enter keydown drives; exposed (not `protected`) so tests can invoke
  // it directly without simulating a keydown event.
  protected draftQuery = signal('');
  protected submittedQuery = signal('');
  /**
   * Debounced mirror of `draftQuery` feeding the 'live' entities. Browser-only:
   * this project already has an established rule that a timer with no
   * corresponding real-time clock during SSR must never be scheduled there
   * (NotificationService's auto-dismiss `setTimeout`, guarded by the same
   * `isPlatformBrowser` check) — a per-request Node process could otherwise
   * carry a timer callback across into a LATER, unrelated request. On the
   * server this signal simply never advances past its initial `''`, which is
   * harmless: the whole resource stays gated on `!authReady()` there anyway,
   * and `authReady()` never flips true during SSR (auth.service.ts).
   */
  protected liveQuery = signal('');
  private liveDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (this.isBrowser) {
      effect(() => {
        const value = this.draftQuery();
        if (this.liveDebounceHandle !== undefined) clearTimeout(this.liveDebounceHandle);
        // The write below happens inside the setTimeout callback, i.e. AFTER
        // this effect's own synchronous execution has already finished — not
        // a same-tick write from inside the effect — so no `allowSignalWrites`
        // is needed (same reasoning as NotificationService.dismiss()'s own
        // setTimeout-deferred signal write).
        this.liveDebounceHandle = setTimeout(() => this.liveQuery.set(value), LIVE_SEARCH_DEBOUNCE_MS);
      });
      this.destroyRef.onDestroy(() => {
        if (this.liveDebounceHandle !== undefined) clearTimeout(this.liveDebounceHandle);
      });
    }
  }

  protected onInput(value: string): void { this.draftQuery.set(value); }
  protected submitNow(): void { this.applySubmit(this.draftQuery()); }
  /** Test/production seam: equivalent to typing `q` then pressing Enter in one
   *  step. An explicit submit reaches EVERY section immediately, including the
   *  'live' ones — Enter is an unambiguous "search now" signal that should
   *  never leave a live section stale behind a still-pending debounce. */
  submitQuery(q: string): void { this.draftQuery.set(q); this.applySubmit(q); }

  private applySubmit(q: string): void {
    this.submittedQuery.set(q);
    this.liveQuery.set(q); // Enter always resolves any pending debounce immediately
    if (this.liveDebounceHandle !== undefined) { clearTimeout(this.liveDebounceHandle); this.liveDebounceHandle = undefined; }
  }

  /** Which active query text a section's "No results for ..." message should
   *  show — reads the SAME `SEARCH_TIMING` map `stream` below reads, so the
   *  displayed term can never disagree with the term actually sent. */
  protected displayQueryFor(key: SectionKey): string {
    return SEARCH_TIMING[key] === 'submit' ? this.submittedQuery() : this.liveQuery();
  }

  /** This section's own active query text, per its timing mode -- read
   *  DIRECTLY off `submittedQuery`/`liveQuery`, never off the resource's
   *  resolved value. This is what lets `sectionState()` decide "has this
   *  section even been asked for anything" independently of whether the
   *  resource has resolved yet, which is exactly the independence the
   *  loading/forbidden collision was missing. */
  private sectionQuery(key: SectionKey): string {
    return SEARCH_TIMING[key] === 'submit' ? this.submittedQuery().trim() : this.liveQuery().trim();
  }

  /** The SAME synchronous, client-known capability check `stream()` uses to
   *  decide whether to fire this section's request at all (no server round
   *  trip needed to know a role lacks staffing/commercial read access).
   *  Reading it here too lets `sectionState()` render 'forbidden' the
   *  instant a role is known to lack access, without waiting on -- or being
   *  confused with -- the shared resource's own loading/reset cycle.
   *  `projects` has no client-known gate: spec §4, no `READ_RULES` entry,
   *  open to any authenticated principal. */
  private sectionAllowed(key: SectionKey): boolean {
    switch (key) {
      case 'resources':
      case 'requests':
        return this.auth.canReadStaffing();
      case 'customers':
      case 'contracts':
      case 'orders':
        return this.auth.canReadCommercial();
      case 'projects':
        return true;
    }
  }

  /**
   * Derives ONE of the four `SectionViewState` states for a section, in an
   * order that structurally cannot let 'loading' collide with 'forbidden'
   * (the CRITICAL this fix corrects):
   *
   *  1. `!authReady()` -> loading. Spec §5's table folds this in explicitly,
   *     the same as `what-if.ts`'s `dataState()` / `contract-details.ts`'s
   *     `moneyFiguresState()`.
   *  2. `!sectionAllowed(key)` -> forbidden. Pure client-side, synchronous,
   *     no network round trip.
   *  3. `!sectionQuery(key)` -> forbidden. Nothing has been asked of THIS
   *     section yet under its own timing mode. Applies identically to every
   *     section, Projects included -- no more hard-coded always-visible
   *     exemption.
   *  4. `searchRes.isLoading()` -> loading. Read directly off the resource's
   *     OWN `isLoading()`, never inferred from whether `results()` is
   *     empty: `rxResource` resets `.value()` to `defaultValue` for the
   *     ENTIRE duration of a fetch driven by new params, so by this point
   *     the section is KNOWN allowed and KNOWN to have an active query, and
   *     its stale/reset value must not be read as if it were current.
   *  5. Only once none of the above apply is `result` (the resolved value
   *     for this key) consulted -- 'error'/'forbidden'/'ok' read off the
   *     ACTUAL response, never a default standing in for one. `undefined`
   *     and a resolved `'forbidden'` are both defense-in-depth here: by
   *     invariant (2)+(3) already guarantee this leg WAS fired for the
   *     current params, so a genuinely resolved 'forbidden' here would mean
   *     an unexpected 403 despite the client-side pre-filter, not the
   *     normal path.
   */
  private sectionState<T>(key: SectionKey, result: SectionResult<T> | undefined): SectionViewState<T> {
    if (!this.auth.authReady()) return { kind: 'loading' };
    if (!this.sectionAllowed(key)) return { kind: 'forbidden' };
    if (!this.sectionQuery(key)) return { kind: 'forbidden' };
    if (this.searchRes.isLoading()) return { kind: 'loading' };
    if (result === undefined || result.status === 'forbidden') return { kind: 'forbidden' };
    if (result.status === 'error') return { kind: 'error' };
    return { kind: 'ok', rows: result.rows };
  }

  private searchRes = rxResource<SearchResults, { ready: boolean } & Record<SectionKey, string>>({
    params: () => {
      const submitted = this.submittedQuery().trim();
      const live = this.liveQuery().trim();
      // Single source of truth for "which query value feeds which section":
      // SEARCH_TIMING above. Safe cast: Object.keys(SEARCH_TIMING) is exactly
      // the six SectionKey literals, so every key of Record<SectionKey, string>
      // is always populated below.
      const perSection = Object.fromEntries(
        (Object.keys(SEARCH_TIMING) as SectionKey[]).map(key => [key, SEARCH_TIMING[key] === 'submit' ? submitted : live]),
      ) as Record<SectionKey, string>;
      return { ready: this.auth.authReady(), ...perSection };
    },
    stream: ({ params }) => {
      if (!params.ready) return of(EMPTY_RESULTS);
      const anyActive = params.resources || params.requests || params.projects || params.customers || params.contracts || params.orders;
      if (!anyActive) return of(EMPTY_RESULTS);
      const canStaffing = this.auth.canReadStaffing();
      const canCommercial = this.auth.canReadCommercial();
      // Every leg sends `limit` EXPLICITLY. Omitting it is not "no paging" —
      // the server falls back to SEARCH_DEFAULT_LIMIT (20) and reports no
      // total, which is how a 20-row page came to be rendered as a complete
      // result set. See SEARCH_PAGE_LIMIT above.
      const limit = SEARCH_PAGE_LIMIT;
      return forkJoin({
        resources: canStaffing && params.resources ? sectionCall(this.api.getResources({ q: params.resources, limit })) : of(undefined),
        requests: canStaffing && params.requests ? sectionCall(this.api.getRequests({ q: params.requests, limit })) : of(undefined),
        // /projects has no RBAC pre-filter (open read, spec §4) -- fired
        // whenever its OWN (live) query is non-empty, exactly the same
        // shape as the other five now (sectionState() decides visibility;
        // no hard-coded always-ok fallback here anymore).
        projects: params.projects ? sectionCall(this.api.getProjects({ q: params.projects, limit })) : of(undefined),
        customers: canCommercial && params.customers ? sectionCall(this.api.getCustomers({ q: params.customers, limit })) : of(undefined),
        contracts: canCommercial && params.contracts ? sectionCall(this.api.getContracts({ q: params.contracts, limit })) : of(undefined),
        orders: canCommercial && params.orders ? sectionCall(this.api.getOrders({ q: params.orders, limit })) : of(undefined),
      }).pipe(
        // Only Projects gets translated here: it has no RBAC rule to
        // legitimately deny it (spec §4), so an actual 403 there is
        // anomalous, not a normal "you can't see this" -- surfaced as a
        // genuine error (Retry) rather than silently folded into
        // 'forbidden'. The other five keep their raw {status:'forbidden'}
        // untouched; `sectionState()` is the ONE place that decides what
        // 'forbidden' renders as, for all six alike.
        map(r => ({ ...r, projects: r.projects?.status === 'forbidden' ? { status: 'error' as const } : r.projects })),
      );
    },
    defaultValue: EMPTY_RESULTS,
  });

  private results = computed(() => this.searchRes.value() ?? EMPTY_RESULTS);

  // One computed per section, each threading its own resolved value through
  // sectionState() -- the ONLY place forbidden/loading/error/ok are decided
  // (see sectionState()'s own doc comment for the full reasoning and why the
  // old `loading` computed above it is gone: the template used to render
  // `results().key`'s presence directly, which is exactly the mechanism that
  // let a transient reset read as "not permitted").
  protected resourcesState = computed(() => this.sectionState('resources', this.results().resources));
  protected requestsState = computed(() => this.sectionState('requests', this.results().requests));
  protected projectsState = computed(() => this.sectionState('projects', this.results().projects));
  protected customersState = computed(() => this.sectionState('customers', this.results().customers));
  protected contractsState = computed(() => this.sectionState('contracts', this.results().contracts));
  protected ordersState = computed(() => this.sectionState('orders', this.results().orders));

  protected hasActiveQuery = computed(() => !!this.submittedQuery().trim() || !!this.liveQuery().trim());

  /** Exposed to the template so the number in the hint and the number actually
   *  sent on the wire are the SAME constant — a hard-coded "100" in the copy
   *  could drift away from the request and lie about what was fetched. */
  protected readonly pageLimit = SEARCH_PAGE_LIMIT;

  /**
   * A page that came back exactly full is the ONLY truncation signal available:
   * these responses are bare arrays with no total. So this errs toward saying
   * "there may be more" on an exact-`limit` match set rather than presenting a
   * possibly-cut list as complete — the copy claims only what is provable, that
   * these are the first `pageLimit` matches.
   */
  protected isTruncated(rows: readonly unknown[]): boolean { return rows.length >= this.pageLimit; }

  protected reload(): void { this.searchRes.reload(); }
}
