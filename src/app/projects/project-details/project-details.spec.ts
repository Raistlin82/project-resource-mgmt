import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ProjectDetailsComponent } from './project-details';
import { ApiService, AssignmentDay, AssignmentMonth, CostBaseline, FinancialItem, FxRate, Issue, Order, OrderLine, Project, Resource, ResourceRequest, Assignment, TimeEntry } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { capabilitiesForRole } from '../../services/access-policy.util';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * Reads a KPI tile by its EXACT label text, or null when that tile is not on
 * screen at all.
 *
 * Exact-label matching (never a substring, never a page-wide text match) is
 * load-bearing twice over on this page. Every tile label here is unique, so an
 * assertion is anchored to the one tile it names — 'EAC' cannot be satisfied by
 * 'EAC Basis', and 'Budget' cannot be satisfied by 'Budget Burn'. And the money
 * figures are rendered through CurrencyPipe with 'symbol', which emits '€',
 * NEVER the string 'EUR' — so `textContent.includes('EUR 0')` is a check that
 * can never fail regardless of the code under it. Read the tile; assert its
 * value.
 *
 * Returning null rather than asserting lets the same helper carry both halves
 * of a presence/absence pair.
 */
function findKpi(fixture: { nativeElement: unknown }, label: string): { value: string; note: string } | null {
  const labels = Array.from(host(fixture).querySelectorAll('.command-kpi-label'));
  const labelEl = labels.find(el => el.textContent?.trim() === label);
  if (!labelEl) return null;
  const tile = labelEl.closest('.command-kpi');
  if (!tile) return null;
  return {
    value: tile.querySelector('.command-kpi-value')?.textContent?.trim() ?? '',
    note: tile.querySelector('.command-kpi-note')?.textContent?.trim() ?? '',
  };
}

/** findKpi, asserting the tile is present. `baselineTotals` and the money
 *  computeds are `protected` (template-only, this codebase's convention for
 *  signals no other class should reach into), so the rendered DOM is the only
 *  way to observe them without weakening that visibility. */
function kpi(fixture: { nativeElement: unknown }, label: string): { value: string; note: string } {
  const tile = findKpi(fixture, label);
  expect(tile, `the "${label}" KPI tile must exist`).not.toBeNull();
  return tile!;
}

/** The header status pill that mirrors the Delivery Health tile, or null. */
function healthChip(fixture: { nativeElement: unknown }): string | null {
  return host(fixture).querySelector('[data-test="health-chip"]')?.textContent?.trim() ?? null;
}

/** The money grid's own loading region — NOT any `.command-skeleton` on the
 *  page. With authReady false the Baseline card is ALSO skeletonised (it always
 *  was), so "a skeleton is present" is green before and after any fix here; the
 *  query has to name the money grid or it proves nothing. */
