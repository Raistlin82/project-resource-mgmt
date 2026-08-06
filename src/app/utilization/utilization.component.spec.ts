import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { UtilizationComponent } from './utilization.component';
import { capabilitiesForRole } from '../services/access-policy.util';
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
  // canReadStaffing/canManageStaffing are DERIVED from the same `role` option
  // through the real capability table, never hand-set: /utilization's route
  // guard is canReadStaffing() (so 'finance' reaches the screen) while every
  // /assignments mutation is canManageStaffing() (so 'finance' is refused). A
  // stub that let the two drift would be the "fixture that lies about identity"
  // this project has already paid for — the write-affordance tests below can
  // only be about a role that genuinely holds one capability and not the other.
  const caps = capabilitiesForRole(role);
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal(role), userId: signal(userId),
    canReadStaffing: signal(caps.canReadStaffing),
    canManageStaffing: signal(caps.canManageStaffing),
  } as unknown as AuthService;
  // Left as the bare mock (cast only at the provider) so the delete-confirmation
  // tests can assert on `notifyStub.success` — the toast deleteAssignment lacked.
  const notifyStub = { success: vi.fn(), error: vi.fn() };

  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: apiStub as unknown as ApiService },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub as unknown as NotificationService },
    ],
  });
  const fixture = TestBed.createComponent(UtilizationComponent);
  fixture.detectChanges();
  return {
    fixture, component: fixture.componentInstance,
    host: fixture.nativeElement as HTMLElement, apiStub, notifyStub,
  };
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
    // The KPI tile itself, not just the list. The crash this guard replaced is
    // caught incidentally by the assertions above (countedForAverage() throws on
    // an errored resource), but a REGRESSION to a non-crashing wrong fallback is
    // not: reverting to the pre-existing "—" would render silently, and a dash
    // means "no value", never "we could not load it". Assert both directions.
    const avg = host.querySelector('[data-test="team-average"]');
    expect(avg?.textContent).toContain('Unavailable');
    expect(avg?.textContent).not.toContain('—');
  });
});

