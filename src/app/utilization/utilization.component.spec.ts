import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { UtilizationComponent } from './utilization.component';
import {
  ApiService,
  type Assignment,
  type BenchRollup,
  type Resource,
  type ResourceOrganization,
  type ResourceRequest,
  type UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';

// Tree: CAP 'Engineering' (managed by m1) > PRA 'Platform' > COM 'Backend'
const ORGS: ResourceOrganization[] = [
  { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 'm1' },
  { id: 'o2', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'o1' },
  { id: 'o3', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'o2' },
  { id: 'o4', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
];

const base = { skills: [], projectRoles: [], externalExperience: [], capacity: 40 };
const RESOURCES: Resource[] = [
  // reachable ONLY through the org chart (no organization at all)
  { ...base, id: 'd1', name: 'Direct Dana', role: 'Developer', utilization: 80, kind: 'internal', managerId: 'm1' },
  // reachable ONLY through the org subtree, two levels down, no org-chart link
  { ...base, id: 's1', name: 'Subtree Sven', role: 'Developer', utilization: 40, kind: 'internal', organization: 'Backend' },
  // a placeholder inside the same subtree
  { ...base, id: 'p1', name: 'Dummy Placeholder', role: 'Developer', utilization: 0, kind: 'dummy', organization: 'Platform' },
  // outside every axis
  { ...base, id: 'x1', name: 'Outside Otto', role: 'Developer', utilization: 90, kind: 'internal', organization: 'Consulting' },
] as Resource[];

const REQUESTS: ResourceRequest[] = [{
  id: 'q1', name: 'Delivery', requiredRole: 'Developer', requiredEffort: 40,
  skills: [], status: 'Open', staffedEffort: 0,
}];

const ASSIGNMENTS: Assignment[] = [{
  id: 'a1', requestId: 'q1', resourceId: 'd1', assignedHours: 40, status: 'Draft',
}];

interface SetupOptions {
  resources?: Resource[];
  orgs?: ResourceOrganization[];
  assignments?: Assignment[];
  requests?: ResourceRequest[];
  userId?: string;
  role?: UserRole;
  orgsFail?: boolean;
  benchRollup?: BenchRollup;
  benchFails?: boolean;
}

function setup({
  resources = RESOURCES,
  orgs = ORGS,
  assignments = [],
  requests = [],
  userId = 'm1',
  role = 'resource-manager',
  orgsFail = false,
  benchRollup = EMPTY_BENCH_ROLLUP,
  benchFails = false,
}: SetupOptions = {}) {
  const apiStub = {
    getResources: vi.fn(() => of(resources)),
    getAssignments: vi.fn(() => of(assignments)),
    getRequests: vi.fn(() => of(requests)),
    getTimeEntries: vi.fn(() => of([])),
    getResourceOrganizations: vi.fn(() => orgsFail ? throwError(() => new Error('tree endpoint down')) : of(orgs)),
    // Required forkJoin leg (no catchError in the component) — unlike
    // `orgsFail`, a bench-read failure must collapse the WHOLE dataResource
    // to its error state, never degrade to an empty/zero bench rollup.
    getBenchMonthly: vi.fn(() => benchFails ? throwError(() => new Error('bench endpoint down')) : of(benchRollup)),
    createAssignment: vi.fn((data: Partial<Assignment>) => of({
      id: 'created', assignedHours: 0, status: 'Draft', ...data,
    } as Assignment)),
    updateAssignment: vi.fn((id: string, data: Partial<Assignment>) => of({
      ...ASSIGNMENTS[0], id, ...data,
    } as Assignment)),
    deleteAssignment: vi.fn(() => of(undefined)),
    updateTimeEntry: vi.fn(),
  };
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal(role), userId: signal(userId),
  } as unknown as AuthService;
  const notifyStub = { success: vi.fn(), error: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: apiStub as unknown as ApiService },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(UtilizationComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, host: fixture.nativeElement as HTMLElement, apiStub };
}

const names = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-test="team-member"]')].map(e => e.textContent?.trim() ?? '');

/**
 * Scopes a query to the ONE "My Team" row for `name` — never the whole host.
 * The Assignments and Actual Time Approval panes on the right ALSO render
 * `.command-status` elements (assignment/time-entry status), so an unscoped
 * `host.querySelector('.command-status')` could silently match one of those
 * instead of the bench badge under test — exactly the class of defect this
 * block's reviews have caught before (an unscoped query matching a different
 * table's identical markup).
 */
