import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError, type Observable } from 'rxjs';
import { StaffingComponent } from './staffing.component';
import {
  ApiService, Assignment, Resource, ResourceOrganization, ResourceRequest,
  type BenchRollup, type ProficiencySet, type ProjectRole, type Skill, type SkillCatalog, type Vendor,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { localIsoDate } from '../services/local-date.util';

/** Two plain internal resources — enough to exercise the "no request selected" list mode. */
const RESOURCES: Resource[] = [
  { id: '1', name: 'Alice', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '2', name: 'Bob', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];

// --- Facet reference data (RPT §3.2.1-§3.2.5) --------------------------------
const VENDORS: Vendor[] = [
  { id: 'V4', name: 'Mediolanum Consulting S.r.l.' },
  { id: 'V1', name: 'Albion Cloud Services Ltd' },
];
const PROJECT_ROLES: ProjectRole[] = [
  { id: 'pr1', code: 'SR_DEV', name: 'Senior Developer', description: '', restricted: false },
  { id: 'pr2', code: 'CONS', name: 'Consultant', description: '', restricted: false },
  { id: 'pr3', code: 'UX', name: 'UX Designer', description: '', restricted: false },
];
const PROFICIENCY_SETS: ProficiencySet[] = [
  { id: 'p1', name: 'Standard IT Proficiency', description: '', levels: [
    { id: 'l3', level: 3, name: 'Advanced', description: '' },
    { id: 'l1', level: 1, name: 'Beginner', description: '' },
  ] },
];
const SKILLS: Skill[] = [
  { id: 's1', conceptUri: 'u/1', name: 'Java', description: '', catalogs: ['c1'], proficiencySetId: 'p1', restricted: false },
  { id: 's2', conceptUri: 'u/2', name: 'Figma', description: '', catalogs: ['c2'], proficiencySetId: undefined, restricted: false },
];
const SKILL_CATALOGS: SkillCatalog[] = [
  { id: 'c1', name: 'Development Skills', description: '', skills: ['s1'] },
  { id: 'c2', name: 'Design Skills', description: '', skills: ['s2'] },
];

/** Array or Observable, so the read-failure specs below can hand in a
 *  throwError(...) — with array-only parameters they are unwritable. */
function stream<T>(value: T[] | Observable<T[]> | undefined, fallback: T[]): Observable<T[]> {
  if (value === undefined) return of(fallback);
  return Array.isArray(value) ? of(value) : value;
}

/** 'YYYY-MM' `delta` months from `month`, normalising the year. */
function shiftMonth(month: string, delta: number): string {
  const [year, oneBasedMonth] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, oneBasedMonth - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const CURRENT_MONTH = localIsoDate(new Date()).slice(0, 7);
/** The current-forward 6-month window Staffing explicitly requests. */
const BENCH_MONTHS = Array.from({ length: 6 }, (_, index) => shiftMonth(CURRENT_MONTH, index));

function monthLabel(month: string, length: 'short' | 'long'): string {
  return new Intl.DateTimeFormat('en-US', {
    month: length, year: length === 'short' ? '2-digit' : 'numeric', timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));
}

/** Every month of the window in one state — enough to tell three cards apart. */
function benchRow(
  resourceId: string,
  resourceName: string,
  state: 'BENCH' | 'PARTIAL' | 'ALLOCATED',
  kind: 'internal' | 'subco' = 'internal',
  months: readonly string[] = BENCH_MONTHS,
) {
  return {
    resourceId, resourceName, kind,
    availabilityDate: { kind: 'date' as const, date: `${months[0]}-01` },
    monthly: Object.fromEntries(months.map(m => [m, { state, upcomingUnallocated: false }])),
  };
}

const EMPTY_ROLLUP: BenchRollup = { months: [], internalRows: [], subcoRows: [], hiringDemand: [] };

function setup(overrides: {
  resources?: Resource[] | Observable<Resource[]>;
  requests?: ResourceRequest[] | Observable<ResourceRequest[]>;
  orgNodes?: ResourceOrganization[] | Observable<ResourceOrganization[]>;
  vendors?: Vendor[] | Observable<Vendor[]>;
  projectRoles?: ProjectRole[] | Observable<ProjectRole[]>;
  skills?: Skill[] | Observable<Skill[]>;
  skillCatalogs?: SkillCatalog[] | Observable<SkillCatalog[]>;
  proficiencySets?: ProficiencySet[] | Observable<ProficiencySet[]>;
  bench$?: Observable<BenchRollup>;
  /** The pre-authReady window (SSR + the whole OIDC bootstrap) is a real state
   *  of this screen, so it has to be settable here. */
  authReady?: boolean;
  createAssignment$?: Observable<Assignment>;
} = {}) {
  const getRequests = vi.fn(() => stream(overrides.requests, []));
  const getResources = vi.fn(() => stream(overrides.resources, RESOURCES));
  // D (Task 8): the org tree the capability/practice/competence filters derive from.
  const getResourceOrganizations = vi.fn(() => stream(overrides.orgNodes, []));
  // RPT facets: the catalogs the option lists are drawn from.
  const getVendors = vi.fn(() => stream(overrides.vendors, VENDORS));
  const getProjectRoles = vi.fn(() => stream(overrides.projectRoles, PROJECT_ROLES));
  const getSkills = vi.fn(() => stream(overrides.skills, SKILLS));
  const getSkillCatalogs = vi.fn(() => stream(overrides.skillCatalogs, SKILL_CATALOGS));
  const getProficiencySets = vi.fn(() => stream(overrides.proficiencySets, PROFICIENCY_SETS));
  // RPT "Disponibilità futura": the existing 6-month bench rollup.
  const getBenchMonthly = vi.fn((from?: string) => {
    void from;
    return overrides.bench$ ?? of(EMPTY_ROLLUP);
  });
  const createAssignment = vi.fn(() => overrides.createAssignment$ ?? of({} as Assignment));
  const apiStub = {
    getRequests, getResources, getResourceOrganizations, createAssignment,
    getVendors, getProjectRoles, getSkills, getSkillCatalogs, getProficiencySets, getBenchMonthly,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(overrides.authReady ?? true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [StaffingComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(StaffingComponent);
  return {
    fixture, getRequests, getResources, getResourceOrganizations, createAssignment, notifyStub,
    getVendors, getProjectRoles, getSkills, getSkillCatalogs, getProficiencySets, getBenchMonthly,
  };
}

/**
 * `res`/`orgsRes` are the component's own (non-public) rxResources. The
 * read-failure specs need their status as a POSITIVE CONTROL — without it a test
 * can pass because the read it meant to break quietly succeeded — so read it
 * through one narrow, named accessor rather than widening the component surface.
 */
function statusOf(component: StaffingComponent, key: 'res' | 'orgsRes'): string {
  return (component as unknown as Record<string, { status: () => string }>)[key].status();
}

/** Retry controls inside any app-list-state error panel, in DOM order. */
function retryButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')]
    .filter(b => b.textContent?.includes('Retry'));
}

/**
 * A specific app-list-state's loading region, identified by the sr-only label it
 * renders from its `label` input. Scoped deliberately: this screen mounts TWO
 * list-states, so a bare `[role="status"]` query cannot say which one is busy.
 */
function loadingRegion(host: HTMLElement, label: string): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(el => el.textContent?.includes(`Loading ${label}`)) ?? null;
}

/** N days from today in LOCAL calendar terms — the same clock the component's
 *  employment filter reads (todayLocalIso), so nothing below can flip with the
 *  runner's timezone or go stale as the calendar moves. */
function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('StaffingComponent', () => {
  it('renders the plain resource list when no request is selected', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  it('lists only Open or Published requests with confirmed effort still to staff', async () => {
    const requests: ResourceRequest[] = [
      { id: 'published-gap', name: 'Published design gap', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 8, status: 'Published', skills: [] },
      { id: 'open-gap', name: 'Open engineering gap', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 5, status: 'Open', skills: [] },
      { id: 'published-full', name: 'Published but full', requiredRole: 'PM', requiredEffort: 10, staffedEffort: 10, status: 'Published', skills: [] },
      { id: 'withdrawn-gap', name: 'Withdrawn gap', requiredRole: 'PM', requiredEffort: 30, staffedEffort: 0, status: 'Withdrawn', skills: [] },
    ];
    const { fixture } = setup({ requests });
    await flush(fixture);

    expect(fixture.componentInstance.openRequests().map(request => request.id))
      .toStrictEqual(['published-gap', 'open-gap']);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Published design gap');
    expect(host.textContent).toContain('Open engineering gap');
    expect(host.textContent).not.toContain('Published but full');
    expect(host.textContent).not.toContain('Withdrawn gap');
  });

  it('creates an empty assignment shell without sending derived assignedHours', async () => {
    const request: ResourceRequest = {
      id: 'REQ1', name: 'Apollo', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2099-09-01', endDate: '2099-09-30',
    };
    const { fixture, createAssignment } = setup({ requests: [request] });
    await flush(fixture);

    fixture.componentInstance.selectRequest(request);
    fixture.componentInstance.startAssign('1');
    fixture.detectChanges();
    fixture.componentInstance.confirmAssign('1');

    expect(createAssignment).toHaveBeenCalledWith({
      requestId: 'REQ1',
      resourceId: '1',
      startDate: '2099-09-01',
      endDate: '2099-09-30',
      allocationPct: 100,
    });
    expect(createAssignment).toHaveBeenCalledWith(expect.not.objectContaining({ assignedHours: expect.anything() }));
  });

  it('blocks incoherent proposal percentages and date ranges with inline errors', async () => {
    const request: ResourceRequest = {
      id: 'REQ1', name: 'Apollo', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2099-09-01', endDate: '2099-09-30',
    };
    const { fixture, createAssignment } = setup({ requests: [request] });
    await flush(fixture);

    fixture.componentInstance.selectRequest(request);
    fixture.componentInstance.startAssign('1');
    fixture.componentInstance.assignAllocationPct.set(150);
    fixture.componentInstance.assignStartDate.set('2099-09-20');
    fixture.componentInstance.assignEndDate.set('2099-09-10');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Enter an allocation greater than 0% and no more than 100%.');
    expect(host.textContent).toContain('End date must be on or after the start date.');
    expect(host.querySelector<HTMLInputElement>('#assignAllocationPct')?.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('[data-test="assign-panel"] .command-button')?.disabled).toBe(true);

    fixture.componentInstance.confirmAssign('1');
    expect(createAssignment).not.toHaveBeenCalled();
  });

  it('blocks a proposal whose entire booking window is already past', async () => {
    const request: ResourceRequest = {
      id: 'REQ-old', name: 'Historical work', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2000-01-01', endDate: '2000-01-31',
    };
    const { fixture, createAssignment } = setup({ requests: [request] });
    await flush(fixture);

    fixture.componentInstance.selectRequest(request);
    fixture.componentInstance.startAssign('1');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Start date cannot be after the request ends');
    expect(host.textContent).toContain('End date cannot be in the past');
    fixture.componentInstance.confirmAssign('1');
    expect(createAssignment).not.toHaveBeenCalled();
  });

  it('uses the page scroll owner instead of nested fixed-height list scrollers', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelectorAll('.overflow-y-auto')).toHaveLength(0);
    for (const card of host.querySelectorAll<HTMLElement>('.command-card')) {
      expect(card.className).not.toContain('h-[min(800px,80vh)]');
    }
  });

  it('requires an explicit review before assigning a fully utilized candidate', async () => {
    const request: ResourceRequest = {
      id: 'REQ-risk', name: 'Risk review', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2099-09-01', endDate: '2099-09-30',
    };
    const full: Resource = {
      ...RESOURCES[0], id: 'full', name: 'Fully Booked', utilization: 100,
    };
    const { fixture, createAssignment } = setup({ requests: [request], resources: [full] });
    await flush(fixture);

    fixture.componentInstance.selectRequest(request);
    fixture.componentInstance.startAssign(full.id);
    fixture.detectChanges();
    const warning = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLElement>('[data-test="assignment-risk-warning"]');
    expect(warning?.textContent).toContain('no uncommitted capacity is visible');

    fixture.componentInstance.confirmAssign(full.id);
    expect(createAssignment).not.toHaveBeenCalled();

    fixture.componentInstance.assignmentRiskAcknowledged.set(true);
    fixture.componentInstance.confirmAssign(full.id);
    expect(createAssignment).toHaveBeenCalledOnce();
  });

  describe('org-dimension and people-manager filters (D, Task 8)', () => {
    /**
     * D (Task 8): Engineering (capability) > Platform (practice) > Backend
     * (competence), plus Consulting, a capability with no children of its own —
     * same ids the real seed uses ('2'/'5'/'6').
     */
    const ORG_NODES: ResourceOrganization[] = [
      { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
      { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
      { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
      { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
    ];

    /** Jane Doe sits on Backend (competence, two levels under Engineering);
     *  John Miller sits directly on Consulting (a capability with no children).
     *  Each has a distinct People Manager. */
    const ORG_RESOURCES: Resource[] = [
      { id: '10', name: 'Jane Doe', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Backend', managerId: 'm1' },
      { id: '11', name: 'John Miller', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Consulting', managerId: 'm2' },
      { id: 'm1', name: 'Mona Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
      { id: 'm2', name: 'Nora Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
    ];

    it('filters the list by capability', async () => {
      // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
      // one on 'Consulting' (a capability of its own).
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');        // on Backend, under Engineering
      expect(names).not.toContain('John Miller'); // on Consulting
    });

    it('offers only the dimensions that exist in the tree', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
        .map(o => o.value);
      expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
    });

    it('filters the list by practice and by competence', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.practiceFilter.set('Platform');
      fixture.detectChanges();
      let names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);

      fixture.componentInstance.practiceFilter.set('');
      fixture.componentInstance.competenceFilter.set('Backend');
      fixture.detectChanges();
      names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);
    });

    it('filters the list by People Manager and offers only the managers present', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="manager-filter"] option')]
        .map(o => o.textContent?.trim());
      expect(opts).toEqual(['All people managers', 'Mona Manager', 'Nora Manager']);

      fixture.componentInstance.managerFilter.set('m1');
      fixture.detectChanges();
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);
    });

    it('composes two dimension filters (capability AND manager) — the intersection, not the union', async () => {
      // Jane Doe (Backend/Engineering, manager m1) and John Miller
      // (Consulting, manager m2) sit on DISJOINT capability/manager pairs. An
      // OR-composition bug would keep BOTH once a second filter is added
      // (either one matches); the correct AND keeps NEITHER.
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const names = () => [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      expect(names()).toEqual(['Jane Doe']);

      fixture.componentInstance.managerFilter.set('m2');
      fixture.detectChanges();
      // AND, not OR: a future edit that silently OR'd the two predicates
      // would show both (Jane via capability, John via manager) instead of
      // the correct empty intersection.
      expect(names()).toEqual([]);

      fixture.componentInstance.capabilityFilter.set('');
      fixture.detectChanges();
      expect(names()).toEqual(['John Miller']); // manager=m2 alone is John
    });

    it('composes a dimension filter with the pre-existing search filter — the intersection, not either alone', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const names = () => [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());

      fixture.componentInstance.searchQuery.set('Doe');
      fixture.detectChanges();
      expect(names()).toEqual(['Jane Doe']); // search alone

      fixture.componentInstance.capabilityFilter.set('Consulting');
      fixture.detectChanges();
      // AND, not OR: search='Doe' matches only Jane (organization Backend),
      // and capability='Consulting' matches only John — their intersection
      // is empty, not the 2-resource union an OR-composition bug would produce.
      expect(names()).toEqual([]);

      fixture.componentInstance.searchQuery.set('');
      fixture.detectChanges();
      expect(names()).toEqual(['John Miller']); // capability alone
    });
  });

  // The right-hand candidate panel reads the same two rxResources its header
  // does and had NO list-state of its own. An rxResource `.value()` THROWS while
  // its status is 'error', and a throw during change detection aborts that pass
  // and every later one, so the panel froze with no message and no Retry.
  //
  // Every OTHER spec in this file stubs both reads with a synchronous of(...) —
  // which is exactly how this stayed green — so each case below carries a
  // positive control asserting the read it meant to break really did fail.
  describe('a failed read reaches an error panel and its Retry', () => {
    it('renders the candidate panel error and Retry without throwing when the org tree fails and the pool succeeds', async () => {
      const { fixture } = setup({ orgNodes: throwError(() => new Error('500 Internal Server Error')) });
      // The pre-fix throw happens INSIDE the render, so it surfaces here as a
      // rejected promise rather than as a failed expectation further down.
      await expect(flush(fixture)).resolves.toBeUndefined();

      expect(statusOf(fixture.componentInstance, 'orgsRes')).toBe('error');
      expect(statusOf(fixture.componentInstance, 'res')).toBe('resolved');
      // ...and every SUBSEQUENT pass must stay clean, not just the first.
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain("Couldn't load candidate resources");
      expect(retryButtons(host)).toHaveLength(1);
      // Scoped to the failing region: the requests panel reads neither the org
      // tree nor anything derived from it, so it must NOT be showing an error.
      expect(host.textContent).not.toContain("Couldn't load requests");
    });

    it('renders BOTH panels\' errors without throwing when the requests/resources pool fails', async () => {
      const { fixture } = setup({ resources: throwError(() => new Error('401 Unauthorized')) });
      await expect(flush(fixture)).resolves.toBeUndefined();

      expect(statusOf(fixture.componentInstance, 'res')).toBe('error');
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain("Couldn't load requests");
      expect(host.textContent).toContain("Couldn't load candidate resources");
      // The header's own filters are the throwing bindings; they must keep
      // rendering (the query and the selections are the USER's state, not the
      // read's), which is why the fix is a defensive accessor, not a move.
      expect(host.querySelector('[data-test="capability-filter"]')).not.toBeNull();
      fixture.componentInstance.searchQuery.set('Alice');
      expect(() => fixture.detectChanges()).not.toThrow();
    });

    it('never claims a skill gap while the pool is unavailable', async () => {
      // An empty pool covers nothing, so an unguarded requestSkillGap reports
      // EVERY required skill as missing — a confident "nobody can cover these
      // skills" hiring signal derived from a failed read.
      const request: ResourceRequest = {
        id: 'REQ1', name: 'Apollo', requiredRole: 'Developer', requiredEffort: 80,
        staffedEffort: 0, skills: ['Java'], status: 'Open',
      };
      const { fixture } = setup({ requests: [request], resources: throwError(() => new Error('500')) });
      await expect(flush(fixture)).resolves.toBeUndefined();

      fixture.componentInstance.selectedRequest.set(request);
      expect(() => fixture.detectChanges()).not.toThrow();

      expect(statusOf(fixture.componentInstance, 'res')).toBe('error');
      expect(fixture.componentInstance.missingSkillGap()).toEqual([]);
      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).not.toContain('Skill gap: no available resource covers these skills');
    });

    it('shows NO error panel and the real rows/facets when both reads succeed', async () => {
      // The must-still-be-ALLOWED case. Without it, a guard that reported
      // failure unconditionally — or a template that always rendered the panel —
      // would satisfy every case above.
      const ORG_NODES: ResourceOrganization[] = [
        { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
      ];
      const { fixture } = setup({ orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(statusOf(fixture.componentInstance, 'res')).toBe('resolved');
      expect(statusOf(fixture.componentInstance, 'orgsRes')).toBe('resolved');
      expect(host.textContent).not.toContain("Couldn't load");
      expect(retryButtons(host)).toHaveLength(0);

      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Alice', 'Bob']);
      // The facet options are the very bindings the guard short-circuits, so
      // assert they are genuinely populated here — an accessor stuck at []
      // would pass the failure cases above and fail this one.
      const capabilities = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
        .map(o => o.value);
      expect(capabilities).toEqual(['', 'Engineering']);
    });

    it("Retry on the candidate panel reloads BOTH legs, not only the one that broke", async () => {
      const { fixture, getRequests, getResources, getResourceOrganizations } =
        setup({ orgNodes: throwError(() => new Error('500 Internal Server Error')) });
      await expect(flush(fixture)).resolves.toBeUndefined();
      expect(getResourceOrganizations).toHaveBeenCalledTimes(1);
      expect(getResources).toHaveBeenCalledTimes(1);

      const host = fixture.nativeElement as HTMLElement;
      retryButtons(host)[0].click();
      await flush(fixture);

      expect(getResourceOrganizations).toHaveBeenCalledTimes(2);
      expect(getRequests).toHaveBeenCalledTimes(2);
      expect(getResources).toHaveBeenCalledTimes(2);
    });
  });

  // Both rxResources resolve their pre-auth defaults SYNCHRONOUSLY while
  // authReady() is false, so isLoading() is false for the whole OIDC bootstrap
  // window and for the SSR HTML. Both panels therefore stated, as settled fact,
  // that there was nothing to staff and nobody to staff it with.
  describe('the pre-authReady window renders as loading, not as "nothing here"', () => {
    const NO_REQUESTS = 'No open requests available for staffing.';
    const NO_CANDIDATES = 'No resources found matching your criteria.';

    it('shows both skeletons and NEITHER empty-state sentence while authReady() is false and the API has data', async () => {
      const request: ResourceRequest = {
        id: 'REQ1', name: 'Apollo', requiredRole: 'Consultant', requiredEffort: 80,
        staffedEffort: 0, skills: [], status: 'Open',
      };
      // Non-empty API data is the point: both sentences would be lies about data
      // that exists and is about to arrive.
      const { fixture, getRequests, getResources } = setup({ requests: [request], authReady: false });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      // Positive control: the reads genuinely have not been made yet, so this is
      // the pre-auth window and not a resolved-empty collection.
      expect(getRequests).not.toHaveBeenCalled();
      expect(getResources).not.toHaveBeenCalled();
      expect(statusOf(fixture.componentInstance, 'res')).toBe('resolved');

      // The ABSENCE halves first — they are what the user was misled by; the
      // skeletons are merely what replaces them.
      expect(host.textContent).not.toContain(NO_REQUESTS);
      expect(host.textContent).not.toContain(NO_CANDIDATES);
      expect(loadingRegion(host, 'requests')).not.toBeNull();
      expect(loadingRegion(host, 'candidate resources')).not.toBeNull();
    });

    it('shows both empty-state sentences and NO skeleton once authReady() is true and both reads really are empty', async () => {
      // The mirror, and the load-bearing half: a fix that pinned the skeletons
      // on forever — or deleted the empty states — passes the case above and
      // fails this one.
      const { fixture, getResources } = setup({ requests: [], resources: [], authReady: true });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(getResources).toHaveBeenCalledTimes(1);
      expect(loadingRegion(host, 'requests')).toBeNull();
      expect(loadingRegion(host, 'candidate resources')).toBeNull();
      expect(host.textContent).toContain(NO_REQUESTS);
      expect(host.textContent).toContain(NO_CANDIDATES);
    });
  });

  // A stored terminationDate is never revisited (there is no DELETE /resources),
  // so a departed employee stayed in the staffing pool: ranked, captioned
  // "100% Utilized" (which reads "busy", never "left"), offered an Assign button
  // that either 400s with no reason or silently books them — and their skills
  // were counted as capability coverage, suppressing the hire/subcontract signal.
  describe('terminated resources are neither staffable candidates nor capability coverage', () => {
    /** Mirrors seeded resource '9' Elena Rossi (terminated, Java 2, Developer),
     *  but with the date derived from today so the fixture cannot go stale. */
    const LEAVER: Resource = {
      id: '9', name: 'Elena Rossi', role: 'Developer',
      skills: [{ name: 'Java', level: 2 }], projectRoles: ['Developer'], externalExperience: [],
      utilization: 100, capacity: 40, kind: 'internal', terminationDate: isoDaysFromToday(-30),
    };
    /** Active, but covers none of the required skills. */
    const ACTIVE_DESIGNER: Resource = {
      id: '7', name: 'Dana Designer', role: 'Designer',
      skills: [{ name: 'Figma', level: 4 }], projectRoles: ['Designer'], externalExperience: [],
      utilization: 20, capacity: 40, kind: 'internal',
    };
    /** Active AND covers Java — the must-still-be-allowed control. */
    const ACTIVE_DEV: Resource = {
      id: '8', name: 'Dario Dev', role: 'Developer',
      skills: [{ name: 'Java', level: 4 }], projectRoles: ['Developer'], externalExperience: [],
      utilization: 20, capacity: 40, kind: 'internal',
    };
    const JAVA_REQUEST: ResourceRequest = {
      id: 'REQ1', name: 'Apollo', requiredRole: 'Developer', requiredEffort: 80,
      staffedEffort: 0, skills: ['Java'], status: 'Open',
      // A start date inside the leaver's post-termination window — the booking
      // the server would refuse, and the reason this control must not be offered.
      startDate: isoDaysFromToday(30), endDate: isoDaysFromToday(60),
    };

    it('drops the leaver from the ranking AND reports the skill only he covered as a gap', async () => {
      const { fixture } = setup({ requests: [JAVA_REQUEST], resources: [ACTIVE_DESIGNER, LEAVER] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(JAVA_REQUEST);
      fixture.detectChanges();

      const ranked = fixture.componentInstance.rankedCandidates()!.map(c => c.resourceId);
      expect(ranked).not.toContain('9');          // ABSENCE: he cannot be staffed
      expect(ranked).toEqual(['7']);              // the active designer still ranks
      // PRESENCE: the skill only the leaver held is a gap, not coverage — this
      // half fails today for the opposite reason to the half above.
      expect(fixture.componentInstance.missingSkillGap()).toContain('Java');

      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).not.toContain('Elena Rossi');
      expect(host.textContent).toContain('Skill gap: no available resource covers these skills');
      // No Assign control can exist for a candidate who is not listed.
      expect(host.querySelector('[data-assign-for="9"]')).toBeNull();
    });

    it('still ranks an ACTIVE holder of the same skill and reports NO gap — the filter refuses leavers, not everybody', async () => {
      // A guard that always refused would pass the case above; this is the case
      // that must still be allowed.
      const { fixture } = setup({ requests: [JAVA_REQUEST], resources: [ACTIVE_DEV, LEAVER] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(JAVA_REQUEST);
      fixture.detectChanges();

      const ranked = fixture.componentInstance.rankedCandidates()!.map(c => c.resourceId);
      expect(ranked).toEqual(['8']);
      expect(fixture.componentInstance.missingSkillGap()).toEqual([]);
      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).not.toContain('Skill gap: no available resource covers these skills');
      expect(host.querySelector('[data-assign-for="8"]')).not.toBeNull();
    });

    it('hides the leaver from the plain (no request selected) list too', async () => {
      const { fixture } = setup({ resources: [ACTIVE_DEV, LEAVER] });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Dario Dev']);
    });

    it('keeps a resource whose termination is still in the FUTURE — a notice period is not a departure', async () => {
      // The boundary the fix must not overshoot: isTerminatedAsOf is date-based,
      // so a scheduled leaver is still staffable today.
      const noticePeriod: Resource = { ...LEAVER, id: '12', name: 'Nadia Notice', terminationDate: isoDaysFromToday(30) };
      const { fixture } = setup({ resources: [noticePeriod] });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Nadia Notice']);
    });
  });

  // The reveal replaced the button that triggered it, so document.activeElement
  // became <body>: the next Tab restarted at the skip link, and a screen-reader
  // user got no signal that a form had appeared.
  describe('revealing the proposal form moves focus into it', () => {
    const REQUEST: ResourceRequest = {
      id: 'REQ1', name: 'Apollo', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2026-09-01', endDate: '2026-09-30',
    };

    it('focus lands on the Allocation % input, not on <body>', async () => {
      const { fixture } = setup({ requests: [REQUEST] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(REQUEST);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      const assign = host.querySelector<HTMLButtonElement>('[data-assign-for="1"]')!;
      assign.focus();
      // The pre-click guard: without it this test passes in any environment
      // where the button was never focused in the first place.
      expect(document.activeElement).toBe(assign);

      assign.click();
      await flush(fixture);

      const alloc = host.querySelector<HTMLInputElement>('[data-test="assign-allocation"]');
      expect(alloc).not.toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(alloc);
    });

    it('the revealed panel carries an accessible name, so the reveal is announced and not merely focused', async () => {
      const { fixture } = setup({ requests: [REQUEST] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(REQUEST);
      fixture.componentInstance.startAssign('1');
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      const panel = host.querySelector('[data-test="assign-panel"]')!;
      expect(panel.getAttribute('role')).toBe('group');
      // Named after the candidate: "a form appeared" is not enough to know WHOSE.
      expect(panel.getAttribute('aria-label')).toBe('Assignment proposal for Alice');
    });

    it('Cancel returns focus to the Assign button it came from', async () => {
      const { fixture } = setup({ requests: [REQUEST] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(REQUEST);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      host.querySelector<HTMLButtonElement>('[data-assign-for="1"]')!.click();
      await flush(fixture);
      expect(document.activeElement).toBe(host.querySelector('[data-test="assign-allocation"]'));

      const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find(b => b.getAttribute('aria-label') === 'Cancel assignment')!;
      cancel.click();
      await flush(fixture);

      const reAssign = host.querySelector<HTMLButtonElement>('[data-assign-for="1"]');
      expect(reAssign).not.toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(reAssign);
    });

    it('selecting another request does NOT pull focus, since its candidate list is rebuilt', async () => {
      // The must-NOT-happen twin of the case above: cancelAssign() is also called
      // by selectRequest/clearSelection, where the button focus would return to
      // may no longer exist.
      const other: ResourceRequest = { ...REQUEST, id: 'REQ2', name: 'Zeus' };
      const { fixture } = setup({ requests: [REQUEST, other] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(REQUEST);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      host.querySelector<HTMLButtonElement>('[data-assign-for="1"]')!.click();
      await flush(fixture);

      // Move focus somewhere neutral, then switch requests.
      const search = host.querySelector<HTMLInputElement>('input[aria-label="Search candidate resources"]')!;
      search.focus();
      fixture.componentInstance.selectRequest(other);
      await flush(fixture);

      expect(fixture.componentInstance.assigningResourceId()).toBeNull();
      expect(document.activeElement).toBe(search);
    });
  });

  // A refused allocation used to be a dead end: the server explains WHY (an
  // employment window, an overlapping booking, a closed month) and the fixed
  // string threw all of it away.
  describe('a refused allocation reports the reason it was refused', () => {
    const REQUEST: ResourceRequest = {
      id: 'REQ1', name: 'Apollo', requiredRole: 'Consultant', requiredEffort: 80,
      staffedEffort: 0, skills: [], status: 'Open', startDate: '2026-09-01', endDate: '2026-09-30',
    };

    /** Drive a create through to its error handler and return the toasts raised. */
    async function attemptWith(error: unknown): Promise<string[]> {
      const { fixture, notifyStub } = setup({ requests: [REQUEST], createAssignment$: throwError(() => error) });
      await flush(fixture);
      fixture.componentInstance.selectRequest(REQUEST);
      fixture.componentInstance.startAssign('1');
      fixture.detectChanges();
      fixture.componentInstance.confirmAssign('1');
      return (notifyStub.show as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    }

    it("shows the server's message verbatim, not the generic string", async () => {
      const refusal = 'booking date 2026-09-01 is after terminationDate 2026-03-15';
      const messages = await attemptWith({ error: { error: refusal } });
      expect(messages).toEqual([refusal]);
      // The absence half: the generic copy must not be what the user is left with
      // when the server said something specific.
      expect(messages[0]).not.toContain('Unable to create the allocation');
    });

    it('still says something when the failure carries no server message — the fallback cannot be dropped', async () => {
      const messages = await attemptWith(new Error('network down'));
      expect(messages).toEqual(['Unable to create the allocation']);
    });
  });

  // RPT filters candidates on 13 facets (manual §3.2.1-§3.2.5); this screen had
  // free text plus four. Each case below carries BOTH halves — the matching
  // candidate present AND the non-matching one absent — because a facet that
  // does not filter at all satisfies the presence half on its own.
  describe('RPT advanced facets', () => {
    const ORG_NODES: ResourceOrganization[] = [
      { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
      { id: 'o2', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
    ];

    /** One row per registry type, per rate band and per skill level, so every
     *  facet below has something to keep AND something to drop. */
    const FACET_RESOURCES: Resource[] = [
      { id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal', organization: 'Engineering',
        skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'], externalExperience: [],
        utilization: 0, capacity: 40, costRateDay: 600 },
      { id: '2', name: 'John Miller', role: 'Consultant', kind: 'internal', organization: 'Consulting',
        skills: [{ name: 'Project Management', level: 2 }], projectRoles: ['Business Consultant'],
        externalExperience: [], utilization: 0, capacity: 40 },
      { id: '4', name: 'Dummy UX', role: 'Designer', kind: 'dummy', organization: 'Consulting',
        skills: [{ name: 'Figma', level: 1 }], projectRoles: ['UX Designer'], externalExperience: [],
        utilization: 0, capacity: 40, costRateDay: 300 },
      { id: '6', name: 'Subco Dev', role: 'Developer', kind: 'subco', vendorId: 'V4', organization: 'Engineering',
        skills: [{ name: 'Java', level: 1 }], projectRoles: ['Senior Developer'], externalExperience: [],
        utilization: 0, capacity: 40, costRateDay: 1200 },
    ];

    async function facetFixture() {
      const harness = setup({ resources: FACET_RESOURCES, orgNodes: ORG_NODES });
      await flush(harness.fixture);
      return harness;
    }

    function names(host: HTMLElement): (string | undefined)[] {
      return [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
    }

    it('anagrafica: each registry type keeps its own rows and EXCLUDES the others', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.kindFilter.set('internal');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Julie Armstrong', 'John Miller']);
      expect(names(host)).not.toContain('Dummy UX');
      expect(names(host)).not.toContain('Subco Dev');

      fixture.componentInstance.kindFilter.set('dummy');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Dummy UX']);

      fixture.componentInstance.kindFilter.set('subco');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Subco Dev']);
    });

    it('società: a vendor keeps its subcontractor and drops everyone with no vendor', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.vendorFilter.set('V4');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Subco Dev']);
      expect(names(host)).not.toContain('Julie Armstrong');

      // A vendor nobody belongs to keeps nobody — not "everybody", which is what
      // an unapplied predicate would do.
      fixture.componentInstance.vendorFilter.set('V1');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual([]);
    });

    it('job role: matches the job-role list AND the primary role', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.jobRoleFilter.set('Senior Developer');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Julie Armstrong', 'Subco Dev']);
      expect(names(host)).not.toContain('John Miller');

      // John's projectRoles say 'Business Consultant'; his PRIMARY role is
      // 'Consultant', which is the catalog row a planner picks.
      fixture.componentInstance.jobRoleFilter.set('Consultant');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['John Miller']);
      expect(names(host)).not.toContain('Julie Armstrong');
    });

    it('skill matrix: the skill narrows, and the minimum proficiency narrows further', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.skillFilter.set('Java');
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Julie Armstrong', 'Subco Dev']);
      expect(names(host)).not.toContain('John Miller');

      fixture.componentInstance.minSkillLevel.set(3);
      fixture.detectChanges();
      // The load-bearing absence: Subco Dev HOLDS Java, at level 1.
      expect(names(host)).toStrictEqual(['Julie Armstrong']);
      expect(names(host)).not.toContain('Subco Dev');
    });

    it('skill capability: a catalog keeps holders of its member skills only', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.skillCatalogFilter.set('c1');   // Development Skills = Java
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Julie Armstrong', 'Subco Dev']);
      expect(names(host)).not.toContain('Dummy UX');

      fixture.componentInstance.skillCatalogFilter.set('c2');   // Design Skills = Figma
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Dummy UX']);
      expect(names(host)).not.toContain('Julie Armstrong');
    });

    it('tariffa: the band keeps rates inside it and excludes an unresolved rate', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.rateMin.set(500);
      fixture.componentInstance.rateMax.set(900);
      fixture.detectChanges();
      expect(names(host)).toStrictEqual(['Julie Armstrong']);
      expect(names(host)).not.toContain('Dummy UX');   // 300, below
      expect(names(host)).not.toContain('Subco Dev');  // 1200, above
      // John has no resolved rate at all: he cannot be shown to satisfy a band.
      expect(names(host)).not.toContain('John Miller');

      // ...and he is back with no band, so that exclusion is the BAND's doing.
      fixture.componentInstance.rateMin.set(null);
      fixture.componentInstance.rateMax.set(null);
      fixture.detectChanges();
      expect(names(host)).toContain('John Miller');
    });

    it('draws every advanced option list from its catalog, name-sorted', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;
      const options = (test: string) =>
        [...host.querySelectorAll<HTMLOptionElement>(`[data-test="${test}"] option`)].map(o => o.textContent?.trim());

      expect(options('kind-filter')).toStrictEqual([
        'All registry types', 'Internal', 'Dummy (placeholder)', 'Subcontractor',
      ]);
      // Seeded out of order on purpose: the screen sorts, the catalog does not.
      expect(options('vendor-filter')).toStrictEqual([
        'All companies', 'Albion Cloud Services Ltd', 'Mediolanum Consulting S.r.l.',
      ]);
      expect(options('job-role-filter')).toStrictEqual([
        'All job roles', 'Consultant', 'Senior Developer', 'UX Designer',
      ]);
      expect(options('skill-filter')).toStrictEqual(['All skills', 'Figma', 'Java']);
      expect(options('skill-catalog-filter')).toStrictEqual([
        'All skill capabilities', 'Design Skills', 'Development Skills',
      ]);
    });

    it('offers proficiency levels only for a skill that HAS a scale, ascending', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;
      const levelSelect = () => host.querySelector<HTMLSelectElement>('[data-test="min-level-filter"]')!;
      const levelOptions = () =>
        [...levelSelect().querySelectorAll('option')].map(o => o.textContent?.trim());

      // No skill selected: nothing to qualify, so the control is disabled.
      expect(levelSelect().disabled).toBe(true);
      expect(levelOptions()).toStrictEqual(['Any proficiency']);

      fixture.componentInstance.skillFilter.set('Java');
      fixture.detectChanges();
      expect(levelSelect().disabled).toBe(false);
      // Seeded 3-then-1; rendered ascending.
      expect(levelOptions()).toStrictEqual(['Any proficiency', '1 — Beginner', '3 — Advanced']);

      // Figma declares no proficiency set: no scale is invented for it.
      fixture.componentInstance.skillFilter.set('Figma');
      fixture.detectChanges();
      expect(levelSelect().disabled).toBe(true);
      expect(levelOptions()).toStrictEqual(['Any proficiency']);
    });

    it('resets a stale minimum level when the skill changes', async () => {
      // A level 3 left over from Java would silently filter Figma, whose scale
      // may not even have a level 3 — the reason this is a linkedSignal.
      const { fixture } = await facetFixture();
      fixture.componentInstance.skillFilter.set('Java');
      fixture.componentInstance.minSkillLevel.set(3);
      fixture.detectChanges();
      expect(fixture.componentInstance.minSkillLevel()).toBe(3);

      fixture.componentInstance.skillFilter.set('Figma');
      fixture.detectChanges();
      expect(fixture.componentInstance.minSkillLevel()).toBeNull();
      const host = fixture.nativeElement as HTMLElement;
      expect(names(host)).toStrictEqual(['Dummy UX']);
    });

    it('facets narrow the RANKING without replacing it', async () => {
      // Constraint: facets filter the SET, match.util still owns the ORDER. A
      // facet implementation that re-sorted (alphabetically, say) would break
      // the descending-score assertion here.
      const request: ResourceRequest = {
        id: 'REQ1', name: 'Apollo', requiredRole: 'Developer', requiredEffort: 80,
        staffedEffort: 0, skills: ['Java'], status: 'Open',
      };
      const { fixture } = setup({ resources: FACET_RESOURCES, orgNodes: ORG_NODES, requests: [request] });
      await flush(fixture);
      fixture.componentInstance.selectRequest(request);
      fixture.detectChanges();

      const all = fixture.componentInstance.rankedCandidates()!;
      expect(all.length).toBe(4);
      const scores = all.map(c => c.score);
      expect([...scores].sort((a, b) => b - a)).toStrictEqual(scores);

      fixture.componentInstance.skillFilter.set('Java');
      fixture.componentInstance.minSkillLevel.set(3);
      fixture.detectChanges();
      const ranked = fixture.componentInstance.rankedCandidates()!;
      expect(ranked.map(c => c.resourceId)).toStrictEqual(['1']);
      expect(names(fixture.nativeElement as HTMLElement)).toStrictEqual(['Julie Armstrong']);
      // The match score is still rendered for the survivor — the ranking UI is
      // not collateral damage of the filtering.
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Match score');
    });

    it('counts the hidden facets and clears every one of them, disclosed or not', async () => {
      const { fixture } = await facetFixture();
      const host = fixture.nativeElement as HTMLElement;
      const badge = () => host.querySelector('[data-test="advanced-filters-count"]')?.textContent?.trim();
      const clear = () => host.querySelector<HTMLButtonElement>('[data-test="clear-filters"]');

      // Nothing active: no badge, no Clear control.
      expect(badge()).toBeUndefined();
      expect(clear()).toBeNull();

      fixture.componentInstance.searchQuery.set('Julie');
      fixture.detectChanges();
      // A VISIBLE filter must not be counted as a hidden one...
      expect(badge()).toBeUndefined();
      // ...but it must still be clearable.
      expect(clear()).not.toBeNull();

      fixture.componentInstance.kindFilter.set('subco');
      fixture.componentInstance.rateMin.set(100);
      fixture.detectChanges();
      expect(badge()).toBe('2 active');
      expect(names(host)).toStrictEqual([]);   // 'Julie' AND subco AND >=100

      clear()!.click();
      fixture.detectChanges();
      expect(fixture.componentInstance.kindFilter()).toBe('');
      expect(fixture.componentInstance.rateMin()).toBeNull();
      expect(fixture.componentInstance.searchQuery()).toBe('');
      expect(badge()).toBeUndefined();
      expect(clear()).toBeNull();
      expect(names(host)).toHaveLength(4);
    });

    it('puts the candidate panel into its error state when the catalog read fails', async () => {
      // The option lists are header bindings that sit outside every error
      // panel, so a failed catalog read used to be able to freeze the panel the
      // same way the org tree could.
      const { fixture } = setup({ skills: throwError(() => new Error('500 Internal Server Error')) });
      await expect(flush(fixture)).resolves.toBeUndefined();
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain("Couldn't load candidate resources");
      expect(retryButtons(host)).toHaveLength(1);
      expect(host.textContent).not.toContain("Couldn't load requests");
    });
  });

  // RPT shows a current-forward future-availability traffic light on every
  // result card (§3.2.2). Staffing explicitly requests the six-month rollup from
  // the user's local month and defensively drops any historic prefix.
  describe('RPT future-availability strip', () => {
    const STRIP_RESOURCES: Resource[] = [
      { id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
      { id: '2', name: 'John Miller', role: 'Consultant', kind: 'internal', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
      { id: '4', name: 'Dummy UX', role: 'Designer', kind: 'dummy', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
      { id: '6', name: 'Subco Dev', role: 'Developer', kind: 'subco', vendorId: 'V4', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
    ];

    /** One resource per state, and one (the dummy) with NO row at all — which is
     *  not a contrived case: placeholders are excluded from the rollup by design. */
    const ROLLUP: BenchRollup = {
      months: BENCH_MONTHS,
      internalRows: [benchRow('1', 'Julie Armstrong', 'BENCH'), benchRow('2', 'John Miller', 'PARTIAL')],
      subcoRows: [benchRow('6', 'Subco Dev', 'ALLOCATED', 'subco')],
      hiringDemand: [],
    };

    /** The strip belonging to ONE candidate, found by its accessible name — a
     *  page-wide dot query could not say whose availability it read. */
    function stripFor(host: HTMLElement, name: string): HTMLElement | null {
      return host.querySelector<HTMLElement>(`[aria-label="Future availability for ${name}"]`);
    }
    function glyphs(host: HTMLElement, name: string): string[] {
      const strip = stripFor(host, name);
      if (!strip) return [];
      return [...strip.querySelectorAll('[data-test="availability-dot"]')].map(d => d.textContent?.trim() ?? '');
    }

    it('requests the six-month rollup from the current local civil month', async () => {
      const { fixture, getBenchMonthly } = setup({ resources: STRIP_RESOURCES, bench$: of(ROLLUP) });
      await flush(fixture);

      expect(getBenchMonthly).toHaveBeenCalledWith(CURRENT_MONTH);
    });

    it('uses the local month at a UTC/local boundary, never the UTC month', () => {
      const previousTz = process.env['TZ'];
      vi.useFakeTimers();
      process.env['TZ'] = 'Pacific/Kiritimati';
      // UTC is still September; locally this is 1 October in UTC+14.
      vi.setSystemTime(new Date('2026-09-30T10:30:00.000Z'));
      try {
        const { fixture, getBenchMonthly } = setup();
        fixture.detectChanges();
        expect(getBenchMonthly).toHaveBeenCalledWith('2026-10');
        fixture.destroy();
      } finally {
        vi.useRealTimers();
        if (previousTz === undefined) delete process.env['TZ'];
        else process.env['TZ'] = previousTz;
      }
    });

    it('gives each candidate card its OWN six months, and the three states differ', async () => {
      const { fixture } = setup({ resources: STRIP_RESOURCES, bench$: of(ROLLUP) });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(glyphs(host, 'Julie Armstrong')).toStrictEqual(['B', 'B', 'B', 'B', 'B', 'B']);
      expect(glyphs(host, 'John Miller')).toStrictEqual(['P', 'P', 'P', 'P', 'P', 'P']);
      expect(glyphs(host, 'Subco Dev')).toStrictEqual(['A', 'A', 'A', 'A', 'A', 'A']);
      // The absence half of the three assertions above: no card shows a state
      // that belongs to another card.
      expect(glyphs(host, 'Julie Armstrong')).not.toContain('A');
      expect(glyphs(host, 'Subco Dev')).not.toContain('B');

      const first = stripFor(host, 'Julie Armstrong')!
        .querySelector('[data-test="availability-dot"]')!;
      expect(first.getAttribute('aria-label')).toBe(`${monthLabel(CURRENT_MONTH, 'long')}: Bench (free)`);
    });

    it('drops historic Open-period months if a stale API response still returns them', async () => {
      const historicMonths = Array.from({ length: 6 }, (_, index) => shiftMonth(CURRENT_MONTH, index - 4));
      const staleRollup: BenchRollup = {
        months: historicMonths,
        internalRows: [benchRow('1', 'Julie Armstrong', 'BENCH', 'internal', historicMonths)],
        subcoRows: [],
        hiringDemand: [],
      };
      const { fixture } = setup({ resources: STRIP_RESOURCES, bench$: of(staleRollup) });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      // Only current and next month survive; the label is derived from that same
      // slice, so it cannot continue claiming the historic six-month window.
      expect(glyphs(host, 'Julie Armstrong')).toStrictEqual(['B', 'B']);
      const first = stripFor(host, 'Julie Armstrong')!.querySelector('[data-test="availability-dot"]')!;
      expect(first.getAttribute('aria-label')).toBe(`${monthLabel(CURRENT_MONTH, 'long')}: Bench (free)`);
      const legend = host.querySelector('[data-test="availability-legend"]')!;
      expect(legend.textContent).toContain(
        `${monthLabel(CURRENT_MONTH, 'short')} – ${monthLabel(shiftMonth(CURRENT_MONTH, 1), 'short')}`,
      );
      expect(legend.textContent).not.toContain(monthLabel(shiftMonth(CURRENT_MONTH, -4), 'short'));
    });

    it('shows a resource the rollup does not cover as NOT TRACKED, never as free', async () => {
      const { fixture } = setup({ resources: STRIP_RESOURCES, bench$: of(ROLLUP) });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(glyphs(host, 'Dummy UX')).toStrictEqual(['–', '–', '–', '–', '–', '–']);
      expect(glyphs(host, 'Dummy UX')).not.toContain('B');
      expect(stripFor(host, 'Dummy UX')!.textContent).toContain('not tracked');
    });

    it('renders the strip in the RANKED mode too, not only in the plain list', async () => {
      const request: ResourceRequest = {
        id: 'REQ1', name: 'Apollo', requiredRole: 'Developer', requiredEffort: 80,
        staffedEffort: 0, skills: [], status: 'Open',
      };
      const { fixture } = setup({ resources: STRIP_RESOURCES, requests: [request], bench$: of(ROLLUP) });
      await flush(fixture);
      fixture.componentInstance.selectRequest(request);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;

      expect(host.textContent).toContain('Match score');   // positive control: ranked mode
      expect(glyphs(host, 'Julie Armstrong')).toStrictEqual(['B', 'B', 'B', 'B', 'B', 'B']);
      expect(glyphs(host, 'Subco Dev')).toStrictEqual(['A', 'A', 'A', 'A', 'A', 'A']);
    });

    it('states the legend once for the exact current-forward window shown', async () => {
      const { fixture } = setup({ resources: STRIP_RESOURCES, bench$: of(ROLLUP) });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const legend = host.querySelector('[data-test="availability-legend"]')!;
      expect(legend.textContent).toContain(
        `${monthLabel(BENCH_MONTHS[0], 'short')} – ${monthLabel(BENCH_MONTHS[5], 'short')}`,
      );
      expect(legend.textContent).toContain('bench');
      expect(legend.textContent).toContain('not tracked');
    });

    it('a FAILED availability read says so per card and leaves the ranking intact', async () => {
      // The confident-zero this guards against: six green dots derived from a
      // read that never returned would read as "everybody is free".
      const { fixture, getBenchMonthly } = setup({
        resources: STRIP_RESOURCES, bench$: throwError(() => new Error('500 Internal Server Error')),
      });
      await expect(flush(fixture)).resolves.toBeUndefined();
      expect(() => fixture.detectChanges()).not.toThrow();
      const host = fixture.nativeElement as HTMLElement;

      // Not one dot anywhere, on any card.
      expect(host.querySelectorAll('[data-test="availability-dot"]')).toHaveLength(0);
      expect(host.querySelectorAll('[data-test="availability-unavailable"]').length).toBe(4);
      expect(host.querySelector('[data-test="availability-legend"]')).toBeNull();
      // The candidate list itself is untouched: /bench is an attribute of a
      // candidate, not the candidate list.
      expect([...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim()))
        .toStrictEqual(['Julie Armstrong', 'John Miller', 'Dummy UX', 'Subco Dev']);
      expect(host.textContent).not.toContain("Couldn't load candidate resources");

      // ...and its own Retry re-reads only what failed.
      expect(getBenchMonthly).toHaveBeenCalledTimes(1);
      host.querySelector<HTMLButtonElement>('[data-test="availability-retry"]')!.click();
      await flush(fixture);
      expect(getBenchMonthly).toHaveBeenCalledTimes(2);
    });

    it('waits for authReady before asking for the rollup, and says loading meanwhile', async () => {
      const { fixture, getBenchMonthly } = setup({
        resources: STRIP_RESOURCES, bench$: of(ROLLUP), authReady: false,
      });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      // Without the authReady gate this read goes out with no bearer, 401s, and
      // the strip latches on the error for the life of the view.
      expect(getBenchMonthly).not.toHaveBeenCalled();
      expect(host.querySelectorAll('[data-test="availability-dot"]')).toHaveLength(0);
      expect(host.querySelector('[data-test="availability-legend"]')).toBeNull();
    });
  });
});
