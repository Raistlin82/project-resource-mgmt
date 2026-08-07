import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError, type Observable } from 'rxjs';
import { ResourcesComponent } from './resources.component';
import { ApiService, Resource, ResourceOrganization, RateCard, Assignment, Vendor, Project, ResourceRequest } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { localIsoDate, todayLocalIso } from '../services/local-date.util';

/** Two internal resources and one subco (vendor V4) — the seeded shape from Task 2. */
const RESOURCES: Resource[] = [
  { id: '1', name: 'Alice', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '2', name: 'Bob', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '6', name: 'External Co', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'subco', vendorId: 'V4' },
];

const VENDORS: Vendor[] = [{ id: 'V4', name: 'Acme Staffing' }];

/**
 * D (Task 8): Engineering (capability) > Platform (practice) > Backend (competence),
 * plus Consulting, a capability with no children of its own — same ids the real
 * seed uses ('2'/'5'/'6'), so the fixture reads as the seeded shape.
 */
const ORG_NODES: ResourceOrganization[] = [
  { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
  { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
  { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
  { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
];

/** Jane Doe sits on Backend (competence, two levels under Engineering);
 *  John Miller sits directly on Consulting (a capability with no children).
 *  Each has a distinct People Manager, so the manager filter has something
 *  to discriminate on too. */
const ORG_RESOURCES: Resource[] = [
  { id: '10', name: 'Jane Doe', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Backend', managerId: 'm1' },
  { id: '11', name: 'John Miller', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Consulting', managerId: 'm2' },
  { id: 'm1', name: 'Mona Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'm2', name: 'Nora Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];


function setup(
  // `resources` accepts an Observable as well as an array: the read-failure
  // specs below have to hand it a throwError(...), and an array-only parameter
  // makes that test literally unwritable.
  resources: Resource[] | Observable<Resource[]> = RESOURCES,
  orgNodes: ResourceOrganization[] | Observable<ResourceOrganization[]> = [],
  rateCards: RateCard[] | Observable<RateCard[]> = [],
  assignments$: Observable<Assignment[]> = of([]),
  // The pre-authReady window is a real state of this screen (SSR + the whole
  // OIDC bootstrap), not a test artefact, so it needs to be settable here.
  authReady = true,
  // Block H (U18): the `assignment -> request -> project` join that decides which
  // booked hours are chargeable. An OPTIONS OBJECT rather than two more
  // positional slots — `authReady` already holds the 5th, so two trailing arrays
  // would make every billability call site read `setup(r, [], [], a$, true, [], [])`
  // and put the interesting arguments furthest from the eye. Defaulting BOTH to
  // `[]` reproduces the pre-H call site exactly, which is what makes the
  // differential tests below able to disagree with each other.
  join: {
    requests?: ResourceRequest[] | Observable<ResourceRequest[]>;
    projects?: Project[] | Observable<Project[]>;
  } = {},
) {
  const getResources = vi.fn(() => (Array.isArray(resources) ? of(resources) : resources));
  const getProjectRoles = vi.fn(() => of([]));
  const getResourceOrganizations = vi.fn(() => (Array.isArray(orgNodes) ? of(orgNodes) : orgNodes));
  const getCountries = vi.fn(() => of([]));
  const getCities = vi.fn(() => of([]));
  const getRateCards = vi.fn(() => (Array.isArray(rateCards) ? of(rateCards) : rateCards));
  const getVendors = vi.fn(() => of(VENDORS));
  const getAssignments = vi.fn(() => assignments$);
  const requests = join.requests ?? [];
  const projects = join.projects ?? [];
  const getRequests = vi.fn(() => (Array.isArray(requests) ? of(requests) : requests));
  const getProjects = vi.fn(() => (Array.isArray(projects) ? of(projects) : projects));
  const createResource = vi.fn(() => of({} as Resource));
  const updateResource = vi.fn(() => of({} as Resource));
  const apiStub = {
    getResources, getProjectRoles, getResourceOrganizations, getCountries, getCities,
    getRateCards, getVendors, getAssignments, getRequests, getProjects, createResource, updateResource,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(authReady), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ResourcesComponent],
    providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ResourcesComponent);
  return { fixture, getResources, getResourceOrganizations, getVendors, getRequests, getProjects, createResource, updateResource, notifyStub };
}

/** N days from today in LOCAL calendar terms — the same clock the component's
 *  own Active/Terminated split reads (todayLocalIso), so nothing below can flip
 *  with the runner's timezone. */
function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

/** The Status cell (7th column) of the row for `name`, or '' when absent. */
function statusCellText(host: HTMLElement, name: string): string {
  const row = [...host.querySelectorAll('tbody tr')].find(
    tr => tr.querySelector('[data-test="resource-name"]')?.textContent?.trim() === name,
  );
  return row?.querySelectorAll('td')[6]?.textContent?.trim() ?? '';
}

/** Recorded NotificationService messages, in call order. */
function toasts(notifyStub: NotificationService): string[] {
  return (notifyStub.show as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
}

/**
 * The LIST region's own loading region, identified by the sr-only label
 * app-list-state renders from its `label` input. Scoped deliberately: this
 * screen mounts a SECOND app-list-state (the rate-card/billability one, label
 * "rate card details"), so a bare `[role="status"]`/`.command-skeleton` query
 * cannot tell which region is loading.
 */
function listLoadingRegion(host: HTMLElement): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(el => el.textContent?.includes('Loading resources')) ?? null;
}

/**
 * `resourcesRes`/`orgsRes` are protected template-only members (the file's own
 * convention for its rxResources). The read-failure specs need their status as a
 * POSITIVE CONTROL — without it a test can pass because the read it meant to
 * break quietly succeeded — so read it through one narrow, named accessor rather
 * than widening the component's surface for the tests' convenience.
 */
function statusOf(component: ResourcesComponent, key: 'resourcesRes' | 'orgsRes'): string {
  return (component as unknown as Record<string, { status: () => string }>)[key].status();
}

/** The Retry control inside app-list-state's error panel, or null. */
function retryButton(host: HTMLElement): HTMLButtonElement | null {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')]
    .find(b => b.textContent?.includes('Retry')) ?? null;
}

/**
 * Walk outward from `el` to the nearest ancestor that CLIPS (`overflow-hidden`)
 * and report whether anything on that path opts into horizontal panning
 * (`overflow-x-auto`). Returns false when the clipper is reached first — that is
 * the shape in which content wider than the card is unreachable: no scrollbar,
 * no touch pan, no wheel pan.
 */
function hasHorizontalPanPort(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.classList.contains('overflow-x-auto')) return true;
    if (node.classList.contains('overflow-hidden')) return false;
  }
  return false;
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ResourcesComponent', () => {
  it('shows the vendor field only when the kind is subco', async () => {
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();

    fixture.componentInstance.form.controls.kind.setValue('subco');
    fixture.detectChanges();
    expect(host.querySelector('[data-test="res-vendor"]')).not.toBeNull();

    fixture.componentInstance.form.controls.kind.setValue('internal');
    fixture.detectChanges();
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();
  });

  it('marks the vendor control required for a subco and optional otherwise', () => {
    const { fixture } = setup();
    const form = fixture.componentInstance.form;

    form.controls.kind.setValue('subco');
    form.controls.vendorId.setValue('');
    expect(form.controls.vendorId.valid).toBe(false);

    form.controls.kind.setValue('internal');
    expect(form.controls.vendorId.valid).toBe(true);
  });

  it('clears a previously-picked vendor when kind is switched back to internal', () => {
    const { fixture } = setup();
    const form = fixture.componentInstance.form;

    form.controls.kind.setValue('subco');
    form.controls.vendorId.setValue('V4');
    expect(form.controls.vendorId.value).toBe('V4');

    form.controls.kind.setValue('internal');
    expect(form.controls.vendorId.value).toBe('');
  });

  it('blocks saving a subco with no vendor selected, and allows it once one is picked', async () => {
    const { fixture, createResource } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.componentInstance.form.patchValue({ name: 'New Sub', role: 'Consultant', hireDate: '2026-01-01', kind: 'subco' });
    fixture.detectChanges();

    expect(fixture.componentInstance.form.invalid).toBe(true);
    fixture.componentInstance.save();
    expect(createResource).not.toHaveBeenCalled();

    fixture.componentInstance.form.controls.vendorId.setValue('V4');
    expect(fixture.componentInstance.form.valid).toBe(true);
    fixture.componentInstance.save();
    expect(createResource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'subco', vendorId: 'V4' }));
  });

  it('loads an existing subco with its vendor pre-filled, valid, and the vendor field shown', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const subco = RESOURCES.find(r => r.id === '6')!;
    fixture.componentInstance.openForm(subco);
    fixture.detectChanges();

    // No further interaction (no setValue/markAsTouched) — the load itself must
    // already leave the form in this state.
    const form = fixture.componentInstance.form;
    expect(form.controls.kind.value).toBe('subco');
    expect(form.controls.vendorId.value).toBe('V4');
    expect(form.controls.vendorId.valid).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    const vendorSelect = host.querySelector('[data-test="res-vendor"]') as HTMLSelectElement | null;
    expect(vendorSelect).not.toBeNull();
    expect(vendorSelect!.value).toBe('V4');
  });

  it('loads an existing internal resource with no vendor field and a valid vendorId control', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const internal = RESOURCES.find(r => r.id === '1')!;
    fixture.componentInstance.openForm(internal);
    fixture.detectChanges();

    const form = fixture.componentInstance.form;
    expect(form.controls.kind.value).toBe('internal');
    expect(form.controls.vendorId.valid).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();
  });

  it('badges only the non-internal resources and lets the kind filter isolate one kind', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const tbody = host.querySelector('tbody') as HTMLElement;
    expect(tbody.textContent).toContain('Subcontractor');
    // The badge marks the exception; internal rows carry no pill at all.
    // (The kind FILTER still offers "Internal" — that's a different control.)
    expect(tbody.textContent).not.toContain('Internal');
    expect(tbody.querySelectorAll('.command-status.amber').length).toBe(1);

    fixture.componentInstance.kindFilter.set('subco');
    fixture.detectChanges();
    expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['6']);

    const rows = host.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('External Co');
  });

  it('offers only internal resources as People Managers', async () => {
    // C1: a dummy is nobody and a subco is outside the internal reporting line;
    // either would otherwise show up as the approver on the allocation feed.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(RESOURCES.find(r => r.id === '1')!);
    fixture.detectChanges();

    expect(fixture.componentInstance.managerOptions().map(r => r.id)).toEqual(['2']);

    const host = fixture.nativeElement as HTMLElement;
    const options = Array.from(host.querySelectorAll('#res-manager option')).map(o => o.textContent?.trim());
    expect(options).not.toContain('External Co');
  });

  describe('org-dimension and people-manager filters (D, Task 8)', () => {
    it('filters the list by capability', async () => {
      // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
      // one on 'Consulting' (a capability of its own).
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');        // on Backend, under Engineering
      expect(names).not.toContain('John Miller'); // on Consulting
    });

    it('offers only the dimensions that exist in the tree', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="filter-bar-facet-capability"] option')]
        .map(o => o.value);
      expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
    });

    it('filters the list by practice', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      fixture.componentInstance.practiceFilter.set('Platform');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('filters the list by competence', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      fixture.componentInstance.competenceFilter.set('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('filters the list by People Manager and offers only the managers present', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="filter-bar-facet-manager"] option')]
        .map(o => o.textContent?.trim());
      expect(opts).toEqual(['All people managers', 'Mona Manager', 'Nora Manager']);

      fixture.componentInstance.managerFilter.set('m1');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('composes two dimension filters (capability AND manager) — the intersection, not the union', async () => {
      // Jane Doe (Backend/Engineering, manager m1) and John Miller
      // (Consulting, manager m2) sit on DISJOINT capability/manager pairs. An
      // OR-composition bug would keep BOTH once a second filter is added
      // (either one matches); the correct AND keeps NEITHER.
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']); // Jane alone

      fixture.componentInstance.managerFilter.set('m2');
      fixture.detectChanges();
      // AND, not OR: a future edit that silently OR'd the two predicates
      // would show both (Jane via capability, John via manager) instead of
      // the correct empty intersection.
      expect(fixture.componentInstance.filteredResources()).toEqual([]);

      fixture.componentInstance.capabilityFilter.set('');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['11']); // manager=m2 alone is John
    });

    it('composes a dimension filter with the pre-existing search filter — the intersection, not either alone', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);

      fixture.componentInstance.search.set('Doe');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']); // Jane Doe alone

      fixture.componentInstance.capabilityFilter.set('Consulting');
      fixture.detectChanges();
      // AND, not OR: search='Doe' matches only Jane (organization Backend),
      // and capability='Consulting' matches only John — their intersection
      // is empty, not the 2-resource union an OR-composition bug would produce.
      expect(fixture.componentInstance.filteredResources()).toEqual([]);

      fixture.componentInstance.search.set('');
      fixture.detectChanges();
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['11']); // capability alone is John
    });
  });

  describe('rate-card inheritance and provenance (rate-card-inheritance block, Task 3)', () => {
    /** Same tree as the org-dimension describe block above: Engineering
     *  (capability) > Platform (practice) > Backend (competence). */
    const RATE_CARDS_ANCESTOR: RateCard[] = [
      { id: 'GEN', role: 'Developer', currency: 'EUR', costRate: 600, billRate: 1120 },
      { id: 'ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 640, billRate: 1200 },
    ];
    const RATE_CARDS_OWN: RateCard[] = [
      ...RATE_CARDS_ANCESTOR,
      { id: 'BACK', role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 },
    ];

    it("inheritedRate resolves the ancestor card when the resource's own node has none", async () => {
      const { fixture } = setup(RESOURCES, ORG_NODES, RATE_CARDS_ANCESTOR);
      await flush(fixture);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.inheritedRate()).toEqual(RATE_CARDS_ANCESTOR[1]); // Engineering, not generic
    });

    it("inheritedRate keeps the resource's own card even when an ancestor also has one", async () => {
      const { fixture } = setup(RESOURCES, ORG_NODES, RATE_CARDS_OWN);
      await flush(fixture);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.inheritedRate()).toEqual(RATE_CARDS_OWN[2]); // Backend's own, not Engineering's
    });

    it('rateCardProvenance labels an ancestor match as Inherited from Engineering', async () => {
      const { fixture } = setup(RESOURCES, ORG_NODES, RATE_CARDS_ANCESTOR);
      await flush(fixture);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.rateCardProvenance()).toBe('Inherited from Engineering');
    });

    it('rateCardProvenance labels an own-node match without the word inherited', async () => {
      const { fixture } = setup(RESOURCES, ORG_NODES, RATE_CARDS_OWN);
      await flush(fixture);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      const provenance = fixture.componentInstance.rateCardProvenance();
      expect(provenance).toBe('the Backend rate card');
      expect(provenance).not.toContain('Inherited');
    });

    it('rateCardProvenance labels a generic-card match without naming any node', async () => {
      const genericOnly: RateCard[] = [{ id: 'GEN', role: 'Developer', currency: 'EUR', costRate: 600, billRate: 1120 }];
      const { fixture } = setup(RESOURCES, ORG_NODES, genericOnly);
      await flush(fixture);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.rateCardProvenance()).toBe('the generic rate card');
    });

    it('renders the ancestor provenance sentence in the form hint, scoped to the hint element', async () => {
      const { fixture } = setup(RESOURCES, ORG_NODES, RATE_CARDS_ANCESTOR);
      await flush(fixture);
      fixture.componentInstance.showForm.set(true);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const provenanceEl = host.querySelector('[data-test="rate-card-provenance"]');
      expect(provenanceEl?.textContent?.trim()).toBe('Inherited from Engineering.');
    });

    it('rateCardProvenance is null while orgsRes is still loading', async () => {
      // No generic card in this fixture, deliberately: an Engineering-only
      // card that COULD resolve for Backend once the tree loads, so a null
      // result here proves the component isn't guessing ahead of the tree —
      // not merely that there was nothing to resolve either way.
      const orgs$ = new Subject<ResourceOrganization[]>();
      const apiStub = {
        getResources: () => of(RESOURCES),
        getProjectRoles: () => of([]),
        getResourceOrganizations: () => orgs$,
        getCountries: () => of([]),
        getCities: () => of([]),
        getRateCards: () => of([{ id: 'ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 640, billRate: 1200 }] as RateCard[]),
        getVendors: () => of([]),
      } as unknown as ApiService;
      const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;
      const notifyStub = { show: vi.fn() } as unknown as NotificationService;
      TestBed.configureTestingModule({
        imports: [ResourcesComponent],
        providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
          { provide: ApiService, useValue: apiStub },
          { provide: AuthService, useValue: authStub },
          { provide: NotificationService, useValue: notifyStub },
        ],
      });
      const fixture = TestBed.createComponent(ResourcesComponent);
      // whenStable() HANGS here — orgs$ is a deliberately open stream. Tick
      // microtasks instead, so every OTHER (synchronous) read still settles.
      fixture.detectChanges();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      fixture.detectChanges();

      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();
      expect(fixture.componentInstance.rateCardProvenance()).toBeNull();
    });

    it('shows the error panel, not a stale/crashing provenance, when rate cards fail to load', async () => {
      // review round 1 (Important 1): inheritedRate/rateCardProvenance read
      // this.rateCards()/this.orgOptions() UNGATED -- rxResource.value() THROWS
      // ResourceValueError when status() === 'error', so without the gate this
      // would crash the render instead of showing app-list-state's error panel.
      const { fixture } = setup(RESOURCES, ORG_NODES, throwError(() => new Error('401 Unauthorized')));
      await flush(fixture);
      fixture.componentInstance.showForm.set(true);
      fixture.componentInstance.form.controls.role.setValue('Developer');
      fixture.componentInstance.form.controls.organization.setValue('Backend');
      fixture.detectChanges();

      expect(fixture.componentInstance.rateFiguresState()).toBe('error');
      expect(fixture.componentInstance.rateCardProvenance()).toBeNull();
      const host = fixture.nativeElement as HTMLElement;
      // Absence pair to the presence assertions elsewhere in this block: no
      // provenance text, no "No rate card for this role" false confident
      // claim either -- the error state must render NEITHER.
      expect(host.querySelector('[data-test="rate-card-provenance"]')).toBeNull();
      expect(host.textContent).not.toContain('No rate card for this role');
    });
  });

  describe('resourceBillability wiring (rate-card-inheritance block, Task 4)', () => {
    /** Alice, already effective-rated (as if resolved server-side): 75 EUR/h
     *  cost, 140 EUR/h bill -- same per-hour figures finance.util.spec.ts's own
     *  pinned resourceBillability test uses, so the expected numbers below
     *  (100h -> cost 7500, billable 14000) are independently cross-checked
     *  against that existing pure-function test, not invented fresh here. */
    const BILLABILITY_RESOURCES: Resource[] = [
      { id: '1', name: 'Alice', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', costRate: 75, billRate: 140 },
    ];
    const BILLABILITY_ASSIGNMENTS: Assignment[] = [
      { id: 'a1', requestId: 'r1', resourceId: '1', assignedHours: 100, status: 'Allocated' },
    ];

    it('shows cost/billable/hours once resources, org tree and assignments are all ready', async () => {
      const { fixture } = setup(BILLABILITY_RESOURCES, [], [], of(BILLABILITY_ASSIGNMENTS));
      await flush(fixture);
      fixture.componentInstance.editingId.set('1');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      // `toStrictEqual`, upgraded from `toEqual` when block H made this call site
      // load-bearing (U18). The upgrade is deliberate and the stricter behaviour
      // is the POINT: `resourceBillability`'s return shape is what the screen
      // renders, so a third figure appearing there must fail here and be read by
      // a human, not slide in. (H considered adding a chargeable/non-chargeable
      // hours split and rejected it — see the template comment: the split would
      // duplicate finance.util.ts's own join.) Alice's fixture has no `requests`
      // and no `projects`, so 100h -> 14000 is the `billable ?? true` answer, and
      // that is correct for her: she is the control that proves H changed nothing
      // for a caller with nothing non-billable to exclude.
      expect(fixture.componentInstance.billability()).toStrictEqual({ hours: 100, cost: 7500, billable: 14000 });
      const host = fixture.nativeElement as HTMLElement;
      const billabilityEl = host.querySelector('[data-test="resource-billability"]');
      // digitsInfo '1.0-2' (this codebase's established convention for money,
      // e.g. contract-details.ts:271) shows AT MOST 2 decimals, not exactly 2 --
      // a whole number renders with none. 7500/14000 are both whole, so the
      // correct expectation is '7,500'/'14,000', not '7,500.00'/'14,000.00'.
      expect(billabilityEl?.textContent).toContain('7,500');
      expect(billabilityEl?.textContent).toContain('14,000');
    });

    it('shows the error panel, not a zero, when assignments fails to load', async () => {
      const { fixture } = setup(BILLABILITY_RESOURCES, [], [], throwError(() => new Error('401 Unauthorized')));
      await flush(fixture);
      fixture.componentInstance.editingId.set('1');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      expect(fixture.componentInstance.rateFiguresState()).toBe('error');
      expect(fixture.componentInstance.billability()).toBeNull();
      const host = fixture.nativeElement as HTMLElement;
      // No presence assertion alone: also assert the number that would have
      // rendered on a silent-zero regression is genuinely absent from the DOM.
      expect(host.querySelector('[data-test="resource-billability"]')).toBeNull();
      expect(host.textContent).not.toContain('0.00');
    });

    it('shows nothing (not null-as-zero) while creating a new resource', async () => {
      const { fixture } = setup(BILLABILITY_RESOURCES, [], [], of(BILLABILITY_ASSIGNMENTS));
      await flush(fixture);
      fixture.componentInstance.editingId.set(null);
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      expect(fixture.componentInstance.billability()).toBeNull();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('[data-test="resource-billability"]')).toBeNull();
    });
  });

  /**
   * Block H, U18 / F-8 — jsdom does NOT lay out, so nothing here proves the figure
   * is visible or reachable; these are STRUCTURAL assertions on the computed value
   * and on the rendered text node.
   *
   * The defect this block closes was not in `resourceBillability`: T5 corrected the
   * function and pinned it. The defect was that this screen's ONLY call site built
   * its `FinanceData` with `requests: []` and no `projects` at all, so every id
   * resolved `billable ?? true`, the corrected branch was never entered, and the
   * figure stayed at its pre-H value with the whole suite green. That is this
   * project's recurring failure mode — a right function reached by an empty input —
   * so the assertions below are DIFFERENTIAL by construction: the same Sofia
   * fixture, once with the join and once without, has to disagree. A test that
   * only asserted the correct wired number would pass just as happily against a
   * component that ignored both new reads.
   */
  describe('billability excludes non-billable engagements (block H, U18/F-8 — structural, not visual: jsdom does no layout)', () => {
    /**
     * Sofia Ferrari, seed resource '14', at her seeded rates (600 EUR/day cost,
     * 1120 EUR/day bill) and her seeded split: 176 h on project '3' (the BASKET
     * engagement, `billable: false`) and 872 h on project '1' (billable). She
     * exists in the seed for exactly this: one person carrying BOTH kinds of
     * hours, so the two plausible wrong answers are both excluded — uncorrected
     * (all 1,048 h priced) and over-corrected (none priced). Her rates are
     * load-bearing: she shipped without them once and all three candidate
     * answers collapsed to 0, which made the fixture built to prevent a blind
     * gate into one (seed.ts, H/T2).
     */
    const SOFIA: Resource[] = [
      { id: '14', name: 'Sofia Ferrari', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 100, capacity: 40, kind: 'internal', costRate: 600, billRate: 1120 },
    ];
    const SOFIA_ASSIGNMENTS: Assignment[] = [
      { id: '15', requestId: '15', resourceId: '14', assignedHours: 176, status: 'Allocated' },
      { id: '16', requestId: '16', resourceId: '14', assignedHours: 872, status: 'Allocated' },
    ];
    const SOFIA_REQUESTS: ResourceRequest[] = [
      { id: '15', name: 'BASKET Engineering - AMS presidio', requiredRole: 'Developer', requiredEffort: 176, status: 'Fulfilled', skills: [], projectId: '3' },
      { id: '16', name: 'Project Alpha - Sofia full allocation', requiredRole: 'Developer', requiredEffort: 872, status: 'Fulfilled', skills: [], projectId: '1' },
    ];
    const SOFIA_PROJECTS: Project[] = [
      { id: '1', name: 'Project Alpha', location: 'Milan', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', billable: true, type: 'Delivery' },
      { id: '3', name: 'BASKET - Engineering Practice', location: 'Milan', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', billable: false, type: 'Basket' },
    ];

    /** 1,048 h × 600 — UNCHANGED by H: she really did work them and really did cost that. */
    const TOTAL_COST = 628_800;
    /** 872 billable h × 1120 — what H reports. */
    const CHARGEABLE_WIRED = 976_640;
    /** 1,048 h × 1120 — the pre-H figure, i.e. what the unwired call site printed. */
    const CHARGEABLE_PRE_H = 1_173_760;

    // `resetTestingModule()` first: the differential tests below mount the SAME
    // component TWICE inside one `it`, which is the whole point — two fixtures, two
    // inputs, one comparison — and TestBed refuses a second `configureTestingModule`
    // after instantiation. Splitting each comparison across two `it`s would move
    // the assertion that the two DISAGREE out of the tests entirely, into the
    // reader's head, which is exactly where this project keeps losing it.
    async function billabilityFor(join: Parameters<typeof setup>[5]) {
      TestBed.resetTestingModule();
      const { fixture } = setup(SOFIA, [], [], of(SOFIA_ASSIGNMENTS), true, join);
      await flush(fixture);
      fixture.componentInstance.editingId.set('14');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();
      return { fixture, value: fixture.componentInstance.billability() };
    }

    it('prices only the hours booked on a billable project once requests and projects are wired', async () => {
      const { fixture, value } = await billabilityFor({ requests: SOFIA_REQUESTS, projects: SOFIA_PROJECTS });

      expect(value).toStrictEqual({ hours: 1048, cost: TOTAL_COST, billable: CHARGEABLE_WIRED });
      // The assertion that makes the one above mean something: the wired figure is
      // NOT the number the old call site produced. Without this, an implementation
      // that quietly kept passing `[]` would satisfy every line except this one.
      expect(value?.billable).not.toBe(CHARGEABLE_PRE_H);

      const el = (fixture.nativeElement as HTMLElement).querySelector('[data-test="resource-billability"]');
      expect(el?.textContent).toContain('976,640');
      expect(el?.textContent).not.toContain('1,173,760');
    });

    it('DIFFERENTIAL: the same fixture with the join omitted returns to the pre-H figure', async () => {
      // The absence twin. This is the state the screen was in before U18 — the
      // pre-H arithmetic to the digit — and asserting it explicitly is what proves
      // the fixture can move the number at all. A fixture that produced
      // CHARGEABLE_WIRED either way would certify nothing.
      const { value: noJoin } = await billabilityFor({});
      expect(noJoin).toStrictEqual({ hours: 1048, cost: TOTAL_COST, billable: CHARGEABLE_PRE_H });

      const { value: wired } = await billabilityFor({ requests: SOFIA_REQUESTS, projects: SOFIA_PROJECTS });
      expect(wired?.billable).not.toBe(noJoin?.billable);
      // Direction, not just difference: excluding non-billable work can only ever
      // LOWER the chargeable figure, and `cost`/`hours` must not move at all.
      expect(wired!.billable).toBeLessThan(noJoin!.billable);
      expect(wired!.cost).toBe(noJoin!.cost);
      expect(wired!.hours).toBe(noJoin!.hours);
    });

    it('DIFFERENTIAL: requests alone, or projects alone, is not enough — both halves of the join are read', async () => {
      // Two separate ways to leave the wiring half-done, both of which fall back
      // to `billable ?? true`: `projects` alone cannot resolve an assignment to a
      // project id, and `requests` alone has no `billable` flag to read. Each is a
      // plausible partial fix, and neither may pass.
      const { value: requestsOnly } = await billabilityFor({ requests: SOFIA_REQUESTS });
      const { value: projectsOnly } = await billabilityFor({ projects: SOFIA_PROJECTS });

      expect(requestsOnly?.billable).toBe(CHARGEABLE_PRE_H);
      expect(projectsOnly?.billable).toBe(CHARGEABLE_PRE_H);
    });

    it('leaves her BILLABLE engagement priced exactly as before — the exclusion is of hours, not of the person', async () => {
      // §8.1's paired assertion for F-8: alongside "the non-billable hours are
      // dropped" must sit "the billable ones are untouched". Same fixture minus
      // the BASKET booking: the chargeable figure is IDENTICAL to the wired one
      // above, which is only true if exactly the 176 non-billable hours were the
      // difference.
      const { fixture } = setup(
        SOFIA, [], [], of([SOFIA_ASSIGNMENTS[1]]), true,
        { requests: SOFIA_REQUESTS, projects: SOFIA_PROJECTS },
      );
      await flush(fixture);
      fixture.componentInstance.editingId.set('14');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      expect(fixture.componentInstance.billability()).toStrictEqual({ hours: 872, cost: 523_200, billable: CHARGEABLE_WIRED });
    });

    it('a failed /projects read shows the error panel, never the pre-H number', async () => {
      // The gate has to cover the new reads too. `[]` from a failed `/projects` is
      // not "we don't know": it is the precise input that makes everything read as
      // billable, so a read that fails while the gate ignores it would render the
      // OVERSTATED figure with nothing on screen saying anything went wrong. That
      // is worse than the original bug, because the original at least had no
      // error to hide.
      const { fixture } = setup(
        SOFIA, [], [], of(SOFIA_ASSIGNMENTS), true,
        { requests: SOFIA_REQUESTS, projects: throwError(() => new Error('403 Forbidden')) },
      );
      await flush(fixture);
      fixture.componentInstance.editingId.set('14');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      expect(fixture.componentInstance.rateFiguresState()).toBe('error');
      expect(fixture.componentInstance.billability()).toBeNull();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('[data-test="resource-billability"]')).toBeNull();
      expect(host.textContent).not.toContain('1,173,760');
      expect(host.textContent).not.toContain('976,640');
    });

    it('a failed /requests read shows the error panel too', async () => {
      const { fixture } = setup(
        SOFIA, [], [], of(SOFIA_ASSIGNMENTS), true,
        { requests: throwError(() => new Error('403 Forbidden')), projects: SOFIA_PROJECTS },
      );
      await flush(fixture);
      fixture.componentInstance.editingId.set('14');
      fixture.componentInstance.showForm.set(true);
      fixture.detectChanges();

      expect(fixture.componentInstance.rateFiguresState()).toBe('error');
      expect(fixture.componentInstance.billability()).toBeNull();
    });

    it('does not fire either new read before authReady', async () => {
      // Same authReady rule as every other read on this screen: a principal-gated
      // /api call made before the OIDC bootstrap settles goes out without a bearer,
      // 401s, and latches the view empty.
      const { fixture, getRequests, getProjects } = setup(SOFIA, [], [], of(SOFIA_ASSIGNMENTS), false, { requests: SOFIA_REQUESTS, projects: SOFIA_PROJECTS });
      await flush(fixture);

      expect(getRequests).not.toHaveBeenCalled();
      expect(getProjects).not.toHaveBeenCalled();
      // And the pre-auth window is 'loading', never a confident figure.
      expect(fixture.componentInstance.rateFiguresState()).toBe('loading');
    });
  });

  // Block G, Task 9: the migration to SearchFilterBarComponent silently changed
  // FOUR of these five facets' "All X" wording (nothing was asserting it) before
  // this block was added -- only the manager facet had a pre-existing test, which
  // is why that one alone caught the regression. These assert all five, plus each
  // facet's aria-label (the shared component's generic aria-label dropped the
  // "Filter by " prefix every original bespoke <select> carried).
  describe('facet wording and accessibility (Block G, Task 9 -- reproduces this screen\'s own pre-migration text, verified against resources.component.ts before the migration)', () => {
    it('Kind facet: "All kinds" pseudo-option and "Filter by Kind" aria-label', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-kind"]') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toBe('Filter by Kind');
      expect(select.querySelector('option')!.textContent?.trim()).toBe('All kinds');
    });

    it('Capability facet: "All capabilities" pseudo-option and "Filter by Capability" aria-label', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-capability"]') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toBe('Filter by Capability');
      expect(select.querySelector('option')!.textContent?.trim()).toBe('All capabilities');
    });

    it('Practice facet: "All practices" pseudo-option and "Filter by Practice" aria-label', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-practice"]') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toBe('Filter by Practice');
      expect(select.querySelector('option')!.textContent?.trim()).toBe('All practices');
    });

    it('Competence facet: "All competences" pseudo-option and "Filter by Competence" aria-label', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-competence"]') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toBe('Filter by Competence');
      expect(select.querySelector('option')!.textContent?.trim()).toBe('All competences');
    });

    it('People Manager facet: "All people managers" pseudo-option (byte-identical to pre-migration) and "Filter by People Manager" aria-label', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-manager"]') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toBe('Filter by People Manager');
      expect(select.querySelector('option')!.textContent?.trim()).toBe('All people managers');
    });
  });

  // Block G, Task 9: every OTHER test in this file that exercises a facet sets
  // the underlying signal directly (e.g. `kindFilter.set('subco')`), bypassing
  // `onFacetChange` entirely. That leaves the actual (change) -> onFacetChange
  // dispatch wired in the template UNEXERCISED -- a typo'd case label (e.g.
  // 'kindx' instead of 'kind') would ship with all 20 other tests green. These
  // drive a REAL DOM change event through each <select> instead.
  describe('facet (change) events reach onFacetChange (Block G, Task 9)', () => {
    it('selecting "Subco" in the Kind select narrows the list via onFacetChange', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-kind"]') as HTMLSelectElement;
      select.value = 'subco';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.kindFilter()).toBe('subco');
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['6']);
    });

    it('selecting "Engineering" in the Capability select narrows the list via onFacetChange', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-capability"]') as HTMLSelectElement;
      select.value = 'Engineering';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.capabilityFilter()).toBe('Engineering');
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('selecting "Platform" in the Practice select narrows the list via onFacetChange', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-practice"]') as HTMLSelectElement;
      select.value = 'Platform';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.practiceFilter()).toBe('Platform');
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('selecting "Backend" in the Competence select narrows the list via onFacetChange', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-competence"]') as HTMLSelectElement;
      select.value = 'Backend';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.competenceFilter()).toBe('Backend');
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });

    it('selecting "Mona Manager" in the People Manager select narrows the list via onFacetChange', async () => {
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const select = host.querySelector('[data-test="filter-bar-facet-manager"]') as HTMLSelectElement;
      select.value = 'm1';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.managerFilter()).toBe('m1');
      expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['10']);
    });
  });

  // "Active only" renders inside the SAME bordered toolbar strip as the filter
  // bar, directly beneath it, with no divider or separate section -- a user
  // reads it as one more active filter on this list (Block G, Task 9 ruling).
  // "Clear all" must therefore reset it too, not just the five select facets
  // and the text query.
  describe('"Clear all" resets "Active only" (Block G, Task 9 ruling)', () => {
    it('resets an unchecked "Active only" back to checked, via the REAL "Clear all" button', async () => {
      const { fixture } = setup();
      await flush(fixture);

      // Uncheck "Active only" and engage a facet, so activeChips() is
      // non-empty and the real "Clear all" button actually renders.
      fixture.componentInstance.activeOnly.set(false);
      fixture.componentInstance.kindFilter.set('subco');
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const clearAll = host.querySelector('[data-test="filter-bar-clear-all"]') as HTMLButtonElement;
      expect(clearAll).not.toBeNull();
      clearAll.click();
      fixture.detectChanges();

      expect(fixture.componentInstance.activeOnly()).toBe(true);
      expect(fixture.componentInstance.kindFilter()).toBe('');
    });

    it('leaves "Active only" at its default (true) when it was never touched', async () => {
      const { fixture } = setup();
      await flush(fixture);

      fixture.componentInstance.kindFilter.set('subco');
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const clearAll = host.querySelector('[data-test="filter-bar-clear-all"]') as HTMLButtonElement;
      clearAll.click();
      fixture.detectChanges();

      expect(fixture.componentInstance.activeOnly()).toBe(true);
    });
  });

  // A failed read must reach the ONE error affordance this screen has. The facet
  // bar renders ABOVE the app-list-state and dereferences both reads through
  // filterFacets(); an rxResource `.value()` THROWS while its status is 'error',
  // and a throw during change detection aborts the pass, so the panel written
  // for the failure was unreachable code and Retry could never be clicked.
  //
  // Every other spec in this file stubs BOTH reads with a synchronous of(...) —
  // which is exactly how this stayed green — so each case below carries a
  // positive control asserting the read it meant to break really did fail.
  describe('a failed list read reaches the error panel and its Retry', () => {
    it('renders the panel and Retry without throwing when the org tree fails and /resources succeeds', async () => {
      const { fixture } = setup(RESOURCES, throwError(() => new Error('500 Internal Server Error')));
      // The pre-fix throw happens INSIDE the render, so it surfaces here as a
      // rejected promise rather than as a failed expectation further down.
      await expect(flush(fixture)).resolves.toBeUndefined();

      expect(statusOf(fixture.componentInstance, 'orgsRes')).toBe('error');
      expect(statusOf(fixture.componentInstance, 'resourcesRes')).toBe('resolved');
      // ...and every SUBSEQUENT pass must stay clean, not just the first.
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain("Couldn't load resources");
      expect(retryButton(host)).not.toBeNull();
    });

    it('renders the panel and Retry, and KEEPS the filter bar, when /resources itself fails', async () => {
      const { fixture } = setup(throwError(() => new Error('401 Unauthorized')), ORG_NODES);
      await expect(flush(fixture)).resolves.toBeUndefined();

      expect(statusOf(fixture.componentInstance, 'resourcesRes')).toBe('error');
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain("Couldn't load resources");
      expect(retryButton(host)).not.toBeNull();

      // The filter bar must survive the failure rather than be moved inside the
      // wrapper: the query and the facet selections are the USER's own component
      // state, and blanking them on a failed reload would discard input the read
      // never owned. This is why the fix is a defensive accessor, not a move.
      const query = host.querySelector<HTMLInputElement>('[data-test="filter-bar-query"]');
      expect(query).not.toBeNull();
      fixture.componentInstance.search.set('Alice');
      fixture.detectChanges();
      expect(host.querySelector<HTMLInputElement>('[data-test="filter-bar-query"]')!.value).toBe('Alice');
    });

    it('shows NO error panel and the real rows/facets when both reads succeed', async () => {
      // The must-still-be-ALLOWED case. Without it, a guard that reported
      // failure unconditionally — or a template that always rendered the panel —
      // would satisfy both cases above.
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(statusOf(fixture.componentInstance, 'resourcesRes')).toBe('resolved');
      expect(statusOf(fixture.componentInstance, 'orgsRes')).toBe('resolved');
      expect(host.textContent).not.toContain("Couldn't load resources");
      expect(retryButton(host)).toBeNull();

      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');
      // The facet options are the very bindings the guard short-circuits, so
      // assert they are genuinely populated in the success case — an accessor
      // stuck at [] would pass the two failure cases above and fail here.
      const capabilities = [...host.querySelectorAll<HTMLOptionElement>('[data-test="filter-bar-facet-capability"] option')]
        .map(o => o.value);
      expect(capabilities).toEqual(['', 'Engineering', 'Consulting']);
    });

    it('Retry reloads BOTH the resource list and the org tree, not only the resources', async () => {
      const { fixture, getResources, getResourceOrganizations } =
        setup(RESOURCES, throwError(() => new Error('500 Internal Server Error')));
      await expect(flush(fixture)).resolves.toBeUndefined();
      expect(getResources).toHaveBeenCalledTimes(1);
      expect(getResourceOrganizations).toHaveBeenCalledTimes(1);

      const host = fixture.nativeElement as HTMLElement;
      retryButton(host)!.click();
      await flush(fixture);

      // The failing leg is the org tree: a Retry wired to resourcesRes alone
      // leaves the very read that broke the page still broken.
      expect(getResourceOrganizations).toHaveBeenCalledTimes(2);
      expect(getResources).toHaveBeenCalledTimes(2);
    });
  });

  // The 8-column table lays out at ~750px inside a card whose content box is
  // ~288px at a 320px viewport. The card clips with overflow-hidden (for its
  // rounded corners), so without an interposed pan port the Status column and
  // the whole Actions cell — Edit and Terminate, the only logical-deletion path
  // in the app — are simply unreachable: no scrollbar, no touch pan, no wheel pan.
  describe('the resources table can be panned horizontally', () => {
    it('interposes a pan port between the table and the clipping card — jsdom performs NO layout, so this proves the structural precondition ONLY, never reachability at 320px', async () => {
      // What jsdom cannot do: clientWidth/scrollWidth are both 0 here and no
      // grid/table tracks are computed, so the clipping itself is unassertable.
      // Proving the user can actually reach the Actions cell needs a real
      // browser at 320px (`table.scrollWidth > card.clientWidth` with
      // `card.scrollLeft` immovable) and there is no Playwright in this repo.
      const { fixture } = setup(ORG_RESOURCES, ORG_NODES);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      const table = host.querySelector('table.command-data-table');
      expect(table).not.toBeNull();
      // There must genuinely be something to escape from — if the card ever
      // stopped clipping, a green result below would mean nothing.
      expect(table!.closest('.overflow-hidden')).not.toBeNull();
      expect(hasHorizontalPanPort(table!)).toBe(true);
      // A width floor, so the port engages deterministically instead of relying
      // on the table's min-content exceeding the card.
      expect(table!.className).toMatch(/min-w-\[/);
    });

    it('the pan-port walk reports false for the pre-fix shape, so the green above is not a vacuous query', () => {
      // The register pairs this with a GREEN run of the same walk against
      // approvals.ts, which already gets this right — that file is outside this
      // change's ownership, so the discrimination is proved here instead, on the
      // two shapes themselves: table straight inside the clipper (unreachable)
      // vs. the same table behind a port (reachable).
      const card = document.createElement('div');
      card.className = 'command-card overflow-hidden';
      const table = document.createElement('table');
      table.className = 'command-data-table';
      card.appendChild(table);
      expect(hasHorizontalPanPort(table)).toBe(false);

      const port = document.createElement('div');
      port.className = 'overflow-x-auto';
      card.appendChild(port);
      port.appendChild(table);
      expect(hasHorizontalPanPort(table)).toBe(true);
    });
  });

  // `resourcesRes` resolves its pre-auth default ([]) SYNCHRONOUSLY while
  // authReady() is false, so isLoading() is false for the whole OIDC bootstrap
  // window and for the SSR HTML. Bound bare, app-list-state therefore rendered
  // the resolved-empty table — "No resources match the current filter.", a
  // claim about the user's FILTER — before any read had been made.
  describe('the pre-authReady window renders as loading, not as "no match"', () => {
    const EMPTY_COPY = 'No resources match the current filter.';

    it('shows the list skeleton and NOT the empty-filter copy while authReady() is false and the API has rows', async () => {
      // Non-empty API data is the point: the copy would be a lie about data
      // that exists and is about to arrive.
      const { fixture, getResources } = setup(RESOURCES, [], [], of([]), false);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      // Positive control: the read genuinely has not been made yet, so this is
      // the pre-auth window and not a resolved-empty collection.
      expect(getResources).not.toHaveBeenCalled();
      expect(statusOf(fixture.componentInstance, 'resourcesRes')).toBe('resolved');

      // The ABSENCE assertion first: it is the load-bearing half (the screen
      // must not make a claim about the filter), and the skeleton is merely what
      // replaces it.
      expect(host.textContent).not.toContain(EMPTY_COPY);
      expect(host.querySelectorAll('tbody tr').length).toBe(0);
      expect(listLoadingRegion(host)).not.toBeNull();
    });

    it('shows the empty-filter copy and NO skeleton once authReady() is true and the list really is empty', async () => {
      // The mirror, and the load-bearing half: a fix that pinned the skeleton
      // on forever — or deleted the empty state — passes the case above and
      // fails this one.
      const { fixture, getResources } = setup([], [], [], of([]), true);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(getResources).toHaveBeenCalledTimes(1);
      expect(listLoadingRegion(host)).toBeNull();
      expect(host.textContent).toContain(EMPTY_COPY);
    });

    it('renders the real rows (no skeleton, no empty copy) once authReady() is true and rows arrive', async () => {
      const { fixture } = setup(RESOURCES, [], [], of([]), true);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(listLoadingRegion(host)).toBeNull();
      expect(host.textContent).not.toContain(EMPTY_COPY);
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Alice', 'Bob', 'External Co']);
    });
  });

  // A terminationDate in the FUTURE is a notice period: stored, legitimate, and
  // NOT yet in effect. The dialog and the toast used to assert an accomplished
  // cessation for it while the list kept the resource Active, still counting
  // toward capacity and still offered as a People Manager.
  describe('a future termination date is announced as scheduled, not as done', () => {
    const MARCO: Resource[] = [
      { id: '1', name: 'Marco Bianchi', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
    ];

    /** Open the Terminate dialog for Marco with `date` chosen, then click the
     *  dialog's own confirm button (not the handler) so the wiring is exercised. */
    async function terminateWith(date: string) {
      const ctx = setup(MARCO, [], [], of([]), true);
      await flush(ctx.fixture);
      ctx.fixture.componentInstance.askTerminate(MARCO[0]);
      ctx.fixture.componentInstance.terminationDate.set(date);
      ctx.fixture.detectChanges();
      const host = ctx.fixture.nativeElement as HTMLElement;
      const copy = host.querySelector('[data-test="terminate-copy"]')!.textContent ?? '';
      const confirm = [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find(b => b.textContent?.trim() === 'Terminate contract')!;
      confirm.click();
      await flush(ctx.fixture);
      return { ...ctx, copy, host };
    }

    it('a notice period 30 days out: neither dialog nor toast says "terminated", and both name the date', async () => {
      const date = isoDaysFromToday(30);
      const { copy, notifyStub, updateResource } = await terminateWith(date);

      // The PUT is unchanged — a future notice-period end is legitimate and the
      // server deliberately accepts it. Only the claims made about it change.
      expect(updateResource).toHaveBeenCalledWith('1', { terminationDate: date });

      // The dialog states the FUTURE fact and names the date; what it must not
      // do is assert the accomplished one ("is marked Terminated"), which is
      // exactly the sentence the today/past branch keeps.
      expect(copy).toContain(date);
      expect(copy).toMatch(/will be marked Terminated on/);
      expect(copy).not.toMatch(/is marked Terminated/);

      const messages = toasts(notifyStub);
      expect(messages).toHaveLength(1);
      expect(messages[0]).not.toMatch(/terminated/i);
      expect(messages[0]).toContain(date);
    });

    it("today's date: the toast keeps the past tense, so the fix is not just vaguer wording", async () => {
      // The must-still-be-ALLOWED case. Without it, one deliberately vague
      // message ("contract updated") would satisfy the assertion above.
      const { copy, notifyStub } = await terminateWith(todayLocalIso());

      expect(toasts(notifyStub)[0]).toMatch(/terminated/i);
      expect(copy).toMatch(/is marked Terminated/);
      expect(copy).not.toMatch(/will be marked Terminated/);
    });

    it('the list distinguishes all three states its own predicate implies', async () => {
      const roster: Resource[] = [
        { ...MARCO[0], id: '1', name: 'Marco Bianchi', terminationDate: isoDaysFromToday(30) },
        { ...MARCO[0], id: '2', name: 'Elena Rossi', terminationDate: isoDaysFromToday(-30) },
        { ...MARCO[0], id: '3', name: 'Alice Verdi' },
      ];
      const { fixture } = setup(roster, [], [], of([]), true);
      await flush(fixture);
      fixture.componentInstance.activeOnly.set(false); // show the leaver too
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;

      // Exact cell text, so "Termination scheduled" cannot be read as either of
      // the other two chips by substring luck.
      expect(statusCellText(host, 'Marco Bianchi')).toBe('Termination scheduled');
      expect(statusCellText(host, 'Elena Rossi')).toBe('Terminated');
      expect(statusCellText(host, 'Alice Verdi')).toBe('Active');

      // ...and the scheduled row must NOT be the one the chip is derived from
      // by accident: exactly one row carries the new chip.
      expect(host.querySelectorAll('[data-test="resource-status-scheduled"]').length).toBe(1);
    });
  });
});
