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
 * The customer-facing amount on /billing.
 *
 * `customerFacingBillingAmount()` marks an 'Expense' condition up by `markupPct`
 * — re-billing a cost with a margin is the entire economic purpose of that type —
 * and it is the figure the SERVER books the Order and OrderLine at, and the figure
 * `finance.util.ts` uses everywhere through `billableAmount()`. billing.ts was the
 * one screen in the codebase reading `item.amount` raw, so the printable invoice,
 * the row totals, the KPI strip and the CSV all under-billed the markup, and the
 * printed "Total due" contradicted the order the same transaction had just created.
 */
describe('Billing prices an Expense condition at the customer-facing amount', () => {
  const CT: Contract = {
    id: 'CT2', customerId: 'C1', name: 'Expense Framework', type: 'T&M', totalValue: 0,
    currency: 'USD', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const CUST: Customer = { id: 'C1', name: 'Acme Co' };
  const PRJ: Project = {
    id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'Active', contractId: 'CT2',
  };
  // The seeded shape (src/db/seed.ts BP7): 3200 USD + 5% markup = 3360 customer-facing.
  const EXPENSE = {
    id: 'BP7', contractId: 'CT2', projectId: 'P2', type: 'Expense', label: 'Re-billed travel',
    amount: 3200, markupPct: 5, taxRatePct: 22, retentionPct: 0, currency: 'USD',
    status: 'Invoiced', orderId: 'ORD-BP7',
  } as unknown as BillingPlanItem;
  // The CONTROL: same money, same tax, NOT an Expense — must be untouched by the fix.
  const MILESTONE = {
    id: 'BP8', contractId: 'CT2', projectId: 'P2', type: 'Milestone', label: 'Acceptance',
    amount: 3200, taxRatePct: 22, retentionPct: 0, currency: 'USD', status: 'Invoiced',
  } as unknown as BillingPlanItem;

  async function setupRows(items: BillingPlanItem[]): Promise<ComponentFixture<Billing>> {
    const fixture = await setupSparse({
      getBillingPlanItems: () => of(items),
      getContracts: () => of([CT]),
      getCustomers: () => of([CUST]),
      getProjects: () => of([PRJ]),
      getOrders: () => of([{ id: 'ORD-BP7', contractId: 'CT2', type: 'Customer', amount: 3360, currency: 'USD', status: 'Invoiced', orderDate: '2026-05-10', invoiceNumber: 'INV-2026-0007', invoiceDate: '2026-05-10' }]),
      getFxRates: () => of<FxRate[]>([{ currency: 'EUR', rateToBase: 1 }, { currency: 'USD', rateToBase: 1 }]),
    });
    await tick(fixture);
    return fixture;
  }

  const rowFor = (fixture: ComponentFixture<Billing>, id: string) =>
    (fixture.componentInstance as unknown as { rows: () => { item: { id: string }; customerAmount: number; tax: number; retention: number; netPayable: number }[] })
      .rows().find(r => r.item.id === id)!;

  it('computes tax and net payable on the MARKED-UP amount', async () => {
    // RED before the fix: customerAmount did not exist, tax was 704 (22% of 3200)
    // and netPayable was 3904. The customer was invoiced 195.20 too little — exactly
    // the 160.00 markup plus its tax.
    const fixture = await setupRows([EXPENSE]);
    const row = rowFor(fixture, 'BP7');
    expect(row.customerAmount).toBe(3360);
    expect(row.tax).toBeCloseTo(739.2, 10);
    expect(row.netPayable).toBeCloseTo(4099.2, 10);
  });

  it('keeps a NON-Expense condition on exactly the same figures as before', async () => {
    // ASSERTION OF ABSENCE #1. This is what kills an unconditional `* 1.05` in the
    // fix, and what catches a fixture that silently lost its `type: 'Expense'` — the
    // wrong-identity-fixture failure this project has already paid for.
    const fixture = await setupRows([MILESTONE]);
    const row = rowFor(fixture, 'BP8');
    expect(row.customerAmount).toBe(3200);
    expect(row.tax).toBeCloseTo(704, 10);
    expect(row.netPayable).toBeCloseTo(3904, 10);
  });

  it('holds the identity netPayable === customerAmount - retention + tax', async () => {
    // An invariant rather than literals, so the row cannot drift into an internally
    // inconsistent state even if the rates change.
    const fixture = await setupRows([EXPENSE, MILESTONE]);
    for (const id of ['BP7', 'BP8']) {
      const row = rowFor(fixture, id);
      expect(row.netPayable).toBeCloseTo(row.customerAmount - row.retention + row.tax, 10);
    }
  });

  it('never renders the under-billed total anywhere on the screen', async () => {
    // ASSERTION OF ABSENCE #2, and the one that matters most: 3,904.00 is the exact
    // number the defect printed as "Total due" on the document handed to the
    // customer. No correct implementation may leave it on an Expense-only screen.
    const fixture = await setupRows([EXPENSE]);
    const text = host(fixture).textContent ?? '';
    expect(text).not.toContain('3,904');
    expect(text).not.toContain('3,200');
  });
});