function rowFor(host: HTMLElement, name: string): HTMLElement {
  const nameEl = [...host.querySelectorAll('[data-test="team-member"]')].find(e => e.textContent?.trim() === name);
  if (!nameEl) throw new Error(`no "My Team" row found for "${name}"`);
  const row = nameEl.closest('[role="button"]');
  if (!row) throw new Error(`"${name}"'s row container was not found`);
  return row as HTMLElement;
}

function benchBadgeText(host: HTMLElement, name: string): string {
  return rowFor(host, name).querySelector('[data-test="bench-badge"]')!.textContent?.trim() ?? '';
}

/** `getResources()`/`getResourceOrganizations()` (an rxResource, like every
 *  other principal-gated feed in this codebase) resolve asynchronously even
 *  over a synchronous `of(...)` stream — mirrors the `flush` helper in
 *  resources.component.spec.ts / approval-modal.component.spec.ts. Every
 *  assertion on the loaded team list needs this BEFORE reading the DOM. */
async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('UtilizationComponent — team scope', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to direct reports, exactly the pre-existing behaviour', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    expect(names(host).join(' ')).toContain('Direct Dana');
    expect(names(host).join(' ')).not.toContain('Subtree Sven');
    // Dana is the ONLY row on the default view and she is internal, so the
    // list and the average's denominator agree exactly here. Every other
    // assertion on this hook in this file only checks it is PRESENT — this is
    // the one place that pins it ABSENT, which is the branch's actual promise:
    // nobody's number, and nobody's screen, changes on the pre-existing view.
    expect(host.querySelector('[data-test="kpi-internal-note"]')).toBeNull();
  });

  it('switching to All my org adds people reachable only through the org subtree', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    const shown = names(host).join(' ');
    // Sven sits on 'Backend', two levels under the capability m1 manages, with no
    // org-chart link — an implementation matching only `organization === node`
    // would miss him, which is the whole point of deriving through the tree.
    expect(shown).toContain('Subtree Sven');
    expect(shown).toContain('Direct Dana');       // the chart axis still counts
    expect(shown).not.toContain('Outside Otto');
  });

  it('shows a placeholder in the org list but keeps it out of the average', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(names(host).join(' ')).toContain('Dummy Placeholder');
    // Internal-only mean: Dana 80 + Sven 40 = 60. Including the dummy's 0 would read 40.
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });

  it('excludes a placeholder from the average in Direct reports too, when it has a manager', async () => {
    // None of the other fixtures give a dummy/subco a `managerId`, so this is
    // the only case that exercises `countedForAverage` on the DIRECT branch —
    // its own comment says the internal-only rule is not `teamScope`-conditional
    // ("a placeholder given a manager would otherwise land in the direct one
    // too"), but nothing else here proves it.
    const resources = [
      ...RESOURCES,
      { ...base, id: 'p2', name: 'Direct Dummy', role: 'Developer', utilization: 0, kind: 'dummy', managerId: 'm1' },
    ] as Resource[];
    const { fixture, host } = setup({ resources });
    await flush(fixture);
    const shown = names(host).join(' ');
    expect(shown).toContain('Direct Dana');
    expect(shown).toContain('Direct Dummy');
    // Dana alone counts (80) — the dummy is listed but never in the denominator.
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('80');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });

  it('the average follows the view', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('80'); // Dana alone
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
  });

  it('explains an empty direct-reports view and an empty org view differently', async () => {
    // 'nobody' manages no person and no node.
    const { fixture, host } = setup({ userId: 'nobody' });
    await flush(fixture);
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('report directly');
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('organization');
  });

  it('degrades to the org-chart axis instead of collapsing when the org tree endpoint fails alone', async () => {
    // forkJoin is fail-fast: without a catchError scoped to the orgs leg, an
    // isolated failure of GET /resource-organizations would throw the whole
    // dataResource and take the Direct-reports list down with it, even though
    // neither Direct reports nor the assignments/time-approval panes read the
    // tree at all. The fix confines the catch to that one leg.
    const { fixture, host } = setup({ orgsFail: true });
    await flush(fixture);
    // Direct reports (the unchanged, pre-existing view) must survive untouched.
    expect(names(host).join(' ')).toContain('Direct Dana');
    // The 'org' view degrades to the org-chart axis alone (scopeOf with an
    // empty node list has no managed roots, so it falls back to
    // reportsClosure) rather than erroring — Dana still shows via the chart
    // axis, but Sven (reachable ONLY through the now-missing org subtree)
    // does not.
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    const shown = names(host).join(' ');
    expect(shown).toContain('Direct Dana');
    expect(shown).not.toContain('Subtree Sven');
  });

  it('keeps the view switch visible even when the org view would be empty', async () => {
    const { fixture, host } = setup({ userId: 'nobody' });
    await flush(fixture);
    expect(host.querySelector('[data-test="team-scope-org"]')).not.toBeNull();
  });

  it.each(['admin', 'delivery-executive'] as const)(
    '%s sees their OWN org scope in All my org, not the whole company',
    async role => {
      // Both roles are omniscient in the Allocation Approvals feed, but
      // `managedResources` never reads `auth.role()` — only `scopeOf(userId, ...)`
      // — so the design's "same scope for every role" decision must hold for
      // them too. 'Outside Otto' sits on 'Consulting', a capability m1 does not
      // manage: whole-company visibility would surface him, `scopeOf(m1, ...)`
      // must not.
      const { fixture, host } = setup({ role });
      await flush(fixture);
      host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
      fixture.detectChanges();
      const shown = names(host).join(' ');
      expect(shown).toContain('Direct Dana');
      expect(shown).toContain('Subtree Sven');
      expect(shown).not.toContain('Outside Otto');
    },
  );

  it('renders a neutral dash, not a red 0%, when every row in view is non-internal', async () => {
    // Both rows are dummy/subco, so `countedForAverage()` is EMPTY and
    // `averageUtilization`'s `if (!counted.length) return 0` branch is what
    // actually runs — the design's §4 table calls this exact case out
    // ("La lista li mostra, la media è 0 su denominatore vuoto") and nothing
    // else in this file reaches it: every other fixture mixes in at least one
    // internal resource.
    const resources = [
      { ...base, id: 'p3', name: 'Idle Placeholder', role: 'Developer', utilization: 0, kind: 'dummy', managerId: 'm1' },
      { ...base, id: 'p4', name: 'Idle Subco', role: 'Developer', utilization: 0, kind: 'subco', managerId: 'm1', vendorId: 'v9' },
    ] as Resource[];
    const { fixture, host } = setup({ resources });
    await flush(fixture);
    const shown = names(host).join(' ');
    expect(shown).toContain('Idle Placeholder');
    expect(shown).toContain('Idle Subco');
    const avgEl = host.querySelector('[data-test="team-average"]')!;
    // The VALUE 0 is correct here (spec-adjudicated, matches /reporting) —
    // what must not happen is colour-banding it through the critical/red
    // band, which would read as "my team is completely idle" for a subtree
    // that is simply unmeasured (no internal capacity to measure at all).
    expect(avgEl.textContent).toContain('—');
    expect(avgEl.textContent).not.toContain('0%');
    expect(avgEl.className).not.toContain('text-critical-text');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });
});