function moneySkeleton(fixture: { nativeElement: unknown }): Element | null {
  return host(fixture).querySelector('[aria-label="Loading project financials"]');
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
/** Base-currency-only table: the honest default, and an identity on EUR amounts. */
const EUR_ONLY_FX: FxRate[] = [{ currency: 'EUR', rateToBase: 1 }];

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
    getFxRates: () => of(EUR_ONLY_FX),
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

type StubRole = 'employee' | 'sales' | 'pm' | 'finance' | 'delivery-executive';

/**
 * Derived from the SHIPPING capability table, never from hand-written booleans.
 *
 * Every withheld/visible branch on this screen keys off canManageCommercial and
 * canApproveFinancials, and this stub used to pin canManageCommercial to false
 * for EVERY role — including `finance`, which really holds it
 * (access-policy.util.ts). A fixture that lies about a role's identity never
 * enters the branch under test, so every assertion about that branch is
 * vacuous. capabilitiesForRole() makes that class of lie impossible here.
 */
function makeAuthStub(role: StubRole, authReady = true) {
  const caps = capabilitiesForRole(role);
  return {
    authReady: () => authReady,
    canReadStaffing: () => caps.canReadStaffing,
    // AuthService.canApproveFinancials IS canReadFinancials (auth.service.ts:134).
    canApproveFinancials: () => caps.canReadFinancials,
    canManageCommercial: () => caps.canManageCommercial,
  } as unknown as AuthService;
}

/** Configures the TestBed and creates the component WITHOUT rendering it, so a
 *  test can assert on whether the first change-detection pass throws. */
function createFixture(role: StubRole, apiOverrides: Partial<Record<string, unknown>> = {}, authReady = true) {
  const api = makeApiStub(apiOverrides);
  TestBed.configureTestingModule({
    imports: [ProjectDetailsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role, authReady) },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectDetailsComponent);
  fixture.componentRef.setInput('id', 'P1');
  return { fixture, api };
}

async function render(role: StubRole, apiOverrides: Partial<Record<string, unknown>> = {}, authReady = true) {
  const { fixture, api } = createFixture(role, apiOverrides, authReady);
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
    const baselineTile = kpi(fixture, 'Baseline');
    const plannedTile = kpi(fixture, 'Planned');
    const deltaTile = kpi(fixture, 'Delta');
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

// ---------------------------------------------------------------------------
// The Overview money grid: withheld is not zero, unready is not zero, and a
// failed read is not a blank route.
// ---------------------------------------------------------------------------

/**
 * A project that GENUINELY HAS the money. Every assertion of absence below is
 * anchored to this fixture — an empty-portfolio fixture would satisfy "no
 * 100,000 on screen" while proving nothing at all, which is this project's
 * recorded "fixture that lies" failure.
 *
 * Hand-computed, for a role that can read all of it:
 *   plannedLaborCost 800h x 100 = 80,000   actualLaborCost 600h x 100 = 60,000
 *   revenue 100,000 (EUR customer order, status Confirmed so invoiced 0)
 *   externalCost 0   actualCost 60,000     budget 80,000 (no change requests)
 *   margin 40,000    etc 20,000            eac 80,000    VAC 0    burn 75%
 *   => Delivery Health green, "On Track".
 * For a role WITHOUT the two capabilities the same fixture used to render
 * revenue 0, budget 0, margin -60,000, VAC -80,000 and "Critical".
 */
const RATE_100: Resource = { ...RESOURCE, costRate: 100, billRate: 200 };
const ASSIGNMENT_800H: Assignment = { ...ASSIGNMENT, assignedHours: 800 };
const APPROVED_600H: TimeEntry[] = [{
  id: 'TE1', assignmentId: 'A1', requestId: 'REQ1', resourceId: 'R1', projectId: 'P1',
  date: '2026-03-02', hours: 600, status: 'Approved',
}];
const customerOrder = (currency: string, id = 'O1'): Order[] => [{
  id, contractId: 'CT1', type: 'Customer', amount: 100_000, currency,
  status: 'Confirmed', orderDate: '2026-01-05',
}];
const orderLine = (amount: number, orderId = 'O1'): OrderLine[] => [{
  id: 'OL1', orderId, projectId: 'P1', description: 'Phase 1', amount,
}];
const plan = (budget: number): FinancialItem[] => [{ id: 'F1', projectId: 'P1', category: 'Labor', budget, actual: 0 }];

/** The full envelope for the project described above. */
function moneyProject(over: Partial<Record<string, unknown>> = {}) {
  return {
    getResources: () => of([RATE_100]),
    getAssignments: () => of([ASSIGNMENT_800H]),
    getTimeEntries: () => of(APPROVED_600H),
    getOrders: () => of(customerOrder('EUR')),
    getOrderLines: () => of(orderLine(100_000)),
    getProjectFinancials: () => of(plan(80_000)),
    ...over,
  };
}

const WITHHELD = '—';
const WITHHELD_NOTE = 'needs commercial + financial access';

describe('ProjectDetailsComponent — a withheld commercial/financial read is NOT a zero', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows pm a withheld marker and an access notice instead of EUR 0 revenue, EUR 0 budget and a fabricated negative margin', async () => {
    const { fixture, api } = await render('pm', moneyProject());

    // The reads really are withheld — not merely absent from the fixture.
    expect(api.getOrders).not.toHaveBeenCalled();
    expect(api.getOrderLines).not.toHaveBeenCalled();
    expect(api.getProjectFinancials).not.toHaveBeenCalled();

    // RED before the fix: '€0' / '€0' / '-€60,000' / '-€80,000' / '0%'.
    // Read by exact tile label, never by page-wide substring: CurrencyPipe with
    // 'symbol' emits '€', so a toContain('EUR 0') check could never fail.
    for (const label of ['Contract Revenue', 'Backlog', 'Actual Cost', 'Margin', 'Budget', 'Budget Burn', 'EAC', 'EAC Basis', 'VAC']) {
      const tile = kpi(fixture, label);
      expect(tile.value, `${label} must be withheld, not a figure`).toBe(WITHHELD);
      expect(tile.value, `${label} must not be a zero amount`).not.toMatch(/\d/);
    }
    expect(kpi(fixture, 'Contract Revenue').note).toBe(WITHHELD_NOTE);
    expect(kpi(fixture, 'Budget').note).toBe(WITHHELD_NOTE);
    // The labour term IS readable, so it is surfaced rather than discarded with
    // the total it can no longer complete.
    expect(kpi(fixture, 'Actual Cost').note).toContain('60,000');

    // The notice, and the reason the tiles are dashed.
    expect(host(fixture).querySelector('[data-test="finance-withheld-notice"]')).not.toBeNull();
    expect(host(fixture).textContent).toMatch(/does not have access/);

    // The verdict, in BOTH places it is rendered. RED before the fix: 'Critical',
    // from a varianceAtCompletion computed out of two reads this role never made.
    expect(kpi(fixture, 'Delivery Health').value).toBe('On Track');
    expect(healthChip(fixture)).toBe('On Track');
    expect(kpi(fixture, 'Delivery Health').note).toContain('Based on issues and change control');

    // The most actively misleading string on the page: instructions to add an
    // order that already exists, printed to the one role that cannot see it.
    expect(host(fixture).textContent).not.toContain('No customer revenue recorded');
    expect(host(fixture).textContent).not.toContain('Revenue breakdown');
  });

  it('MIRROR — delivery-executive, SAME fixture: the real figures, no notice, nothing dashed', async () => {
    // This is where the assertion of ABSENCE lives. An always-on notice, or a
    // gate that simply refuses everyone, passes the test above and fails here.
    const { fixture } = await render('delivery-executive', moneyProject());

    expect(host(fixture).querySelector('[data-test="finance-withheld-notice"]')).toBeNull();
    expect(host(fixture).textContent).not.toMatch(/does not have access/);
    expect(host(fixture).textContent).not.toContain(WITHHELD_NOTE);

    expect(kpi(fixture, 'Contract Revenue').value).toContain('100,000');
    expect(kpi(fixture, 'Actual Cost').value).toContain('60,000');
    expect(kpi(fixture, 'Margin').value).toContain('40,000');
    expect(kpi(fixture, 'Backlog').value).toContain('100,000');
    expect(kpi(fixture, 'Budget').value).toContain('80,000');
    expect(kpi(fixture, 'Budget Burn').value).toBe('75%');
    expect(kpi(fixture, 'EAC').value).toContain('80,000');
    expect(kpi(fixture, 'ETC').value).toContain('20,000');
    expect(kpi(fixture, 'VAC').value).toContain('0');
    expect(kpi(fixture, 'Delivery Health').value).toBe('On Track');
    expect(kpi(fixture, 'Delivery Health').note).toBe('Based on VAC, burn, risks and change control');
    expect(healthChip(fixture)).toBe('On Track');
    expect(host(fixture).textContent).toContain('Revenue breakdown');
  });

  it('ETC stays a real figure for pm — it is derived only from reads that role HAS', async () => {
    // The twin of the dash assertions above: withholding a figure that is
    // actually correct is the mirror-image defect of printing one that is not.
    // etc = max(0, plannedLaborCost - actualLaborCost) = 80,000 - 60,000, all of
    // it from requests/assignments/resources/time-entries.
    const { fixture } = await render('pm', moneyProject());
    expect(kpi(fixture, 'ETC').value).toContain('20,000');
    expect(kpi(fixture, 'ETC').value).not.toBe(WITHHELD);
  });

  it('the health verdict must still be able to go red for pm — dropping the variance term did not neuter it', async () => {
    // A guard that always refuses passes every positive test. openIssues is a
    // term pm genuinely reads, so it must still drive the verdict.
    const issue: Issue[] = [{
      id: 'IS1', projectId: 'P1', title: 'Prod outage', type: 'Risk',
      severity: 'Critical', status: 'Open', reportedBy: 'u1',
    }];
    const { fixture } = await render('pm', moneyProject({ getProjectIssues: () => of(issue) }));
    expect(kpi(fixture, 'Delivery Health').value).toBe('Critical');
    expect(healthChip(fixture)).toBe('Critical');
    expect(kpi(fixture, 'Open Critical Issues').value).toBe('1');
  });

  it('the variance term still turns delivery-executive red on a genuine overrun', async () => {
    // The other half of the same pair: the term was dropped only where the
    // figures are withheld, never where they are real. budget 10,000 vs
    // eac 80,000 => VAC -70,000.
    const { fixture } = await render('delivery-executive', moneyProject({ getProjectFinancials: () => of(plan(10_000)) }));
    expect(kpi(fixture, 'VAC').value).toContain('70,000');
    expect(kpi(fixture, 'Delivery Health').value).toBe('Critical');
    expect(healthChip(fixture)).toBe('Critical');
  });

  it('sales, which holds the commercial half but NOT the financial one, sees revenue and a withheld budget', async () => {
    // The asymmetric role is real (access-policy.util.ts: sales has
    // canManageCommercial true, canReadFinancials false). It proves the two
    // flags are independent rather than one collapsed boolean.
    const { fixture } = await render('sales', moneyProject());
    expect(kpi(fixture, 'Contract Revenue').value).toContain('100,000');
    expect(kpi(fixture, 'Backlog').value).toContain('100,000');
    expect(kpi(fixture, 'Budget').value).toBe(WITHHELD);
    expect(kpi(fixture, 'Margin').value).toBe(WITHHELD);
    expect(host(fixture).textContent).toMatch(/does not have access to this project's\s+financial records/);
  });
});

