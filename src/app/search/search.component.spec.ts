import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { delay, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { SearchComponent } from './search.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { SEARCH_MAX_LIMIT } from '../services/search.util';

function apiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getResources: () => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]),
    getRequests: () => of([]),
    getProjects: () => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]),
    getCustomers: () => of([]),
    getContracts: () => of([]),
    getOrders: () => of([]),
    ...overrides,
  };
}

describe('SearchComponent', () => {
  async function setup(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
    platform = 'browser',
  ) {
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: ApiService, useValue: apiStub(apiOverrides) },
        { provide: AuthService, useValue: {
          authReady: () => true, canReadStaffing: () => true, canReadCommercial: () => true,
          // Row LINKING gates on the target route's guard, not on the section
          // pre-filter, so these three are what decide whether a row is a link.
          // Defaulted permissive here; the linking describe overrides them.
          canManageStaffing: () => true, canManageCommercial: () => true, role: () => 'admin',
          ...authOverrides } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Flushes the still-pending rxResource stream (params effect -> stream() ->
   *  forkJoin resolution -> value() update -> render). A single microtask tick
   *  is not enough for a chain this long under zoneless CD; loop a few rounds
   *  rather than guess a magic number of awaits per call site. */
  async function flush(fixture: { detectChanges(): void }, rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  async function setupAndSubmit(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
  ) {
    const fixture = await setup(apiOverrides, authOverrides);
    fixture.componentInstance.submitQuery('Julie');
    await flush(fixture);
    return fixture;
  }

  // --- Explicit-submit path (spec §6: Resources/Requests, and Enter always
  // resolves every section immediately, including the live ones) ---

  it('a matching resource renders in the Resources section', async () => {
    const fixture = await setupAndSubmit();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a role without canReadStaffing never even requests /resources, and the section does not render', async () => {
    const calls: string[] = [];
    const fixture = await setupAndSubmit(
      { getResources: () => { calls.push('resources'); return of([]); } },
      { canReadStaffing: () => false },
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(calls).not.toContain('resources');
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  it('a genuinely empty result renders "no results", not an error and not a missing section', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => of([]) });
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="section-projects"]')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('No results');
  });

  it('a network error on one section shows Retry there, while the other section still shows its own results', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => throwError(() => new HttpErrorResponse({ status: 500 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-projects"]')!.textContent).toContain('Retry');
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a 403 on one section (unexpected, despite the capability pre-filter) omits the section rather than showing an error panel', async () => {
    const fixture = await setupAndSubmit({ getResources: () => throwError(() => new HttpErrorResponse({ status: 403 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  // --- Live-debounce path (spec §6, Decision 4: Projects/Customers/Contracts/
  // Orders auto-search 300ms after the last keystroke, WITHOUT Enter) ---

  describe('live-debounced sections (spec §6, Decision 4)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('typing into the box fires the Projects (live) section after the debounce, not before', async () => {
      const getProjects = vi.fn(() => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]));
      const fixture = await setup({ getProjects });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      await flush(fixture);

      // Before the debounce elapses: not called, section not rendered.
      vi.advanceTimersByTime(299);
      await flush(fixture);
      expect(getProjects).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')).toBeFalsy();

      // Once the debounce elapses: fired, section renders.
      vi.advanceTimersByTime(1);
      await flush(fixture);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Alpha', limit: SEARCH_MAX_LIMIT });
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')!.textContent).toContain('Project Alpha');
    });

    it('typing into the box fires NOTHING in the Resources (explicit-submit) section until Enter, however long you wait', async () => {
      const getResources = vi.fn(() => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]));
      const fixture = await setup({ getResources });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Julie');
      vi.advanceTimersByTime(10_000); // far beyond any debounce window
      await flush(fixture);

      expect(getResources).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-resources"]')).toBeFalsy();

      // Confirm Enter is what actually releases it (rules out a broken test
      // double that would trivially "pass" by never firing at all).
      (fixture.componentInstance as unknown as { submitNow(): void }).submitNow();
      await flush(fixture);
      expect(getResources).toHaveBeenCalledWith({ q: 'Julie', limit: SEARCH_MAX_LIMIT });
    });

    it('rapid keystrokes coalesce into ONE query, not one request per keystroke', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects });
      const instance = fixture.componentInstance as unknown as { onInput(v: string): void };

      instance.onInput('J');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Ju');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Jul');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Julie');
      vi.advanceTimersByTime(300); // full debounce from the LAST keystroke only
      await flush(fixture);

      expect(getProjects).toHaveBeenCalledTimes(1);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Julie', limit: SEARCH_MAX_LIMIT });
    });

    it('the debounce timer is browser-only: on the server, typing schedules nothing, however long fake time advances', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects }, {}, 'server');

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      vi.advanceTimersByTime(10_000);
      await flush(fixture);

      expect(getProjects).not.toHaveBeenCalled();
    });
  });

  // --- CRITICAL fix: a SECOND search must not make "still loading" and "not
  // permitted" indistinguishable. rxResource resets .value() to defaultValue
  // for the WHOLE duration of a fetch driven by new params -- so a section
  // whose own resolved value used to gate its visibility (results().key
  // truthy/undefined) vanished, mid-flight, exactly like a 403'd section,
  // even though it is fully permitted and mid-search. ---

  describe('a second search must render loading distinctly from forbidden (P1-CRITICAL)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('while the second fetch is in flight, a permitted section keeps its header and shows a loading skeleton, while a forbidden section stays absent throughout', async () => {
      const getResources = vi.fn()
        .mockReturnValueOnce(of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]))
        .mockReturnValueOnce(of([{ id: '2', name: 'John Smith', role: 'Developer', kind: 'internal' }]).pipe(delay(50)));
      const fixture = await setup(
        { getResources },
        // canReadCommercial: false -> Customers/Contracts/Orders are the
        // FORBIDDEN sections throughout this test, never fired at all.
        { canReadStaffing: () => true, canReadCommercial: () => false },
      );
      const host = fixture.nativeElement as HTMLElement;

      // First search resolves immediately (no delay) -- establishes the
      // baseline: Resources visible with content, Customers (forbidden)
      // never rendered at all.
      fixture.componentInstance.submitQuery('Julie');
      await flush(fixture);
      expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
      expect(host.querySelector('[data-test="section-customers"]')).toBeFalsy();

      // Second search: the mocked call now takes 50ms. While it is in
      // flight (before advancing fake time at all), Resources must show ITS
      // OWN header plus a loading skeleton -- not vanish the way a forbidden
      // section does -- and Customers must remain absent, unaffected by the
      // transition.
      fixture.componentInstance.submitQuery('John');
      await flush(fixture);

      const resourcesMidFlight = host.querySelector('[data-test="section-resources"]');
      expect(resourcesMidFlight).toBeTruthy(); // header still present: NOT the omit mechanism
      expect(resourcesMidFlight!.textContent).not.toContain('Julie Armstrong'); // stale content gone
      expect(resourcesMidFlight!.textContent).not.toContain('John Smith'); // new content not arrived yet
      expect(resourcesMidFlight!.querySelector('[role="status"][aria-busy="true"]')).toBeTruthy(); // the loading skeleton
      expect(host.querySelector('[data-test="section-customers"]')).toBeFalsy(); // forbidden: still absent, never confused with loading

      // Let the second fetch resolve.
      vi.advanceTimersByTime(50);
      await flush(fixture);
      expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('John Smith');
      expect(host.querySelector('[data-test="section-customers"]')).toBeFalsy();
    });
  });

  // --- Server-side truncation must be visible. These six reads are ALWAYS
  // paginated by the server (clampSearchPage): sending no `limit` means 20 rows,
  // not "everything", and the response is a bare array with no total. The screen
  // used to render that page as the complete answer, so a query matching 400
  // people looked like it matched 20 and the other 380 were unreachable. ---

  describe('the page the server actually returned is disclosed as a page', () => {
    /** `n` resources whose names are all distinct, so `track r.id` is stable. */
    function resourcePage(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `R-${i}`, name: `Julie Match ${i}`, role: 'Developer', kind: 'internal',
      }));
    }

    function hintIn(fixture: { nativeElement: unknown }, section: string): HTMLElement | null {
      const host = fixture.nativeElement as HTMLElement;
      // Scoped to the section: an unscoped query would be satisfied by ANY
      // section's hint, so a per-section bug would hide behind a sibling.
      return host.querySelector<HTMLElement>(`[data-test="section-${section}"] [data-test="truncation-hint"]`);
    }

    it('asks each collection for the server maximum, not the silent default of 20', async () => {
      const calls: Record<string, unknown> = {};
      const record = (key: string) => vi.fn((opts: unknown) => { calls[key] = opts; return of([]); });
      const getResources = record('resources');
      const getRequests = record('requests');
      const getProjects = record('projects');
      const getCustomers = record('customers');
      const getContracts = record('contracts');
      const getOrders = record('orders');
      await setupAndSubmit({ getResources, getRequests, getProjects, getCustomers, getContracts, getOrders });

      // All six legs, not just the one that happens to be asserted elsewhere:
      // a limit added to five of six leaves the sixth silently truncating.
      for (const key of ['resources', 'requests', 'projects', 'customers', 'contracts', 'orders']) {
        expect(calls[key], `the ${key} leg must have been called`).toStrictEqual({ q: 'Julie', limit: SEARCH_MAX_LIMIT });
      }
    });

    it('a full page carries the "first N matches" hint', async () => {
      const fixture = await setupAndSubmit({ getResources: () => of(resourcePage(SEARCH_MAX_LIMIT)) });
      const hint = hintIn(fixture, 'resources');
      expect(hint).toBeTruthy();
      expect(hint!.textContent).toContain(`first ${SEARCH_MAX_LIMIT} matches`);
    });

    it('a page ONE row short of the limit carries no hint (the absence twin)', async () => {
      // Without this case a banner hard-coded into the template would satisfy the
      // presence half above, and every search would claim to be truncated.
      const fixture = await setupAndSubmit({ getResources: () => of(resourcePage(SEARCH_MAX_LIMIT - 1)) });
      expect(hintIn(fixture, 'resources')).toBeFalsy();
      // ...and the section itself DID render its rows, so the absence above is
      // "no hint", not "no section".
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Match 0');
    });

    it('an empty result set carries no hint either', async () => {
      const fixture = await setupAndSubmit({ getResources: () => of([]) });
      expect(hintIn(fixture, 'resources')).toBeFalsy();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('No results');
    });

    it('the hint is per-section: a full Resources page does not stamp one onto Projects', async () => {
      const fixture = await setupAndSubmit({
        getResources: () => of(resourcePage(SEARCH_MAX_LIMIT)),
        getProjects: () => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]),
      });
      expect(hintIn(fixture, 'resources')).toBeTruthy();
      expect(hintIn(fixture, 'projects')).toBeFalsy();
    });
  });

  // ===========================================================================
  // Row navigation. Every assertion here is PAIRED, because the whole risk is
  // one-sided: a component that links unconditionally satisfies "is a link", and
  // one that never links satisfies "is not a link". Only both together pin it.
  //
  // The gate is the TARGET ROUTE's guard, not this screen's section pre-filter.
  // The two disagree for all six sections, and `projects` is the extreme — the
  // section is open to any authenticated principal while /projects/:id demands
  // staffing read, so an unconditional link would advertise a route the router
  // refuses.
  // ===========================================================================
  describe('result rows navigate, and only where the target route would admit the caller', () => {
    const ROWS = {
      getResources: () => of([{ id: 'R1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]),
      getRequests: () => of([{ id: 'RQ1', name: 'Julie backfill', requiredRole: 'Developer', requiredEffort: 10, status: 'Open', skills: [] }]),
      getProjects: () => of([{ id: 'P1', name: 'Julie Alpha', location: 'Berlin' }]),
      getCustomers: () => of([{ id: 'C1', name: 'Julie Industries' }]),
      getContracts: () => of([{ id: 'CT1', name: 'Julie MSA' }]),
      getOrders: () => of([{ id: 'O1', invoiceNumber: 'INV-JULIE-1' }]),
    };

    /** Every identity a row could be rendered for, at full privilege. */
    const ALL = {
      canReadStaffing: () => true, canReadCommercial: () => true,
      canManageStaffing: () => true, canManageCommercial: () => true,
      role: () => 'admin' as const,
    };

    const linkIn = (fixture: { nativeElement: unknown }, section: string) =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(`[data-test="search-hit-${section}"]`);

    const sectionText = (fixture: { nativeElement: unknown }, section: string) =>
      (fixture.nativeElement as HTMLElement).querySelector(`[data-test="section-${section}"]`)?.textContent ?? '';

    it('the two detail sections link to the item itself, by id', async () => {
      const fixture = await setupAndSubmit(ROWS, ALL);
      expect(linkIn(fixture, 'projects')?.getAttribute('href')).toBe('/projects/P1');
      expect(linkIn(fixture, 'contracts')?.getAttribute('href')).toBe('/contracts/CT1');
    });

    it('the list sections link to their list, filtered on the label the row shows', async () => {
      const fixture = await setupAndSubmit(ROWS, ALL);
      expect(linkIn(fixture, 'resources')?.getAttribute('href')).toBe('/resources?q=Julie%20Armstrong');
      expect(linkIn(fixture, 'customers')?.getAttribute('href')).toBe('/customers?q=Julie%20Industries');
      // Orders are labelled by invoice number, which is also what /orders filters
      // on — seeding a `name` it does not have would dead-end on an empty list.
      expect(linkIn(fixture, 'orders')?.getAttribute('href')).toBe('/orders?q=INV-JULIE-1');
    });

    it('requests stay inert for EVERY identity: /requests cannot show another user request', async () => {
      const fixture = await setupAndSubmit(ROWS, ALL);
      expect(linkIn(fixture, 'requests'), 'a link here would be a lie').toBeNull();
      // ABSENCE HALF: the row must still be RENDERED, just not as a link.
      expect(sectionText(fixture, 'requests')).toContain('Julie backfill');
    });

    // --- The gate, section by section: denied identity, then granted. ---

    it('projects: NO link without staffing read, even though the section itself is open', async () => {
      const fixture = await setupAndSubmit(ROWS, { ...ALL, canReadStaffing: () => false });
      expect(linkIn(fixture, 'projects')).toBeNull();
      // The row is still visible — that is precisely why the gate is needed.
      expect(sectionText(fixture, 'projects')).toContain('Julie Alpha');
    });

    it('projects: link once staffing read is granted', async () => {
      const fixture = await setupAndSubmit(ROWS, ALL);
      expect(linkIn(fixture, 'projects')).not.toBeNull();
    });

    it('contracts, customers, orders: NO link on commercial READ alone — the routes demand manage', async () => {
      const fixture = await setupAndSubmit(ROWS, { ...ALL, canManageCommercial: () => false });
      for (const section of ['contracts', 'customers', 'orders']) {
        expect(linkIn(fixture, section), section).toBeNull();
      }
      expect(sectionText(fixture, 'contracts')).toContain('Julie MSA');
    });

    it('contracts, customers, orders: link once commercial manage is granted', async () => {
      const fixture = await setupAndSubmit(ROWS, ALL);
      for (const section of ['contracts', 'customers', 'orders']) {
        expect(linkIn(fixture, section), section).not.toBeNull();
      }
    });

    it('resources: NO link for a role outside the three /resources admits', async () => {
      const fixture = await setupAndSubmit(ROWS, { ...ALL, role: () => 'pm' as const });
      expect(linkIn(fixture, 'resources')).toBeNull();
      expect(sectionText(fixture, 'resources')).toContain('Julie Armstrong');
    });

    it('resources: link for a role the route admits', async () => {
      const fixture = await setupAndSubmit(ROWS, { ...ALL, role: () => 'resource-manager' as const });
      expect(linkIn(fixture, 'resources')).not.toBeNull();
    });

    it('an inert row is plain text, never a disabled or href-less anchor', async () => {
      // An <a> with no href is unreachable by keyboard and announced as a link
      // that goes nowhere; the row must not be an anchor at all.
      const fixture = await setupAndSubmit(ROWS, { ...ALL, canReadStaffing: () => false });
      const projects = (fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')!;
      expect(projects.querySelectorAll('a').length).toBe(0);
    });
  });
});