describe('UtilizationComponent — bench badge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows a BENCH badge for an internal/subco team member on bench this month', async () => {
    const rollup: BenchRollup = {
      months: ['2026-04'],
      internalRows: [{
        resourceId: 'd1', resourceName: 'Direct Dana', kind: 'internal',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      }],
      subcoRows: [],
      hiringDemand: [],
    };
    const { fixture, host } = setup({ benchRollup: rollup });
    await flush(fixture);
    expect(benchBadgeText(host, 'Direct Dana')).toBe('BENCH');
  });

  it('shows "Not applicable" for a dummy resource that has a manager (never BENCH, never omitted)', async () => {
    const resources = [
      ...RESOURCES,
      { ...base, id: 'p2', name: 'Direct Dummy', role: 'Developer', utilization: 0, kind: 'dummy', managerId: 'm1' },
    ] as Resource[];
    // Adversarial: the mocked rollup gives the DUMMY's own resourceId a real
    // BENCH row — something the server's benchRollup() would never actually
    // produce, since dummy is excluded by kind (design spec §4). Doing this
    // in the test proves the COMPONENT gates on kindOf(res) itself, not
    // merely on the (incidental, in real data) absence of a row for that id.
    const rollup: BenchRollup = {
      months: ['2026-04'],
      internalRows: [{
        resourceId: 'd1', resourceName: 'Direct Dana', kind: 'internal',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      }],
      subcoRows: [{
        resourceId: 'p2', resourceName: 'Direct Dummy', kind: 'subco',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      }],
      hiringDemand: [],
    };
    const { fixture, host } = setup({ resources, benchRollup: rollup });
    await flush(fixture);
    expect(benchBadgeText(host, 'Direct Dummy')).toBe('Not applicable');
  });

  it('does NOT show "Not applicable" on a real internal/subco row (the twin absence check)', async () => {
    // Same fixture as the previous test — the dummy's 'Not applicable' is
    // paired with an assertion on the SAME rollup's real internal row, so a
    // broken kind-gate that marked everything (or nothing) 'Not applicable'
    // cannot pass both tests at once.
    const resources = [
      ...RESOURCES,
      { ...base, id: 'p2', name: 'Direct Dummy', role: 'Developer', utilization: 0, kind: 'dummy', managerId: 'm1' },
    ] as Resource[];
    const rollup: BenchRollup = {
      months: ['2026-04'],
      internalRows: [{
        resourceId: 'd1', resourceName: 'Direct Dana', kind: 'internal',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      }],
      subcoRows: [{
        resourceId: 'p2', resourceName: 'Direct Dummy', kind: 'subco',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      }],
      hiringDemand: [],
    };
    const { fixture, host } = setup({ resources, benchRollup: rollup });
    await flush(fixture);
    const danaBadge = benchBadgeText(host, 'Direct Dana');
    expect(danaBadge).toBe('BENCH');
    expect(danaBadge).not.toBe('Not applicable');
  });

  // Global Constraint's three-way distinction (a missing bench row can mean
  // "dummy", "read failed", or "genuinely no bench state this month") needs
  // three SEPARATE tests, not one collapsed check. The two tests above cover
  // dummy vs. real-with-a-row; this one covers the third meaning: a real
  // resource that the (successfully loaded) rollup simply has no row for.
  // EMPTY_BENCH_ROLLUP (the default) has no rows at all — Dana must render
  // blank, NEVER 'Not applicable' (that would misreport her as a dummy) and
  // never a stale/failed-looking value.
  it('renders no bench state at all — never "Not applicable" — for a real resource absent from this month\'s rollup', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    const badge = benchBadgeText(host, 'Direct Dana');
    expect(badge).toBe('');
    expect(badge).not.toBe('Not applicable');
  });

  // Third leg of the three-way distinction: the bench read itself fails.
  // forkJoin is fail-fast and `benchRollup` is a REQUIRED leg (no catchError,
  // unlike `orgs`) — a failure here must collapse the WHOLE "My Team" list to
  // list-state's error affordance, never render the pre-existing "team-empty"
  // copy ("Nobody is set up to report directly to you"), which would assert a
  // fact (zero direct reports) the failed fetch never established.
  it('shows the error affordance, not a confident empty team list, when the bench read fails', async () => {
    const { fixture, host } = setup({ benchFails: true });
    await flush(fixture);
    const alert = host.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(host.querySelector('[data-test="team-empty"]')).toBeNull();
    expect(host.querySelector('[data-test="team-member"]')).toBeNull();
  });
});

