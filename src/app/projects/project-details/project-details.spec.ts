import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ProjectDetailsComponent } from './project-details';
import { ApiService, AssignmentDay, AssignmentMonth, CostBaseline, Project, Resource, ResourceRequest, Assignment } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * Reads a "Baseline vs Planned" summary KPI tile by its exact label text
 * ("Baseline" / "Planned" / "Delta"), returning its value and note text.
 * Scoped to the specific tile (matched by exact label, not a substring) so
 * an assertion here cannot be satisfied by a different tile that happens to
 * render a similar-looking figure elsewhere on this page — `baselineTotals`
 * itself is `protected` (template-only, matching this codebase's convention
 * for signals no other class should reach into), so the rendered DOM is
 * also the only way to observe it without weakening that visibility.
 */
function baselineKpi(fixture: { nativeElement: unknown }, label: 'Baseline' | 'Planned' | 'Delta'): { value: string; note: string } {
  const labels = Array.from(host(fixture).querySelectorAll('.command-kpi-label'));
  const labelEl = labels.find(el => el.textContent?.trim() === label);
  expect(labelEl, `the "${label}" KPI tile must exist`).toBeDefined();
  const tile = labelEl!.closest('.command-kpi');
  expect(tile, `the "${label}" KPI tile's container must exist`).toBeDefined();
  const value = tile!.querySelector('.command-kpi-value')?.textContent?.trim() ?? '';
  const note = tile!.querySelector('.command-kpi-note')?.textContent?.trim() ?? '';
  return { value, note };
}

