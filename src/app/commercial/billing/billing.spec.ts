import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { Billing } from './billing';
import {
  ApiService, BillingPlanItem, Contract, Customer, FxRate, Milestone, NegotiatedRate, Order, Project, Resource, TimeEntry,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { daysOverdue, effectiveDueDate } from '../../services/finance.util';

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

/** The rows() shape the suites below read. `rows` is public on the component. */
interface RowProbe {
  readonly item: BillingPlanItem;
  readonly due: string | null;
  /** The Trigger cell (billing.ts:324), the invoice line note (:705) and the CSV column. */
  readonly trigger: string;
  readonly overdueDays: number;
  readonly invoiceNumber: string | null;
}
const rowsOf = (fixture: ComponentFixture<Billing>): RowProbe[] =>
  (fixture.componentInstance as unknown as { rows: () => RowProbe[] }).rows();

/**
 * DT-03 + DT-04 — the Due column, the overdue badge, the Overdue KPI and
 * /reporting's A/R aging must all be measured from ONE anchor.
 *
 * `dueOf` anchored on expectedDate + paymentTermsDays; `overdueDaysOf` delegates to
 * finance.util's shared `effectiveDueDate`, which anchors on dueDate ?? issuedDate +
 * terms. Both landed on the same row object and rendered side by side, so an
 * in-app-invoiced condition read "due <a past date>" next to "not overdue", and the
 * CSV exported the stale anchor to whoever chases the customer. That is the DEFAULT
 * path, not an edge case: `generateInvoice` writes only `issuedDate`, and nothing in
 * the app ever writes `dueDate`.
 */
describe('Billing — Due, the overdue badge and A/R aging share one anchor', () => {
  const CT: Contract = {
    id: 'CT1', customerId: 'C1', name: 'Framework', type: 'T&M', totalValue: 0,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };

  /**
   * Planned 30 Jun, actually invoiced 15 Jul, net 30. The two anchors disagree by
   * 15 days and land on opposite sides of "today" (2026-08-06 in the register).
   */
  const INVOICED_LATE: BillingPlanItem = {
    id: 'BP-LATE', contractId: 'CT1', type: 'TimeAndMaterials', label: 'June T&M',
    amount: 1_000, currency: 'EUR', status: 'Invoiced',
    expectedDate: '2026-06-30', issuedDate: '2026-07-15', paymentTermsDays: 30,
  };
  /** Never issued: `effectiveDueDate` cannot derive a date, so the preview must serve. */
  const PLANNED: BillingPlanItem = {
    id: 'BP-PLAN', contractId: 'CT1', type: 'Milestone', label: 'SAL 2',
    amount: 5_000, currency: 'EUR', status: 'Planned',
    expectedDate: '2026-09-30', paymentTermsDays: 30,
  };
  /** Crosses the 29 March DST change in Europe/Rome; 20 Mar + 30d = 19 Apr. */
  const DST: BillingPlanItem = {
    id: 'BP-DST', contractId: 'CT1', type: 'Milestone', label: 'SAL 1',
    amount: 2_000, currency: 'EUR', status: 'Planned',
    expectedDate: '2026-03-20', paymentTermsDays: 30,
  };
  /** An explicit dueDate outranks both branches — the pre-existing contract. */
  const EXPLICIT: BillingPlanItem = {
    id: 'BP-EXPL', contractId: 'CT1', type: 'Advance', label: 'Advance',
    amount: 900, currency: 'EUR', status: 'Invoiced',
    expectedDate: '2026-01-31', issuedDate: '2026-04-01', paymentTermsDays: 60,
    dueDate: '2026-05-05',
  };

  async function rows(items: BillingPlanItem[]): Promise<RowProbe[]> {
    const fixture = await setupSparse({
      getBillingPlanItems: () => of(items),
      getContracts: () => of([CT]),
    });
    await tick(fixture);
    return rowsOf(fixture);
  }

  const byId = (all: RowProbe[], id: string): RowProbe => all.find(r => r.item.id === id)!;

  it('shows the overdue badge exactly when the date the row DISPLAYS has passed', async () => {
    // The coherence property the two anchors broke, stated without literals and
    // without a wall-clock dependency: whichever side of the due date "now" is on,
    // an Invoiced row must not render a past Due date beside a 0-day badge, nor a
    // future one beside an "Overdue Nd" chip. Under the old code the BP-LATE row
    // displayed 2026-07-30 — already past — while overdueDays was 0, because the
    // chip was measured from 2026-08-14. That is the single-row contradiction.
    const today = new Date().toISOString().slice(0, 10);
    const all = await rows([INVOICED_LATE, EXPLICIT]);

    for (const id of ['BP-LATE', 'BP-EXPL']) {
      const row = byId(all, id);
      expect(row.item.status, 'the fixture must be Invoiced or overdueDaysOf never runs').toBe('Invoiced');
      expect(row.overdueDays > 0, `row ${id}: due ${row.due} against today ${today}`)
        .toBe((row.due ?? '9999-12-31') < today);
    }
  });

  it('anchors an in-app-invoiced condition on issuedDate + terms, the same date the badge uses', async () => {
    const all = await rows([INVOICED_LATE]);
    const row = byId(all, 'BP-LATE');

    // issuedDate 2026-07-15 + 30 = 2026-08-14.
    expect(row.due).toBe('2026-08-14');
    // ASSERTION OF ABSENCE: 2026-07-30 is expectedDate + terms — the second anchor
    // that used to render here, a week in the past, beside a badge saying "not
    // overdue". No substring form of it may survive.
    expect(row.due).not.toContain('2026-07-30');
    // And the anchor is literally the shared one, not a coincidence of arithmetic.
    expect(row.due).toBe(effectiveDueDate(row.item));
    // The badge is measured from that same string: 7 days past 2026-08-14.
    expect(daysOverdue(row.item, '2026-08-21')).toBe(7);
    // On the register's "today" the row is NOT overdue — the state in which the old
    // Due cell contradicted its own badge.
    expect(daysOverdue(row.item, '2026-08-06')).toBe(0);
  });

  it('still previews a due date for a condition that was never issued', async () => {
    // THE LOAD-BEARING ABSENCE ASSERTION. `return effectiveDueDate(i) ?? null` also
    // satisfies the test above, and blanks this column for the entire Planned book.
    const all = await rows([PLANNED]);
    const row = byId(all, 'BP-PLAN');

    expect(row.due).not.toBeNull();
    expect(row.due).toBe('2026-10-30');
    // effectiveDueDate cannot serve this row — which is exactly why the preview
    // branch has to stay. Asserted so the test states the reason it exists.
    expect(effectiveDueDate(row.item)).toBeUndefined();
  });

  it('keeps every due date a bare civil date, in any timezone', async () => {
    // The preview used to parse the civil date as UTC midnight and shift it with
    // local getDate/setDate: '2026-04-18T23:00:00.000Z' under TZ=Europe/Rome (the
    // CSV cell disagreeing with the screen across the DST change) and
    // '2026-04-19T00:00:00.000Z' under TZ=UTC. The regex is what makes this
    // un-fakeable under a UTC-only CI: no timestamp form can satisfy it.
    const all = await rows([DST, PLANNED, INVOICED_LATE]);

    expect(byId(all, 'BP-DST').due).toBe('2026-04-19');
    for (const id of ['BP-DST', 'BP-PLAN', 'BP-LATE']) {
      expect(byId(all, id).due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('lets an explicit dueDate outrank both derivations', async () => {
    // The must-still-be-ALLOWED case: a fix that always recomputes would break the
    // one anchor the data states outright.
    const all = await rows([EXPLICIT]);
    const row = byId(all, 'BP-EXPL');

    expect(row.due).toBe('2026-05-05');
    // Neither derivation: issuedDate + 60 would be 2026-05-31, expectedDate + 60
    // would be 2026-04-01.
    expect(row.due).not.toBe('2026-05-31');
    expect(row.due).not.toBe('2026-04-01');
  });
});

/**
 * F3 + the P2 sibling — every read the master table renders from is inside ONE
 * state machine, and the table is inside it too.
 *
 * `ordersRes` and `customersRes` were absent from financialDataLoading,
 * financialDataError and reloadFinancialData, and the master table was a section
 * outside every gate. So a failed /orders printed '—' in the Invoice # column of
 * already-invoiced rows and DELETED the View-invoice button from all of them —
 * every existing invoice unreachable — while nothing on the page said a read had
 * failed, and the Retry the strip offered never re-fired /orders. Widening the gate
 * alone is not the fix: it raises a banner above a table still showing those rows.
 */
describe('Billing — the master table is inside the same state machine as the KPI strip', () => {
  const CT: Contract = {
    id: 'CT1', customerId: 'C1', name: 'Framework', type: 'T&M', totalValue: 0,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const CUST: Customer = { id: 'C1', name: 'Acme Co' };
  const ORDER: Order = {
    id: 'ORD-1', contractId: 'CT1', type: 'Customer', amount: 1_000, currency: 'EUR',
    status: 'Invoiced', orderDate: '2026-07-15', invoiceNumber: 'INV-0001', invoiceDate: '2026-07-15',
  };
  /** Invoiced, linked to ORD-1 — the row whose invoice must stay reachable. */
  const ITEM: BillingPlanItem = {
    id: 'BP1', contractId: 'CT1', type: 'Milestone', label: 'SAL 1',
    amount: 1_000, currency: 'EUR', status: 'Invoiced',
    issuedDate: '2026-07-15', paymentTermsDays: 30, orderId: 'ORD-1',
  };

  const resolving = {
    getBillingPlanItems: () => of([ITEM]),
    getContracts: () => of([CT]),
    getCustomers: () => of([CUST]),
    getOrders: () => of([ORDER]),
  };

  const table = (fixture: ComponentFixture<Billing>) => host(fixture).querySelector('.command-data-table');
  const viewInvoiceButton = (fixture: ComponentFixture<Billing>) =>
    host(fixture).querySelector('button[aria-label^="View invoice"]');
  /** Every Retry control on the page, whichever state panel rendered it. */
  const retryButtons = (fixture: ComponentFixture<Billing>) =>
    [...host(fixture).querySelectorAll('button')].filter(b => b.textContent?.includes('Retry'));

  /** Narrow probe on a private rxResource field: proves the intended read failed. */
  const statusOf = (fixture: ComponentFixture<Billing>, field: string): string =>
    (fixture.componentInstance as unknown as Record<string, { status: () => string }>)[field].status();

  it('renders the table, the invoice number and the View-invoice button when every read resolves', async () => {
    // THE CASE THAT MUST STILL BE ALLOWED. A gate that always refuses passes every
    // assertion below it, so this anchors the whole suite.
    const fixture = await setupSparse(resolving);
    await tick(fixture);

    expect(fixture.componentInstance.financialDataError()).toBe(false);
    expect(fixture.componentInstance.financialDataLoading()).toBe(false);
    expect(table(fixture)).not.toBeNull();
    expect(host(fixture).textContent).toContain('INV-0001');
    expect(viewInvoiceButton(fixture)).not.toBeNull();
    expect(host(fixture).querySelector('[role="alert"]')).toBeNull();
    // The Contract filter really does list its options in the resolved state.
    expect([...host(fixture).querySelectorAll('#filterContract option')].map(o => o.textContent?.trim()))
      .toStrictEqual(['All contracts', 'Framework']);
  });

  it('reports a failed /orders instead of rendering rows that look un-invoiced', async () => {
    const fixture = await setupSparse({ ...resolving, getOrders: () => throwError(() => new Error('orders 500')) });
    await tick(fixture);

    // Positive control: it is /orders that failed, not some other read.
    expect(statusOf(fixture, 'ordersRes')).toBe('error');
    expect(fixture.componentInstance.financialDataError()).toBe(true);
    expect(host(fixture).textContent).toContain("Couldn't load billing financial data");
    // THE ABSENCE ASSERTION: the table is not rendered AT ALL. A banner raised above
    // a table still printing '—' in Invoice # and still hiding every View-invoice
    // button is the outcome this blocks.
    expect(table(fixture)).toBeNull();
    expect(viewInvoiceButton(fixture)).toBeNull();
    expect(host(fixture).textContent).not.toContain('INV-0001');
  });

  it('reports a failed /customers, which used to be answered by nothing at all', async () => {
    // /customers feeds the contract label AND the printable invoice's Bill-to, so a
    // failure here used to emit an invoice artifact with no counterparty.
    const fixture = await setupSparse({ ...resolving, getCustomers: () => throwError(() => new Error('customers 500')) });
    await tick(fixture);

    expect(statusOf(fixture, 'customersRes')).toBe('error');
    expect(fixture.componentInstance.financialDataError()).toBe(true);
    expect(host(fixture).querySelector('[role="alert"]')).not.toBeNull();
    expect(table(fixture)).toBeNull();
  });

  it('never shows the confident-empty copy when the billing conditions themselves failed', async () => {
    const fixture = await setupSparse({
      ...resolving,
      getBillingPlanItems: () => throwError(() => new Error('billing-plan-items 500')),
    });
    await tick(fixture);

    expect(statusOf(fixture, 'itemsRes')).toBe('error');
    // Scoped to the copy itself, not to "an error card exists somewhere": the KPI
    // strip's card already worked before the fix and would satisfy that vacuously.
    expect(host(fixture).textContent).not.toContain('No billing conditions match');
    expect(host(fixture).textContent).not.toContain('shown');
    expect(table(fixture)).toBeNull();
    // A Retry the user can actually reach for the table's own failure.
    expect(retryButtons(fixture).length).toBeGreaterThanOrEqual(2);
  });

  it('re-fires /orders and /customers on Retry', async () => {
    // The latch: reloadFinancialData() never touched either resource, so the state
    // survived every Retry for the life of the component. /fx-rates is the failing
    // read here so the panel (and its Retry) renders while orders/customers resolve.
    const getOrders = vi.fn(() => of([ORDER]));
    const getCustomers = vi.fn(() => of([CUST]));
    const fixture = await setupSparse({
      ...resolving,
      getOrders,
      getCustomers,
      getFxRates: () => throwError(() => new Error('fx 500')),
    });
    await tick(fixture);

    expect(getOrders).toHaveBeenCalledTimes(1);
    expect(getCustomers).toHaveBeenCalledTimes(1);

    const retry = retryButtons(fixture)[0];
    expect(retry, 'a Retry control must be rendered for a failed read').toBeTruthy();
    retry.click();
    await tick(fixture);

    expect(getOrders).toHaveBeenCalledTimes(2);
    expect(getCustomers).toHaveBeenCalledTimes(2);
  });
});

/**
 * DT-04's REMAINING HALF — the Trigger column.
 *
 * The Due column was pinned to bare civil dates in an earlier batch. `formatDate`,
 * which the Trigger cell (billing.ts:324), the invoice line-item note (:705) and the
 * CSV 'Trigger' column (:1483) all render through, was left on `toLocaleDateString()`
 * over a UTC-parsed instant — the batch that fixed `dueOf` said so explicitly.
 *
 * WHAT THIS RUNNER CAN AND CANNOT PROVE. Stated rather than papered over, because a
 * TZ-dependent expectation green under the CI default is one of this project's
 * recorded blind-green shapes. The suite runs in ONE zone (nothing in angular.json or
 * package.json pins TZ; this machine resolves to Europe/Rome), so no assertion here
 * could distinguish a UTC-pinned formatter from a local one for EVERY input. Two
 * things are red regardless of which zone you read them in:
 *
 *   - THE FORMAT. A default `toLocaleDateString()` emits '6/15/2026'; no locale turns
 *     that into 'Jun 15, 2026'. Zone-independent, and the shape that makes the two
 *     date columns of one row agree — Due renders `| date: 'mediumDate'`.
 *   - THE DAY, for a stored value carrying a TIME. In any UTC-POSITIVE zone
 *     2026-06-15T23:30:00Z reads back locally as the 16th. Red here. (In a
 *     UTC-NEGATIVE zone it is the date-only case that shifts instead — the same
 *     defect, entered from the other side.)
 *
 * Neither assertion reads the wall clock.
 */
describe('Billing — the Trigger column names the day the stored date names', () => {
  const CT: Contract = {
    id: 'CT1', customerId: 'C1', name: 'Framework', type: 'T&M', totalValue: 0,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const MILESTONE_M1: Milestone = {
    id: 'M1', projectId: 'P1', name: 'UAT sign-off', date: '2026-06-15', status: 'Pending',
  };
  const DATE_ONLY: BillingPlanItem = {
    id: 'BP-D', contractId: 'CT1', type: 'Advance', label: 'Advance',
    amount: 1_000, currency: 'EUR', status: 'Planned', expectedDate: '2026-06-15',
  };
  /**
   * 23:30Z is already the 16th in Europe/Rome. REACHABLE, not a lying fixture: the
   * server's date backstop admits anything `Date.parse` accepts (`isIsoDateString`,
   * src/server.ts:154-155) despite its "(YYYY-MM-DD)" message, and it exists for
   * exactly the direct API / integration callers that would send this.
   */
  const WITH_TIME: BillingPlanItem = {
    id: 'BP-T', contractId: 'CT1', type: 'Expense', label: 'Travel',
    amount: 500, currency: 'EUR', status: 'Planned', expectedDate: '2026-06-15T23:30:00.000Z',
  };

  async function rows(items: BillingPlanItem[], milestones: Milestone[] = []): Promise<RowProbe[]> {
    const fixture = await setupSparse({
      getBillingPlanItems: () => of(items),
      getContracts: () => of([CT]),
      getMilestones: () => of(milestones),
    });
    await tick(fixture);
    return rowsOf(fixture);
  }

  const byId = (all: RowProbe[], id: string): RowProbe => all.find(r => r.item.id === id)!;

  it('renders a date-only expectedDate as that civil day, in the medium shape the Due column uses', async () => {
    const all = await rows([DATE_ONLY]);
    const row = byId(all, 'BP-D');

    // RED in every zone before the fix: '6/15/2026'.
    expect(row.trigger).toBe('Jun 15, 2026');
    // And the day is the one the source string names. This is the assertion that
    // fails outright in a UTC-negative zone, where the old code printed the 14th.
    expect(row.trigger).toContain('15');
    expect(row.trigger).not.toContain('14');
  });

  it('keeps the UTC day for a stored value that carries a time, so the row and its edit form agree', async () => {
    // `openEdit` seeds the date input with `expectedDate.slice(0, 10)` = 2026-06-15,
    // so a Trigger cell reading the 16th makes ONE row state two different days.
    // RED in this runner's zone before the fix (local read = 01:30 on the 16th).
    const all = await rows([WITH_TIME]);
    const row = byId(all, 'BP-T');

    expect(row.trigger).toBe('Jun 15, 2026');
    expect(row.trigger).not.toContain('16');
    // The fixture really does carry a time — otherwise this case is the one above.
    expect(row.item.expectedDate).toContain('T23:30');
    expect(row.item.expectedDate!.slice(0, 10)).toBe('2026-06-15');
  });

  it('leaves the non-date triggers alone — milestone name, recurrence, "On demand"', async () => {
    // THE ABSENCE TWIN for the switch in `triggerOf`. A "fix" that routes every
    // trigger through the date formatter, or that loses the milestone lookup, passes
    // both cases above and fails here: none of these cells may look like a date.
    const milestoneItem: BillingPlanItem = {
      id: 'BP-M', contractId: 'CT1', type: 'Milestone', label: 'SAL 2', milestoneId: 'M1',
      amount: 5_000, currency: 'EUR', status: 'Planned', expectedDate: '2026-06-15',
    };
    const recurringItem: BillingPlanItem = {
      id: 'BP-R', contractId: 'CT1', type: 'Recurring', label: 'Managed service',
      amount: 900, currency: 'EUR', status: 'Planned', recurrence: 'Quarterly',
      expectedDate: '2026-06-15',
    };
    const onDemand: BillingPlanItem = {
      id: 'BP-O', contractId: 'CT1', type: 'TimeAndMaterials', label: 'T&M',
      amount: 0, currency: 'EUR', status: 'Planned',
    };
    const all = await rows([milestoneItem, recurringItem, onDemand], [MILESTONE_M1]);

    expect(byId(all, 'BP-M').trigger).toBe('UAT sign-off');
    expect(byId(all, 'BP-R').trigger).toBe('Quarterly');
    expect(byId(all, 'BP-O').trigger).toBe('On demand');
    for (const id of ['BP-M', 'BP-R', 'BP-O']) {
      expect(byId(all, id).trigger).not.toContain('2026');
    }
  });

  it('echoes an unparseable expectedDate rather than printing "Invalid Date"', async () => {
    // No-regression parity with the guard the old implementation had. Not reachable
    // through the API (isIsoDateString rejects it), so this pins the contract only —
    // it is not evidence of a live failure path.
    const all = await rows([{ ...DATE_ONLY, id: 'BP-X', expectedDate: 'not-a-date' }]);

    expect(byId(all, 'BP-X').trigger).toBe('not-a-date');
    expect(byId(all, 'BP-X').trigger).not.toContain('Invalid');
  });
});

/**
 * The modal-overlay family fix (register: manage-rate-cards.component.ts:103, "also
 * ... billing.ts"), applied to THIS screen's create/edit overlay.
 *
 * `flex items-center` on a position:fixed box with no overflow splits any surplus
 * height above AND below the viewport at once, so on a short viewport the panel's
 * header (with Close) goes off the top while the Create/Save row goes off the bottom —
 * and a fixed box cannot be scrolled by the page. The invoice overlay lower down the
 * same template was already built the safe way, which is why the register names it as
 * the in-repo GREEN anchor for this predicate.
 *
 * STRUCTURAL CONTRACT ONLY. jsdom performs no layout — offsetHeight is 0 and there is
 * no viewport — so NOTHING here proves the Save row is clipped at 320x460. It proves
 * the three class tokens that make an overlay scrollable sit on the right two
 * elements. The clipping arithmetic needs a real browser at 320x460 asserting
 * `getBoundingClientRect().bottom <= window.innerHeight`, and this repo has no
 * browser runner (no playwright in package.json).
 */
describe('Billing — both modal overlays carry the scroll-safe class contract (structure only; jsdom has no layout)', () => {
  interface ScrollSafety {
    readonly overlayScrolls: boolean;
    readonly overlayStartsAtTopOnShortViewports: boolean;
    readonly panelHeightBounded: boolean;
  }
  const scrollSafetyOf = (overlayClass: string, panelClass: string): ScrollSafety => ({
    overlayScrolls: overlayClass.includes('overflow-y-auto'),
    overlayStartsAtTopOnShortViewports: overlayClass.includes('items-start'),
    panelHeightBounded: /max-h-\[/.test(panelClass),
  });

  const SAFE: ScrollSafety = {
    overlayScrolls: true, overlayStartsAtTopOnShortViewports: true, panelHeightBounded: true,
  };

  const safetyOfOverlay = (fixture: ComponentFixture<Billing>, selector: string): ScrollSafety => {
    const overlay = host(fixture).querySelector(selector) as HTMLElement | null;
    expect(overlay, `the ${selector} overlay must be rendered`).toBeTruthy();
    const panel = overlay!.firstElementChild as HTMLElement;
    return scrollSafetyOf(overlay!.className, panel.className);
  };

  it('discriminates a clipping overlay from a scroll-safe one, so the predicate is not a class-string tautology', () => {
    // THE NEGATIVE CONTROL, and the reason the three assertions below mean anything.
    // These are the EXACT class strings the create/edit overlay carried at d1c89b4: a
    // fixed, centred box with no overflow. All three predicates must report false.
    expect(scrollSafetyOf(
      'fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6',
      'command-card w-full max-w-2xl overflow-hidden flex flex-col',
    )).toStrictEqual({
      overlayScrolls: false, overlayStartsAtTopOnShortViewports: false, panelHeightBounded: false,
    });
  });

  it('holds for the create/edit overlay', async () => {
    const fixture = await setupSparse();
    await tick(fixture);
    fixture.componentInstance.openCreate();
    await tick(fixture);

    // Not the invoice overlay: only one modal is open, and this asserts which.
    expect(host(fixture).querySelector('.invoice-overlay')).toBeNull();
    expect(safetyOfOverlay(fixture, '[appModal]')).toStrictEqual(SAFE);
  });

  it('holds for the invoice overlay — the in-repo element the family fix was copied from', async () => {
    const CT: Contract = {
      id: 'CT1', customerId: 'C1', name: 'Framework', type: 'T&M', totalValue: 0,
      currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
    };
    const ORDER: Order = {
      id: 'ORD-1', contractId: 'CT1', type: 'Customer', amount: 1_000, currency: 'EUR',
      status: 'Invoiced', orderDate: '2026-07-15', invoiceNumber: 'INV-0001', invoiceDate: '2026-07-15',
    };
    const ITEM: BillingPlanItem = {
      id: 'BP1', contractId: 'CT1', type: 'Milestone', label: 'SAL 1',
      amount: 1_000, currency: 'EUR', status: 'Invoiced', orderId: 'ORD-1',
    };
    const fixture = await setupSparse({
      getBillingPlanItems: () => of([ITEM]),
      getContracts: () => of([CT]),
      getOrders: () => of([ORDER]),
    });
    await tick(fixture);

    const row = rowsOf(fixture)[0];
    // openInvoice() returns EARLY unless the row carries an invoice number, so
    // without this the overlay would never mount and the assertion below would fail
    // on a missing element rather than on the class contract.
    expect(row.invoiceNumber, 'the fixture must carry an invoice or openInvoice is a no-op').toBe('INV-0001');
    fixture.componentInstance.openInvoice(row as unknown as Parameters<Billing['openInvoice']>[0]);
    await tick(fixture);

    expect(safetyOfOverlay(fixture, '.invoice-overlay')).toStrictEqual(SAFE);
  });
});
