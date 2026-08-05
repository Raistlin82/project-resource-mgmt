import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { Billing } from './billing';
import {
  ApiService, BillingPlanItem, Contract, Customer, FxRate, NegotiatedRate, Project, Resource, TimeEntry,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

/**
 * FINAL REVIEW, finding 3 — the T&M Accrued KPI must price at the NEGOTIATED
 * sell rate, like the four surfaces already wired to `sellRateFor`.
 *
 * This file is a new harness: billing.ts had no spec, so the tile could disagree
 * with the dashboard, reporting and contract-details about the identical hours
 * and nothing would notice. It is deliberately narrow — one KPI tile, asserted on
 * the RENDERED DOM — rather than an attempt to cover a ~1500-line screen.
 *
 * UNITS ARE PART OF THE FIXTURE: a NegotiatedRate.billRate is EUR per DAY, a
 * Resource.billRate as /api/resources serves it is EUR per HOUR. 800 €/day over
 * an 8h day is 100 €/h, against a reference of 200 €/h.
 */
function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** The T&M Accrued tile itself, so no other KPI can satisfy the assertion. */
function tmAccruedTile(fixture: ComponentFixture<Billing>): HTMLElement {
  const tile = [...host(fixture).querySelectorAll('article')]
    .find(a => a.textContent?.includes('T&M Accrued'));
  expect(tile, 'the T&M Accrued KPI tile must be rendered').toBeTruthy();
  return tile as HTMLElement;
}

async function tick(fixture: ComponentFixture<Billing>, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

describe('Billing — T&M Accrued prices at the negotiated sell rate (final review, finding 3)', () => {
  const contract: Contract = {
    id: 'CT2', customerId: 'C1', name: 'T&M Framework', type: 'T&M', totalValue: 0,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const customer: Customer = { id: 'C1', name: 'Acme Co' };
  const project: Project = {
    id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'Active', contractId: 'CT2',
  };
  /** 200 EUR per HOUR (the equivalent of a 1600 €/day override). */
  const resource: Resource = {
    id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 80, capacity: 40, billRate: 200,
  };
  /** 800 EUR per DAY -> 100 EUR per hour at the 8h working day below. */
  const rate: NegotiatedRate = { id: 'NR1', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 800 };
  const entry: TimeEntry = {
    id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: 'R1',
    projectId: 'P2', date: '2026-05-01', hours: 10, status: 'Approved',
  };
  /** 'Planned', so the project is NOT treated as already billed and the hours accrue. */
  const item: BillingPlanItem = {
    id: 'BP1', contractId: 'CT2', projectId: 'P2', type: 'TimeAndMaterials',
    label: 'T&M', amount: 0, currency: 'EUR', status: 'Planned',
  };

  function baseStub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getBillingPlanItems: () => of([item]),
      getContracts: () => of([contract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([project]),
      getMilestones: () => of([]),
      getOrders: () => of([]),
      getTimeEntries: () => of([entry]),
      getResources: () => of([resource]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => of([rate]),
      getHoursPerDay: () => of({ value: 8 }),
      ...overrides,
    } as unknown as ApiService;
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<Billing>> {
    const authStub = {
      authReady: signal(true),
      canManageCommercial: signal(true),
      canApproveFinancials: signal(true),
      role: signal('finance'),
      userId: signal('1'),
    } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [Billing],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<Billing> = TestBed.createComponent(Billing);
    await tick(fixture);
    return fixture;
  }

  it('accrues 10 approved hours at the negotiated 100/h, not the reference 200/h', async () => {
    const fixture = await setUp(baseStub());
    const text = tmAccruedTile(fixture).textContent ?? '';

    // 10h x 100 €/h = 1,000. The reference rate would render 2,000, and the
    // un-converted day rate (the C1 unit bug) 8,000.
    expect(text).toContain('€1,000');
    expect(text).not.toContain('€2,000');
    expect(text).not.toContain('€8,000');
  });

  it('falls back to the reference rate when nothing is negotiated — the no-regression case', async () => {
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([]) }));
    const text = tmAccruedTile(fixture).textContent ?? '';

    // Exactly what this tile showed before the feature existed: 10h x 200 €/h.
    expect(text).toContain('€2,000');
  });

  it('does not apply a negotiated rate to hours dated outside the contract period', async () => {
    const outside: TimeEntry = { ...entry, date: '2027-06-01' }; // CT2 ends 2026-12-31
    const fixture = await setUp(baseStub({ getTimeEntries: () => of([outside]) }));
    const text = tmAccruedTile(fixture).textContent ?? '';

    expect(text).toContain('€2,000');
  });
});

/**
 * The rest of this file comes from `codex/ui-defect-remediation`. It exercises a
 * different concern — the KPI strip's loading/error envelope (P1-02/P1-10), the
 * per-project invoice cutoff (P1-13) and the conditional billing validators
 * (P1-29) — over a deliberately SPARSE stub, so it keeps its own setup helper
 * rather than reusing the negotiated-rate fixture above.
 *
 * UNITS: `getHoursPerDay` is part of the stub because the merged component needs
 * the EUR/day -> EUR/hour divisor. The branch's own fixture predated that and
 * used `billRate: 100` as if a negotiated rate were hourly; under the correct
 * semantics the same 1,000 expectation needs an 800 €/day rate over an 8h day.
 */
async function setupSparse(overrides: Partial<Record<keyof ApiService, unknown>> = {}): Promise<ComponentFixture<Billing>> {
  const empty = () => of([]);
  const api = {
    getBillingPlanItems: empty,
    getContracts: empty,
    getCustomers: empty,
    getProjects: empty,
    getMilestones: empty,
    getOrders: empty,
    getTimeEntries: empty,
    getResources: empty,
    getFxRates: () => of<FxRate[]>([{ currency: 'EUR', rateToBase: 1 }]),
    getNegotiatedRates: empty,
    getHoursPerDay: () => of({ value: 8 }),
    ...overrides,
  } as unknown as ApiService;
  TestBed.configureTestingModule({
    imports: [Billing],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { authReady: signal(true) } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  return TestBed.createComponent(Billing);
}

describe('Billing financial KPI completeness', () => {
  it('does not render financial KPI values while one required dependency is pending', async () => {
    const fxRates = new Subject<FxRate[]>();
    const fixture = await setupSparse({ getFxRates: () => fxRates as Observable<FxRate[]> });

    await tick(fixture);

    expect(host(fixture).querySelector('section[aria-label="Billing metrics"]')).toBeNull();
    expect(host(fixture).textContent).toContain('Loading billing financial data');
    fxRates.next([{ currency: 'EUR', rateToBase: 1 }]);
    fxRates.complete();
  });

  it('shows an error state instead of zero-valued KPI tiles when a dependency fails', async () => {
    const fixture = await setupSparse({ getFxRates: () => throwError(() => new Error('FX unavailable')) });

    await tick(fixture);

    expect(host(fixture).querySelector('section[aria-label="Billing metrics"]')).toBeNull();
    expect(host(fixture).querySelector('[role="alert"]')?.textContent).toContain('billing financial data');
  });
});

describe('Billing T&M accrued correctness', () => {
  it('uses the negotiated sell rate and excludes only entries through the latest invoice cutoff', async () => {
    const contract: Contract = {
      id: 'CT1', customerId: 'C1', name: 'Framework', type: 'T&M', totalValue: 0,
      currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
    };
    const project: Project = {
      id: 'P1', name: 'Delivery', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
    };
    const resource: Resource = {
      id: 'R1', name: 'Developer', role: 'Developer', skills: [], projectRoles: [],
      externalExperience: [], utilization: 80, capacity: 40, billRate: 200,
    };
    const entries: TimeEntry[] = [
      { id: 'TE-OLD', assignmentId: 'A1', requestId: 'Q1', resourceId: 'R1', projectId: 'P1', date: '2026-02-10', hours: 10, status: 'Approved' },
      { id: 'TE-NEW', assignmentId: 'A1', requestId: 'Q1', resourceId: 'R1', projectId: 'P1', date: '2026-03-10', hours: 10, status: 'Approved' },
    ];
    const invoiced: BillingPlanItem = {
      id: 'BP1', contractId: 'CT1', projectId: 'P1', type: 'TimeAndMaterials',
      label: 'February T&M', amount: 1_000, currency: 'EUR', status: 'Invoiced',
      issuedDate: '2026-02-28T23:59:59.000Z',
    };
    /** 800 EUR per DAY -> 100 EUR per hour at the stub's 8h working day. */
    const rate: NegotiatedRate = {
      id: 'NR1', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 800,
    };
    const fixture = await setupSparse({
      getBillingPlanItems: () => of([invoiced]),
      getContracts: () => of([contract]),
      getProjects: () => of([project]),
      getResources: () => of([resource]),
      getTimeEntries: () => of(entries),
      getNegotiatedRates: () => of([rate]),
    });

    await fixture.whenStable();
    fixture.detectChanges();

    // February is covered by the invoice cutoff. March remains unbilled and is
    // priced at the negotiated 100 EUR/hour, not the 200 reference rate:
    // 10h x 100 = 1,000. The un-converted day rate would give 8,000.
    expect(fixture.componentInstance.kpis().tmAccrued).toBe(1_000);
  });
});

describe('Billing conditional form validation', () => {
  it('blocks missing type fields, out-of-range percentages, and fractional payment terms', async () => {
    const fixture = await setupSparse();
    await fixture.whenStable();
    const form = fixture.componentInstance.form;
    form.patchValue({
      type: 'Capped', contractId: 'CT1', label: 'Capped delivery', amount: 100,
      currency: 'EUR', capAmount: null, taxRatePct: 22, retentionPct: 0,
      paymentTermsDays: 30,
    });
    expect(form.invalid).toBe(true);

    form.controls.capAmount.setValue(150);
    expect(form.valid).toBe(true);

    form.controls.taxRatePct.setValue(101);
    expect(form.invalid).toBe(true);
    form.controls.taxRatePct.setValue(22);
    form.controls.paymentTermsDays.setValue(1.5);
    expect(form.invalid).toBe(true);
  });
});

/**
 * B12 / P2-21 — days-overdue counts against the user's civil date.
 *
 * The fixture is one Invoiced item due 2026-08-03 and two instants 4 hours apart,
 * one on each side of UTC midnight, under two timezones. The chip is read through
 * its own aria-label with a WHOLE-STRING comparison: the rendered text is
 * "Overdue 1d", and `toContain('Overdue')` cannot tell 1 from 0-and-absent.
 *
 * Neither half of the setup is optional. Under TZ=UTC the local and UTC dates
 * always agree, so both cases pass against the pre-fix `new Date().toISOString()`
 * — the vacuous green this file's own header warns about elsewhere. The clock
 * fakes Date only, leaving the microtask queue `tick()` drains untouched.
 */
describe('Billing overdue baseline is the local civil date (P2-21)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    vi.useRealTimers();
    process.env['TZ'] = originalTz;
    TestBed.resetTestingModule();
  });

  const dueOnThird: BillingPlanItem = {
    id: 'BP-OD', contractId: 'CT1', projectId: 'P1', type: 'Milestone',
    label: 'Phase 1', amount: 5_000, currency: 'EUR', status: 'Invoiced',
    dueDate: '2026-08-03',
  };

  function pin(tz: string, instant: string): void {
    process.env['TZ'] = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
  }

  /** The one plan row, so no other chip on the page can satisfy the assertion. */
  function planRow(fixture: ComponentFixture<Billing>): HTMLElement {
    const row = host(fixture).querySelector('tbody tr');
    expect(row, 'the billing plan row must be rendered').toBeTruthy();
    return row as HTMLElement;
  }

  it('counts the day the user has already entered (positive offset)', async () => {
    pin('Europe/Rome', '2026-08-03T22:30:00.000Z'); // 00:30 on 4 August in Rome
    const fixture = await setupSparse({ getBillingPlanItems: () => of([dueOnThird]) });
    await tick(fixture);

    // Pre-fix, `today` was 2026-08-03T22:30Z: floor(0.94 days) = 0, so an invoice
    // a day past due showed no chip at all.
    const chip = planRow(fixture).querySelector('[aria-label^="Overdue by"]');
    expect(chip?.getAttribute('aria-label')).toBe('Overdue by 1 days');
  });

  it('does not count a day the user has not reached (negative offset)', async () => {
    pin('America/New_York', '2026-08-04T02:30:00.000Z'); // 22:30 on 3 August in New York
    const fixture = await setupSparse({ getBillingPlanItems: () => of([dueOnThird]) });
    await tick(fixture);

    // The mirror error: pre-fix `today` was already 2026-08-04T02:30Z, so the
    // page claimed a day overdue while it was still the due date for the user.
    expect(planRow(fixture).querySelector('[aria-label^="Overdue by"]')).toBeNull();
  });
});
