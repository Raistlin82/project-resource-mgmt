import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError, type Observable } from 'rxjs';
import { ResourcesComponent } from './resources.component';
import { ApiService, Resource, ResourceOrganization, RateCard, Assignment, Vendor } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

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
  resources: Resource[] = RESOURCES,
  orgNodes: ResourceOrganization[] | Observable<ResourceOrganization[]> = [],
  rateCards: RateCard[] | Observable<RateCard[]> = [],
  assignments$: Observable<Assignment[]> = of([]),
) {
  const getResources = vi.fn(() => of(resources));
  const getProjectRoles = vi.fn(() => of([]));
  const getResourceOrganizations = vi.fn(() => (Array.isArray(orgNodes) ? of(orgNodes) : orgNodes));
  const getCountries = vi.fn(() => of([]));
  const getCities = vi.fn(() => of([]));
  const getRateCards = vi.fn(() => (Array.isArray(rateCards) ? of(rateCards) : rateCards));
  const getVendors = vi.fn(() => of(VENDORS));
  const getAssignments = vi.fn(() => assignments$);
  const createResource = vi.fn(() => of({} as Resource));
  const updateResource = vi.fn(() => of({} as Resource));
  const apiStub = {
    getResources, getProjectRoles, getResourceOrganizations, getCountries, getCities,
    getRateCards, getVendors, getAssignments, createResource, updateResource,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ResourcesComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ResourcesComponent);
  return { fixture, getResources, getVendors, createResource, updateResource, notifyStub };
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

      expect(fixture.componentInstance.billability()).toEqual({ hours: 100, cost: 7500, billable: 14000 });
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
});