describe('ProjectDetailsComponent — the money grid sits behind a readiness gate', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pre-authReady it renders a skeleton, never EUR 0 tiles and never a confident "On Track"', async () => {
    const { fixture, api } = await render('delivery-executive', moneyProject(), /* authReady */ false);

    // Scoped to the MONEY grid. The Baseline card is skeletonised in this state
    // too (it always was), so a bare `.command-skeleton` count is green before
    // and after the fix and proves nothing.
    const region = moneySkeleton(fixture);
    expect(region, 'the money grid must have its own loading region').not.toBeNull();
    expect(region!.getAttribute('role')).toBe('status');
    expect(region!.getAttribute('aria-live')).toBe('polite');
    expect(region!.getAttribute('aria-busy')).toBe('true');
    expect(region!.querySelector('.sr-only')?.textContent).toContain('Loading project financials');
    expect(region!.querySelectorAll('.command-skeleton').length).toBeGreaterThan(0);

    // Where the red sits: before the fix this shipped a full strip of zero
    // tiles plus a verdict, in the SSR HTML and through the whole pre-hydration
    // window, and every number then jumped.
    expect(findKpi(fixture, 'Budget'), 'no Budget tile may render before authReady').toBeNull();
    expect(findKpi(fixture, 'Contract Revenue')).toBeNull();
    expect(findKpi(fixture, 'Delivery Health')).toBeNull();
    expect(host(fixture).textContent).not.toContain('On Track');
    // NOT asserted here: that the header chip is absent. It would be — the whole
    // header sits inside `@if (project(); as p)` and projectsRes is itself
    // pre-readiness — so the assertion would pass with the pill's own gate torn
    // out, i.e. it would be vacuous. The chip's real red lives in the errored
    // case below, where project() HAS resolved and the pill must read
    // "Health unavailable" instead of throwing.

    // And the gate is not "fetch anyway, hide the result".
    expect(api.getOrders).not.toHaveBeenCalled();
    expect(api.getProjectFinancials).not.toHaveBeenCalled();
  });

  it('MIRROR — once authReady and resolved, the skeleton is gone and the tiles carry the real figures', async () => {
    // The absence half: a fix that pins the skeleton on forever passes the case
    // above and fails this one.
    const { fixture } = await render('delivery-executive', moneyProject());
    expect(moneySkeleton(fixture)).toBeNull();
    expect(kpi(fixture, 'Budget').value).toContain('80,000');
    expect(healthChip(fixture)).toBe('On Track');
  });

  it('a failed /time-entries renders a Retry panel instead of throwing out of the first tile and blanking the route', async () => {
    const { fixture, api } = createFixture('delivery-executive', moneyProject({
      getTimeEntries: () => throwError(() => new Error('boom')),
    }));

    // The assertion is on the ABSENCE of a thrown error, not on the presence of
    // a class name. Before the fix financials() dereferenced an errored resource
    // inside the header pill and again inside the first tile, so the render
    // aborted and the whole route came up blank.
    let thrown: unknown = null;
    try {
      await tick(fixture);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'rendering the Overview must not throw when a finance read fails').toBeNull();

    const text = host(fixture).textContent ?? '';
    expect(text).toContain("Couldn't load project financials");
    const panelButtons = Array.from(host(fixture).querySelectorAll('[role="alert"] button'));
    expect(panelButtons).toHaveLength(1);
    expect(panelButtons[0].textContent).toContain('Retry');

    // No figure, and no verdict dressed up as one.
    expect(findKpi(fixture, 'Budget')).toBeNull();
    expect(findKpi(fixture, 'Delivery Health')).toBeNull();
    expect(healthChip(fixture)).toBe('Health unavailable');
    expect(text).not.toContain('On Track');

    // Retry actually re-fires the read that failed.
    expect(api.getTimeEntries).toHaveBeenCalledTimes(1);
    (panelButtons[0] as HTMLButtonElement).click();
    await tick(fixture);
    expect(api.getTimeEntries).toHaveBeenCalledTimes(2);
  });

  it('the Baseline card survives a failed finance read — it is deliberately outside the money grid gate', async () => {
    // The absence half of the case above: the readiness gate must suppress the
    // money grid, not the neighbouring card that has its own state machine and
    // does not read time entries at all.
    const { fixture } = await render('delivery-executive', moneyProject({
      getTimeEntries: () => throwError(() => new Error('boom')),
    }));
    expect(host(fixture).textContent).toContain('Baseline vs Planned');
    expect(host(fixture).textContent).not.toContain("Couldn't load cost baseline");
  });
});