describe('UtilizationComponent — assignment write integrity', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('does not offer assignedHours as an editable assignment field', async () => {
    const { fixture, component, host } = setup({ assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(fixture);
    component.selectResource(RESOURCES[0]);
    component.openCreateForm();
    fixture.detectChanges();

    expect(component.assignmentForm.contains('assignedHours')).toBe(false);
    expect(host.querySelector('#assignedHours')).toBeNull();
    expect(host.textContent).toContain('Allocation Calendar');
  });

  it('creates, edits and copies assignment shells without writing derived hours', async () => {
    const { fixture, component, apiStub } = setup({ assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(fixture);
    component.selectResource(RESOURCES[0]);

    component.openCreateForm();
    component.assignmentForm.patchValue({ requestId: 'q1' });
    component.saveAssignment();
    expect(apiStub.createAssignment).toHaveBeenCalledWith({ requestId: 'q1', resourceId: 'd1' });

    component.openEditForm(ASSIGNMENTS[0]);
    component.saveAssignment();
    expect(apiStub.updateAssignment).toHaveBeenCalledWith('a1', { requestId: 'q1', resourceId: 'd1' });

    component.copyAssignment(ASSIGNMENTS[0]);
    component.pasteAssignment();
    expect(apiStub.createAssignment).toHaveBeenLastCalledWith({ requestId: 'q1', resourceId: 'd1' });
    for (const [payload] of apiStub.createAssignment.mock.calls) {
      expect(payload).not.toHaveProperty('assignedHours');
    }
  });
});