async function tick(fixture: ComponentFixture<unknown>, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const PROJECT: Project = { id: 'P1', name: 'Project One', location: 'Berlin', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
const RESOURCE: Resource = { id: 'R1', name: 'Res One', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 };
const REQUEST: ResourceRequest = { id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' };
const ASSIGNMENT: Assignment = { id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' };
const DAYS: AssignmentDay[] = [{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }];
const MONTHS: AssignmentMonth[] = [{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' }];
const BASELINE: CostBaseline[] = [{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }];

function makeApiStub(overrides: Partial<Record<string, unknown>> = {}) {
  const empty = () => of([]);
  // Every method is a vi.fn() spy — not just the default fixtures but any
  // override too — so `expect(api.getAssignmentDays).not.toHaveBeenCalled()`
  // (the presence/absence pair this card's RBAC gating exists to prove) has
  // something real to assert on regardless of which branch supplied the fn.
  const base: Record<string, () => unknown> = {
    getProjects: () => of([PROJECT]),
    getOrders: empty, getOrderLines: empty, getProjectFinancials: empty, getTimeEntries: empty,
    getProjectIssues: empty, getChangeRequests: empty,
    getRequests: () => of([REQUEST]),
    getAssignments: () => of([ASSIGNMENT]),
    getResources: () => of([RESOURCE]),
    getAssignmentDays: () => of(DAYS),
    getAssignmentMonths: () => of(MONTHS),
    getCostBaselines: () => of(BASELINE),
    freezeCostBaseline: () => of(BASELINE),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService;
}

function makeAuthStub(role: 'employee' | 'sales' | 'pm' | 'finance') {
  const canReadStaffing = ['pm', 'finance'].includes(role);
  const canApproveFinancials = role === 'finance';
  return {
    authReady: () => true,
    canReadStaffing: () => canReadStaffing,
    canApproveFinancials: () => canApproveFinancials,
    canManageCommercial: () => false,
  } as unknown as AuthService;
}

async function render(role: 'employee' | 'sales' | 'pm' | 'finance', apiOverrides: Partial<Record<string, unknown>> = {}) {
  const api = makeApiStub(apiOverrides);
  TestBed.configureTestingModule({
    imports: [ProjectDetailsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectDetailsComponent);
  fixture.componentRef.setInput('id', 'P1');
  await tick(fixture);
  return { fixture, api };
}

describe('ProjectDetailsComponent — Baseline vs Planned card (design spec, block E)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is ABSENT for employee — no fetch fires, no "Baseline vs Planned" text renders', async () => {
    const { fixture, api } = await render('employee');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
    expect(api.getAssignmentDays).not.toHaveBeenCalled();
    expect(api.getAssignmentMonths).not.toHaveBeenCalled();
    expect(api.getCostBaselines).not.toHaveBeenCalled();
  });

  it('is ABSENT for sales — the pair of the presence assertion below', async () => {
    const { fixture } = await render('sales');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
  });

  it('is PRESENT for pm and renders the hand-verified +120 EUR / +20.00% October row', async () => {
    const { fixture } = await render('pm');
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Baseline vs Planned');
    expect(text).toContain('2026-10');
    expect(text).toMatch(/\+?20\.00%/);
  });

  // COORDINATOR-CAUGHT DEFECT: the KPI summary totals (baselineTotals) must
  // aggregate the SAME population as the ratio's own denominator — periods
  // that actually carry a current baseline row — never every period in
  // baselineRows()'s union, which also includes out-of-horizon months
  // (booked hours, baseline 0) purely so the per-period table can flag them
  // "not frozen". The single-month fixture used by every other test in this
  // file never exercises this: with only one period total, "sum everything"
  // and "sum only frozen periods" coincide, which is exactly how this shipped
  // unnoticed through this file's own test suite.
  it('restricts baselineTotals to periods with a current baseline row, never summing a never-frozen month into the ratio', async () => {
    const rate100: Resource = { ...RESOURCE, costRate: 100, billRate: 200 };
    const days: AssignmentDay[] = [
      { id: 'A1:2026-01-05', assignmentId: 'A1', date: '2026-01-05', hours: 10 },
      { id: 'A1:2026-02-05', assignmentId: 'A1', date: '2026-02-05', hours: 5 },
    ];
    const months: AssignmentMonth[] = [
      { id: 'A1:2026-01', assignmentId: 'A1', month: '2026-01', status: 'Allocated' },
      { id: 'A1:2026-02', assignmentId: 'A1', month: '2026-02', status: 'Allocated' },
    ];
    // January has booked hours but NO baseline row at all (never frozen) ->
    // outOfBaselineHorizon: true, baseline 0, planned 1000 (10h x 100 EUR/h).
    // February HAS a frozen baseline (400) -> planned 500 (5h x 100), delta
    // 100, deltaPct 25.00%.
    const baseline: CostBaseline[] = [
      { id: 'CB_FEB', projectId: 'P1', period: '2026-02', amount: 400, frozenAt: '2026-01-15T00:00:00.000Z', frozenBy: 'u4' },
    ];
    const { fixture } = await render('pm', {
      getResources: () => of([rate100]),
      getAssignmentDays: () => of(days),
      getAssignmentMonths: () => of(months),
      getCostBaselines: () => of(baseline),
    });
    // Restricted (correct): only February counts, since only it has a
    // frozen row. baseline 400, planned 500, delta 100, deltaPct 25.00%.
    // UNRESTRICTED (the defect this pins): baseline 400 (still just Feb —
    // January contributes 0 either way), planned 1500 (Jan's 1000 + Feb's
    // 500), delta 1100, deltaPct 275% — the exact five-digit-percentage
    // shape (scaled down for a fast hand-check) from summing a never-frozen
    // month into a ratio against a denominator that never included it.
    const baselineTile = baselineKpi(fixture, 'Baseline');
    const plannedTile = baselineKpi(fixture, 'Planned');
    const deltaTile = baselineKpi(fixture, 'Delta');
    expect(baselineTile.value).toContain('400');
    expect(plannedTile.value).toContain('500');
    expect(plannedTile.value).not.toContain('1,500');
    expect(deltaTile.value).toContain('100');
    expect(deltaTile.value).not.toContain('1,100');
    expect(deltaTile.note).toContain('25.00%');
    expect(deltaTile.note).not.toContain('275');
  });

  it('renders "—" for a period whose baseline is 0 (never frozen), not a fabricated percentage', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => of([]) });
    expect(host(fixture).textContent).toContain('—');
  });

  it('shows "No baseline frozen for this project yet." only when the project genuinely has NEITHER a baseline NOR any booked hours — distinct from the "—" case above, which has booked hours and no baseline', async () => {
    const { fixture } = await render('pm', {
      getCostBaselines: () => of([]),
      getAssignmentDays: () => of([]),
      getAssignmentMonths: () => of([]),
    });
    expect(host(fixture).textContent).toContain('No baseline frozen for this project yet.');
  });

  it('does NOT show the empty-state message once a baseline exists — the pair of the test above', async () => {
    const { fixture } = await render('pm');
    expect(host(fixture).textContent).not.toContain('No baseline frozen for this project yet.');
  });

  it('shows a Couldn\'t-load / Retry panel when a dependency errors, never a number', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => throwError(() => new Error('boom')) });
    const text = host(fixture).textContent ?? '';
    expect(text).toContain("Couldn't load cost baseline");
    expect(text).not.toContain('20.00%');
  });

  it('shows a loading skeleton while a dependency is still pending', async () => {
    const pending = new Subject<CostBaseline[]>();
    const { fixture } = await render('pm', { getCostBaselines: () => pending.asObservable() });
    expect(fixture.nativeElement.querySelectorAll('.command-skeleton').length).toBeGreaterThan(0);
    pending.next(BASELINE);
    pending.complete();
    await tick(fixture);
  });

  it('shows the Freeze baseline button only for finance, never for pm', async () => {
    const { fixture: financeFixture } = await render('finance');
    expect(host(financeFixture).textContent).toContain('Freeze baseline');
    // TestBed refuses a second configureTestingModule() once a component has
    // been instantiated — reset explicitly before the second render() call
    // (afterEach only fires BETWEEN `it()` blocks, not inside one).
    TestBed.resetTestingModule();
    const { fixture: pmFixture } = await render('pm');
    expect(host(pmFixture).textContent).not.toContain('Freeze baseline');
  });
});

/**
 * The finance envelope this screen hands to `computeProjectFinancials`.
 *
 * `finance.util.ts` computes `effectiveBudgetForProject = budgetForProject +
 * approvedChangeBudgetForProject`, and the approved-CR term is `(d.changeRequests
 * ?? [])` — so an envelope MISSING the key silently scores every approved change
 * request as zero. project-details built a seven-key envelope without it while
 * already loading the data for its own "open changes" count, so this page's Budget,
 * Budget Burn and VAC disagreed with /reporting, whose envelope carries it.
 */
describe('ProjectDetailsComponent — approved change requests move the effective budget', () => {
  const FINANCIALS = [{ id: 'F1', projectId: 'P1', category: 'Labor', budget: 10_000, actual: 0 }];
  const cr = (status: string, impactBudget: number, id = 'CR1') => ({
    id, projectId: 'P1', title: 'Scope cut', description: '', requestedBy: 'u1', owner: 'u1',
    status, impactScope: 'reduced', impactBudget, impactScheduleDays: 0, priority: 'Medium',
    createdAt: '2026-03-01T00:00:00.000Z',
  });

  const budgetOf = (fixture: ComponentFixture<ProjectDetailsComponent>) =>
    (fixture.componentInstance as unknown as { financials: () => { budget: number } }).financials().budget;

  it('subtracts an APPROVED change request from the plan budget', async () => {
    // RED before the fix: 10000, because the envelope had no changeRequests key.
    const { fixture } = await render('finance', {
      getProjectFinancials: () => of(FINANCIALS),
      getChangeRequests: () => of([cr('Approved', -5000)]),
    });
    expect(budgetOf(fixture)).toBe(5000);
  });

  it('ignores a change request that has NOT been approved', async () => {
    // ASSERTION OF ABSENCE #1: this is what kills a fix that sums every CR
    // regardless of status — which would pass the test above and quietly move the
    // budget on a draft nobody has decided.
    for (const status of ['Draft', 'Submitted', 'Rejected']) {
      TestBed.resetTestingModule();
      const { fixture } = await render('finance', {
        getProjectFinancials: () => of(FINANCIALS),
        getChangeRequests: () => of([cr(status, -5000)]),
      });
      expect(budgetOf(fixture), `${status} must not move the budget`).toBe(10_000);
    }
  });

  it('ignores an approved change request belonging to ANOTHER project', async () => {
    // ASSERTION OF ABSENCE #2: the term is filtered by projectId, and a fix that
    // summed the whole table would pass both tests above.
    const { fixture } = await render('finance', {
      getProjectFinancials: () => of(FINANCIALS),
      getChangeRequests: () => of([{ ...cr('Approved', -5000), projectId: 'P-OTHER' }]),
    });
    expect(budgetOf(fixture)).toBe(10_000);
  });

  it('still shows no budget at all to a role that may not read financials', async () => {
    // ASSERTION OF ABSENCE #3: adding an envelope key must not un-gate a read.
    // `pm` has canApproveFinancials false, so financialsRes never loads and the
    // budget stays 0 whatever the change requests say.
    const { fixture, api } = await render('pm', {
      getProjectFinancials: () => of(FINANCIALS),
      getChangeRequests: () => of([cr('Approved', -5000)]),
    });
    expect(budgetOf(fixture)).toBe(0);
    expect(api.getProjectFinancials).not.toHaveBeenCalled();
  });
});