describe('ProjectDetailsComponent — order lines are converted to the base currency before being summed', () => {
  afterEach(() => TestBed.resetTestingModule());

  const USD_FX: FxRate[] = [{ currency: 'EUR', rateToBase: 1 }, { currency: 'USD', rateToBase: 0.92 }];

  it('a USD 120,000 order line reads EUR 110,400, not EUR 120,000', async () => {
    const { fixture } = await render('delivery-executive', moneyProject({
      getOrders: () => of(customerOrder('USD', 'O3')),
      getOrderLines: () => of(orderLine(120_000, 'O3')),
      getFxRates: () => of(USD_FX),
    }));

    // PRECONDITION, asserted explicitly: both gated resources really loaded.
    // Without this the whole test passes on zeros — green before and after —
    // which is this project's recurring blind-gate failure.
    const revenue = kpi(fixture, 'Contract Revenue');
    expect(revenue.value).not.toBe(WITHHELD);
    expect(kpi(fixture, 'Budget').value).toContain('80,000');

    // 120,000 x 0.92. RED before the fix: '€120,000', a USD amount printed
    // under a hardcoded EUR symbol and then subtracted from EUR-denominated
    // cost to make a margin with no unit.
    expect(revenue.value).toContain('110,400');
    expect(revenue.value).not.toContain('120,000');
    expect(kpi(fixture, 'Backlog').value).toContain('110,400');
    // margin = 110,400 - 60,000
    expect(kpi(fixture, 'Margin').value).toContain('50,400');
  });

  it('ABSENCE — an EUR order of the same size is byte-identical before and after, so no blanket rescaling can pass', async () => {
    const { fixture } = await render('delivery-executive', moneyProject({
      getOrders: () => of(customerOrder('EUR')),
      getOrderLines: () => of(orderLine(120_000)),
      getFxRates: () => of(USD_FX),
    }));
    expect(kpi(fixture, 'Contract Revenue').value).toContain('120,000');
    expect(kpi(fixture, 'Contract Revenue').value).not.toContain('110,400');
  });

  it('a failed /fx-rates suppresses the money strip instead of silently summing unconverted amounts', async () => {
    const { fixture } = await render('delivery-executive', moneyProject({
      getOrders: () => of(customerOrder('USD', 'O3')),
      getOrderLines: () => of(orderLine(120_000, 'O3')),
      getFxRates: () => throwError(() => new Error('boom')),
    }));
    expect(host(fixture).textContent).toContain("Couldn't load project financials");
    expect(findKpi(fixture, 'Contract Revenue')).toBeNull();
    expect(host(fixture).textContent).not.toContain('120,000');
  });
});