describe('UtilizationComponent — Right Pane resilience to a reload failure', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // Round-1 review CRITICAL: the Right Pane's `@if (selectedResource())` is
  // evaluated on every CD pass and was NOT gated on loading()/hasError() —
  // selectedResource() reads resources(), which dereferences
  // dataResource.value() unconditionally, and .value() THROWS while
  // dataResource.status() === 'error'. The reachable path: select a row ->
  // approve/reject a time entry, or save/paste/delete an assignment (every
  // one of those calls dataResource.reload() on success) -> the reload's
  // now-five-required-leg forkJoin fails -> next CD pass hits
  // `@if (selectedResource())` -> throw, taking the whole page down
  // (documented in this codebase's own words at contract-details.ts:1042-1044).
  //
  // The existing "bench read fails" test above never calls selectResource(),
  // so selectedResourceId stays null and selectedResource() short-circuits
  // BEFORE ever touching resources() — it cannot catch this. This test
  // selects a resource FIRST (so the Right Pane genuinely renders her
  // details, proven by the 'Capacity:'/'h/week' marker), and only THEN drives
  // dataResource into its error state via a reload — the actual reachable
  // order of events, not the reverse.
  it('shows the error affordance in the Right Pane, not a crash, when a reload fails after a resource is already selected', async () => {
    const { fixture, host, component, apiStub } = setup({ assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(fixture);

    component.selectResource(RESOURCES[0]); // Direct Dana
    fixture.detectChanges();
    // Precondition: her details are genuinely showing (capacity 40 from
    // `base`) before the failure — otherwise this test would not actually
    // exercise "a live selection survives a failed reload".
    expect(host.textContent ?? '').toContain('40h/week');

    // Simulate the reachable trigger: approving/rejecting/saving mutates,
    // then calls dataResource.reload() on success — and this time the
    // REQUIRED benchRollup leg fails.
    apiStub.getBenchMonthly.mockReturnValue(throwError(() => new Error('bench endpoint down')));
    // dataResource is `protected` (the template calls it directly for the
    // retry affordance) — reaching it here exercises the exact same reload
    // mechanism every mutation handler (approve/reject/save/paste/delete)
    // triggers on success, without coupling this test to any one of them.
    (component as unknown as { dataResource: { reload: () => void } }).dataResource.reload();
    await flush(fixture);

    // Both panels share the one dataResource, so both show list-state's
    // error affordance — never a thrown exception, never the stale resource
    // header still showing.
    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBeGreaterThan(0);
    expect(host.textContent ?? '').not.toContain('Direct Dana');
    expect(host.textContent ?? '').not.toContain('40h/week');
  });

  // Twin of the test above: the Right Pane's OWN empty state ("Select a
  // Resource") must not be confused with its error state either — pairs a
  // presence assertion (error alert) with an absence assertion (the empty
  // state's own copy), on the exact same failure.
  it('does NOT fall back to the "Select a Resource" empty copy when the reload fails with a live selection', async () => {
    const { fixture, host, component, apiStub } = setup({ assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(fixture);
    component.selectResource(RESOURCES[0]);
    fixture.detectChanges();

    apiStub.getBenchMonthly.mockReturnValue(throwError(() => new Error('bench endpoint down')));
    // dataResource is `protected` (the template calls it directly for the
    // retry affordance) — reaching it here exercises the exact same reload
    // mechanism every mutation handler (approve/reject/save/paste/delete)
    // triggers on success, without coupling this test to any one of them.
    (component as unknown as { dataResource: { reload: () => void } }).dataResource.reload();
    await flush(fixture);

    expect(host.textContent ?? '').not.toContain('Select a Resource');
    expect(host.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
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

describe('UtilizationComponent — the row\'s accessible name carries what role="button" prunes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ANNA = { ...base, id: 'an', name: 'Anna Rossi', role: 'Developer', utilization: 87, kind: 'internal', managerId: 'm1' } as Resource;
  const BRUNO = { ...base, id: 'br', name: 'Bruno Bianchi', role: 'Developer', utilization: 12, kind: 'internal', managerId: 'm1' } as Resource;
  const TWO_ROWS: BenchRollup = {
    months: ['2026-04'],
    internalRows: [
      {
        resourceId: 'an', resourceName: 'Anna Rossi', kind: 'internal',
        monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } },
        availabilityDate: { kind: 'date', date: '2026-04-01' },
      },
      {
        resourceId: 'br', resourceName: 'Bruno Bianchi', kind: 'internal',
        monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } },
        availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-04' },
      },
    ],
    subcoRows: [],
    hiringDemand: [],
  };

  const labelFor = (host: HTMLElement, name: string): string =>
    rowFor(host, name).getAttribute('aria-label') ?? '';

  // The row is role="button", i.e. an ARIA composite: every descendant is
  // pruned from the accessibility tree, so the utilization % and the bench
  // badge rendered inside it are announced by nothing. The accessible NAME is
  // their only carrier, and it used to be the constant "Select <name>
  // utilization details" — a name that cannot distinguish an 8%-bench resource
  // from a 130%-overbooked one.
  it('carries this row\'s own utilization and bench state, and never the other row\'s', async () => {
    const { fixture, host } = setup({ resources: [ANNA, BRUNO], benchRollup: TWO_ROWS });
    await flush(fixture);

    expect(labelFor(host, 'Anna Rossi')).toMatch(/87/);
    expect(labelFor(host, 'Anna Rossi')).toMatch(/BENCH/);

    // The ABSENCE twin, and the only thing that makes the two assertions above
    // mean anything: a hard-coded or shared label string would satisfy them for
    // BOTH rows. Bruno must carry his own numbers and none of Anna's.
    expect(labelFor(host, 'Bruno Bianchi')).not.toMatch(/87/);
    expect(labelFor(host, 'Bruno Bianchi')).not.toMatch(/BENCH/);
    expect(labelFor(host, 'Bruno Bianchi')).toMatch(/12/);
    expect(labelFor(host, 'Bruno Bianchi')).toMatch(/ALLOCATED/);
  });

  it('rounds the spoken utilization to whole percent, never to raw float precision', async () => {
    // The ≤2-decimals project rule governs the spoken string too. 87.4321 must
    // not leak into the accessible name as "87.4321%".
    const messy = { ...ANNA, utilization: 87.4321 } as Resource;
    const { fixture, host } = setup({ resources: [messy], benchRollup: TWO_ROWS });
    await flush(fixture);
    const label = labelFor(host, 'Anna Rossi');
    expect(label).toContain('87%');
    expect(label).not.toContain('87.4321');
    expect(label).not.toMatch(/\d\.\d{3}/);
  });

  it('does not end in a dangling separator when the rollup has no row for that resource', async () => {
    // benchBadge() legitimately returns '' for a real resource absent from this
    // month's rollup (the third meaning in the bench-badge block above), so a
    // bare ", " + '' concatenation would end the spoken name mid-sentence.
    // EMPTY_BENCH_ROLLUP is the default fixture — no rows at all.
    const { fixture, host } = setup({ resources: [ANNA] });
    await flush(fixture);
    const label = labelFor(host, 'Anna Rossi');
    expect(label).toContain('87%');
    expect(label.endsWith('%')).toBe(true);
    expect(label).not.toMatch(/BENCH|PARTIAL|ALLOCATED|Not applicable/);
  });
});

describe('UtilizationComponent — assignment write affordances follow canManageStaffing', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // The MECHANISM, asserted before either case below, so neither can pass on a
  // fixture that quietly lies about the principal: this route's guard is
  // canReadStaffing() (finance genuinely gets here) while /assignments
  // mutations need canManageStaffing() (finance is genuinely refused). If
  // either half ever changes, this test fails first and says the premise moved.
  it('finance may read this route but not manage staffing — the premise of both cases below', () => {
    expect(capabilitiesForRole('finance').canReadStaffing).toBe(true);
    expect(capabilitiesForRole('finance').canManageStaffing).toBe(false);
    expect(capabilitiesForRole('resource-manager').canManageStaffing).toBe(true);
  });

  const writeControls = (host: HTMLElement) => ({
    delete: host.querySelectorAll('button[aria-label^="Delete assignment for"]').length,
    edit: host.querySelectorAll('button[aria-label^="Edit assignment for"]').length,
    create: [...host.querySelectorAll('button')].filter(b => /Create/.test(b.textContent ?? '')).length,
  });

  async function withSelection(role: 'finance' | 'resource-manager') {
    const s = setup({ role, assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(s.fixture);
    s.component.selectResource(RESOURCES[0]); // Direct Dana, who owns ASSIGNMENTS[0]
    await flush(s.fixture);
    // Precondition: the right pane really rendered, WITH the assignment row —
    // otherwise "no write buttons" would be vacuously true because nothing at
    // all was on screen (the exact vacuum this project keeps paying for).
    expect(s.host.textContent ?? '').toContain('40h/week');
    expect(s.host.textContent ?? '').toContain('Delivery');
    return s;
  }

  it('renders none of Create/Edit/Delete for finance, every one of which the server answers with 403', async () => {
    const { host } = await withSelection('finance');
    expect(writeControls(host)).toStrictEqual({ delete: 0, edit: 0, create: 0 });
  });

  it('renders all three for resource-manager — the mirror that stops a gate which simply always refuses', async () => {
    const { host } = await withSelection('resource-manager');
    expect(writeControls(host)).toStrictEqual({ delete: 1, edit: 1, create: 1 });
  });

  it('refuses the write handlers for finance when called directly, not only through the template', async () => {
    // The template gate is one refactor away from being the only gate. These
    // are the four entry points that reach /assignments.
    const { component, apiStub } = await withSelection('finance');

    component.openCreateForm();
    expect(component.showForm()).toBe(false);
    component.assignmentForm.patchValue({ requestId: 'q1' });
    component.saveAssignment();
    component.openEditForm(ASSIGNMENTS[0]);
    component.saveAssignment();
    component.copyAssignment(ASSIGNMENTS[0]);
    component.pasteAssignment();

    expect(apiStub.createAssignment).not.toHaveBeenCalled();
    expect(apiStub.updateAssignment).not.toHaveBeenCalled();
    expect(apiStub.deleteAssignment).not.toHaveBeenCalled();
  });

  it('still lets resource-manager through those same handlers — the mirror for the guard clauses', async () => {
    const { component, apiStub } = await withSelection('resource-manager');
    component.openCreateForm();
    expect(component.showForm()).toBe(true);
    component.assignmentForm.patchValue({ requestId: 'q1' });
    component.saveAssignment();
    expect(apiStub.createAssignment).toHaveBeenCalledWith({ requestId: 'q1', resourceId: 'd1' });
  });
});

describe('UtilizationComponent — deleting an assignment is confirmed and names what it moves', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const trash = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>('button[aria-label^="Delete assignment for"]')!;
  const dialog = (host: HTMLElement) => host.querySelector('[appModal]');
  const dialogButton = (host: HTMLElement, re: RegExp) =>
    [...dialog(host)!.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))!;

  async function armed() {
    const s = setup({ assignments: ASSIGNMENTS, requests: REQUESTS });
    await flush(s.fixture);
    s.component.selectResource(RESOURCES[0]);
    await flush(s.fixture);
    expect(dialog(s.host)).toBeNull(); // nothing armed before the click
    trash(s.host).click();
    await flush(s.fixture);
    return s;
  }

  it('does NOT delete on the first click — it opens a dialog naming the project and the recomputation', async () => {
    const { host, apiStub } = await armed();

    // The ABSENCE assertion the pre-fix code fails outright: the DELETE used to
    // go out on this very click, on a control that (before the focus-within
    // fix) a keyboard user could not even see.
    expect(apiStub.deleteAssignment).not.toHaveBeenCalled();

    const text = dialog(host)?.textContent ?? '';
    expect(text).toContain('Delivery');      // the object — not a bare "Are you sure?"
    expect(text).toContain('Direct Dana');   // …and who is being removed from it
    // The consequence the server produces under a lock, which is the part a
    // generic confirmation would hide: BOTH derived figures must be named.
    expect(text).toMatch(/staffed effort/i);
    expect(text).toMatch(/utilization/i);
  });

  it('deletes exactly once, only from the confirm control, and then says what moved', async () => {
    const { host, fixture, apiStub, notifyStub } = await armed();

    dialogButton(host, /Delete assignment/).click();
    await flush(fixture);

    expect(apiStub.deleteAssignment).toHaveBeenCalledTimes(1);
    expect(apiStub.deleteAssignment).toHaveBeenCalledWith('a1');
    expect(dialog(host)).toBeNull(); // the dialog closes on success
    // The handler had no feedback at all before. The toast must name the
    // derived effects, since they are what actually moved off-screen.
    expect(notifyStub.success).toHaveBeenCalledTimes(1);
    const toast = String(notifyStub.success.mock.calls[0][0]);
    expect(toast).toContain('Delivery');
    expect(toast).toMatch(/utilization/i);
  });

  it('cancelling closes the dialog and deletes nothing', async () => {
    const { host, fixture, apiStub } = await armed();

    dialogButton(host, /Cancel/).click();
    await flush(fixture);

    expect(dialog(host)).toBeNull();
    expect(apiStub.deleteAssignment).not.toHaveBeenCalled();
    // The row is still there — cancelling must not look like a delete.
    expect(host.querySelectorAll('button[aria-label^="Delete assignment for"]').length).toBe(1);
  });

  it('keeps the dialog open when the DELETE fails, so it cannot report a delete that did not happen', async () => {
    const { host, fixture, apiStub, notifyStub } = await armed();
    apiStub.deleteAssignment.mockReturnValue(throwError(() => new Error('403')));

    dialogButton(host, /Delete assignment/).click();
    await flush(fixture);

    expect(dialog(host)).not.toBeNull();
    expect(notifyStub.success).not.toHaveBeenCalled();
    expect(notifyStub.error).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Static scan — a hover-only reveal must also reveal on FOCUS.
//
// jsdom performs NO layout: nothing below proves what a 1280px browser paints,
// and it deliberately does not claim to. What it proves is the STRUCTURAL
// PRECONDITION — every class attribute in src/app that hides a control behind
// hover from the `sm` breakpoint up also un-hides it when focus enters, which is
// the difference between a keyboard user seeing the caret and Tabbing blind
// across three invisible stops (one of them a delete).
// -----------------------------------------------------------------------------

const APP_DIR = resolve(process.cwd(), 'src/app');

function componentSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return componentSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

interface ClassAttr { where: string; classes: string }

/** Every `class="…"` attribute in src/app whose value hides behind `sm` hover. */
function hoverOnlyRevealSites(): ClassAttr[] {
  const sites: ClassAttr[] = [];
  for (const file of componentSources(APP_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bclass="([^"]*)"/g)) {
      if (!m[1].includes('sm:opacity-0')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ where: `${relative(process.cwd(), file)}:${line}`, classes: m[1] });
    }
  }
  return sites;
}

/**
 * True when some class token reveals the element at opacity-100 on focus.
 * Token-wise rather than by substring, and it accepts the `group-focus[-within]`
 * variants explicitly — `sm:group-focus-within:opacity-100` (my-profile) is a
 * correct reveal, and a naive substring test for 'focus-within:opacity-100'
 * would pass it only by accident.
 */
function revealsOnFocus(classes: string): boolean {
  const FOCUS_VARIANTS = new Set(['focus', 'focus-within', 'group-focus', 'group-focus-within']);
  return classes.split(/\s+/).some(token => {
    if (!token.endsWith(':opacity-100')) return false;
    return token.slice(0, -':opacity-100'.length).split(':').some(v => FOCUS_VARIANTS.has(v));
  });
}

describe('hover-only action clusters reveal on focus too (structural precondition — jsdom does not lay out)', () => {
  const sites = hoverOnlyRevealSites();

  it('discriminates a hover-only cluster from a focus-revealing one, so the predicate is no tautology', () => {
    // THE NEGATIVE CONTROL, and the reason the scan below means anything. Left
    // string is the EXACT class attribute utilization.component.ts carried
    // before this fix; right string is the same attribute after it.
    expect(revealsOnFocus('flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity')).toBe(false);
    expect(revealsOnFocus('flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity')).toBe(true);
    // A plain, unconditional opacity-100 is not a focus reveal either.
    expect(revealsOnFocus('opacity-100 sm:opacity-0 sm:group-hover:opacity-100')).toBe(false);
    // …and the group- variants must be accepted rather than tolerated by luck.
    expect(revealsOnFocus('sm:opacity-0 sm:group-focus-within:opacity-100')).toBe(true);
    expect(revealsOnFocus('sm:opacity-0 focus:opacity-100')).toBe(true);
  });

  it('finds the sm:opacity-0 sites at all — the guard against a regex typo passing on an empty set', () => {
    // 8 today. A scan that silently collected nothing would otherwise report
    // "no offenders" forever, which is how a check of this shape goes blind.
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });

  it('every one of them also reveals on focus', () => {
    const offenders = sites.filter(s => !revealsOnFocus(s.classes)).map(s => s.where);
    expect(offenders).toStrictEqual([]);
  });
});
