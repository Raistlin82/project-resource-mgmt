import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, forkJoin, map, of, type Observable } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ListStateComponent } from '../shared/list-state.component';
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

interface SearchResults {
  resources: SectionResult<Resource> | undefined; // undefined = not attempted (RBAC pre-filter, or no active query yet for this section's mode)
  requests: SectionResult<ResourceRequest> | undefined;
  projects: SectionResult<Project>;
  customers: SectionResult<Customer> | undefined;
  contracts: SectionResult<Contract> | undefined;
  orders: SectionResult<Order> | undefined;
}

const EMPTY_RESULTS: SearchResults = {
  resources: undefined, requests: undefined, projects: { status: 'ok', rows: [] },
  customers: undefined, contracts: undefined, orders: undefined,
};

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
  imports: [ListStateComponent],
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

      @if (hasActiveQuery()) {
        @if (results().resources; as section) {
          <section class="command-card" data-test="section-resources">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resources</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="resources" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (r of section.rows; track r.id) { <div>{{ r.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('resources') }}" in Resources.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().projects; as projectsSection) {
          <section class="command-card" data-test="section-projects">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Projects</h2>
            <app-list-state [loading]="loading()" [error]="projectsSection.status === 'error'" label="projects" (retry)="reload()">
              <ng-template>
                @if (projectsSection.status === 'ok') {
                  @for (p of projectsSection.rows; track p.id) { <div>{{ p.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('projects') }}" in Projects.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().requests; as section) {
          <section class="command-card" data-test="section-requests">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Requests</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="requests" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (r of section.rows; track r.id) { <div>{{ r.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('requests') }}" in Requests.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().customers; as section) {
          <section class="command-card" data-test="section-customers">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Customers</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="customers" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (c of section.rows; track c.id) { <div>{{ c.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('customers') }}" in Customers.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().contracts; as section) {
          <section class="command-card" data-test="section-contracts">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Contracts</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="contracts" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (c of section.rows; track c.id) { <div>{{ c.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('contracts') }}" in Contracts.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().orders; as section) {
          <section class="command-card" data-test="section-orders">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Orders</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="orders" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (o of section.rows; track o.id) { <div>{{ o.invoiceNumber ?? o.id }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('orders') }}" in Orders.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
      }
    </div>
  `,
})
export class SearchComponent {
  private api = inject(ApiService);
  protected auth = inject(AuthService);
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
      return forkJoin({
        resources: canStaffing && params.resources ? sectionCall(this.api.getResources({ q: params.resources })) : of(undefined),
        requests: canStaffing && params.requests ? sectionCall(this.api.getRequests({ q: params.requests })) : of(undefined),
        // /projects has no RBAC pre-filter (open read, spec §4) -- always
        // attempted once its own (live) query is non-empty; otherwise the same
        // "ok, empty" default as EMPTY_RESULTS.projects, never absent.
        projects: params.projects ? sectionCall(this.api.getProjects({ q: params.projects })) : of({ status: 'ok' as const, rows: [] as Project[] }),
        customers: canCommercial && params.customers ? sectionCall(this.api.getCustomers({ q: params.customers })) : of(undefined),
        contracts: canCommercial && params.contracts ? sectionCall(this.api.getContracts({ q: params.contracts })) : of(undefined),
        orders: canCommercial && params.orders ? sectionCall(this.api.getOrders({ q: params.orders })) : of(undefined),
      }).pipe(
        map(r => ({
          resources: r.resources?.status === 'forbidden' ? undefined : r.resources,
          requests: r.requests?.status === 'forbidden' ? undefined : r.requests,
          projects: r.projects.status === 'forbidden' ? { status: 'error' as const } : r.projects, // /projects has no rule to forbid on; treat a stray 403 as a genuine error, not absence
          customers: r.customers?.status === 'forbidden' ? undefined : r.customers,
          contracts: r.contracts?.status === 'forbidden' ? undefined : r.contracts,
          orders: r.orders?.status === 'forbidden' ? undefined : r.orders,
        })),
      );
    },
    defaultValue: EMPTY_RESULTS,
  });

  protected results = computed(() => this.searchRes.value() ?? EMPTY_RESULTS);
  protected loading = computed(() => !this.auth.authReady() || this.searchRes.isLoading());
  protected hasActiveQuery = computed(() => !!this.submittedQuery().trim() || !!this.liveQuery().trim());
  protected reload(): void { this.searchRes.reload(); }
}
