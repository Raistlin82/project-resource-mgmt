import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ResourcesComponent } from './resources.component';
import { ApiService, Resource, ResourceOrganization, RateCard, Vendor } from '../services/api.service';
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

function setup(resources: Resource[] = RESOURCES, orgNodes: ResourceOrganization[] = [], rateCards: RateCard[] = []) {
  const getResources = vi.fn(() => of(resources));
  const getProjectRoles = vi.fn(() => of([]));
  const getResourceOrganizations = vi.fn(() => of(orgNodes));
  const getCountries = vi.fn(() => of([]));
  const getCities = vi.fn(() => of([]));
  const getRateCards = vi.fn(() => of(rateCards));
  const getVendors = vi.fn(() => of(VENDORS));
  const createResource = vi.fn(() => of({} as Resource));
  const updateResource = vi.fn(() => of({} as Resource));
  const apiStub = {
    getResources, getProjectRoles, getResourceOrganizations, getCountries, getCities,
    getRateCards, getVendors, createResource, updateResource,
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
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
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
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="manager-filter"] option')]
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
  });
});
