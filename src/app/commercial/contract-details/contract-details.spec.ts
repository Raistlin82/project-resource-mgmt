import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, Subject, throwError } from 'rxjs';
import { ContractDetails } from './contract-details';
import {
  ApiService,
  BillingPlanItem,
  Contract,
  Customer,
  FxRate,
  NegotiatedRate,
  Order,
  OrderLine,
  Project,
  Resource,
  TimeEntry,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open (e.g. our
 * controlled `Subject` below, before it emits+completes) — so the "still
 * pending" checkpoint in this spec cannot use it. Ticking microtasks lets every
 * ALREADY-synchronous read settle and reach the DOM without waiting on the one
 * we are deliberately holding open.
 */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

describe('ContractDetails — primary page state', () => {
  function apiWithContracts(source: Observable<Contract[]>) {
    return {
      getContracts: () => source,
      getCustomers: () => of([]),
      getProjects: () => of([]),
      getOrders: () => of([]),
      getOrderLines: () => of([]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([]),
      getBillingPlanItems: () => of([]),
      getMilestones: () => of([]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => of([]),
      getHoursPerDay: () => of({ value: 8 }),
      getProjectRoles: () => of([]),
    } as unknown as ApiService;
  }

  async function render(api: ApiService): Promise<ComponentFixture<ContractDetails>> {
    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        {
          provide: AuthService,
          useValue: { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService,
        },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'missing-contract');
    await tick(fixture);
    return fixture;
  }

  it('keeps dependent content hidden while the contract read is pending', async () => {
    const contracts$ = new Subject<Contract[]>();
    const fixture = await render(apiWithContracts(contracts$));

    expect(host(fixture).textContent).toContain('Loading contract details');
    expect(host(fixture).textContent).not.toContain('Contract not found');
    expect(host(fixture).textContent).not.toContain('Projects under this contract');
  });

  it('shows a definitive not-found state only after a successful empty lookup', async () => {
    const fixture = await render(apiWithContracts(of<Contract[]>([])));

    expect(host(fixture).textContent).toContain('Contract not found');
    expect(host(fixture).textContent).toContain('No contract matches this identifier');
    expect(host(fixture).textContent).not.toContain('still loading');
    expect(host(fixture).textContent).not.toContain('Projects under this contract');
  });

  it('shows an error with Retry instead of converting a failed read into not-found', async () => {
    const fixture = await render(apiWithContracts(throwError(() => new Error('network failure'))));

    expect(host(fixture).textContent).toContain("Couldn't load contract");
    expect(host(fixture).textContent).toContain('Retry');
    expect(host(fixture).textContent).not.toContain('Contract not found');
    expect(host(fixture).textContent).not.toContain('Projects under this contract');
  });
});

describe('ContractDetails — recognition figure gating (Task 4, round 3)', () => {
  it('does not render Total Recognized while negotiatedRates is still pending, and renders the correct figure once every dependency has resolved', async () => {
    const contract: Contract = {
      id: 'CT2', customerId: 'C1', name: 'T&M Framework', type: 'T&M', totalValue: 0,
      currency: 'USD', status: 'Active', startDate: '2020-01-01', endDate: '2030-12-31',
    };
    const customer: Customer = { id: 'C1', name: 'Acme Co' };
    const project: Project = {
      id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2020-01-01',
      endDate: '2030-12-31', status: 'Active', contractId: 'CT2',
    };
    // The hourly reference (200 €/h) is ABOVE the negotiated hourly price
    // (100 €/h) — the resolved figure must reflect the negotiated price.
    const resource: Resource = {
      id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
      externalExperience: [], utilization: 80, capacity: 40, billRate: 200,
    };
    const entry: TimeEntry = {
      id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: 'R1',
      projectId: 'P2', date: '2026-05-01', hours: 10, status: 'Approved',
    };
    const item: BillingPlanItem = {
      id: 'BP1', contractId: 'CT2', projectId: 'P2', type: 'TimeAndMaterials',
      label: 'T&M', amount: 0, currency: 'EUR', status: 'Ready',
    };
    // UNITS (the C1 fix): the negotiated rate is 800 EUR per DAY, which at the
    // default 8h working day resolves to 100 EUR per HOUR; the resource's own
    // reference billRate is already hourly (200 €/h = 1600 €/day).
    const rate: NegotiatedRate = { id: 'nr1', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 800 };

    // Every OTHER read this screen makes resolves synchronously; negotiatedRates
    // deliberately does NOT — a Subject under our control standing in for "this
    // one specific read is still in flight", which is exactly the partial-
    // envelope window the coordinator's finding named (contracts/resources/
    // timeEntries/billingItems landed, negotiatedRates or projects had not).
    const negotiatedRates$ = new Subject<NegotiatedRate[]>();

    const apiStub = {
      getContracts: () => of([contract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([project]),
      getOrders: () => of([]),
      getOrderLines: () => of([]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([resource]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([entry]),
      getBillingPlanItems: () => of([item]),
      getMilestones: () => of([]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => negotiatedRates$,
      // 8h working day: the EUR/day -> EUR/hour divisor for `rate` above.
      getHoursPerDay: () => of({ value: 8 }),
    } as unknown as ApiService;
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;

    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]), // the header renders a RouterLink back to /contracts
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'CT2');

    // CHECKPOINT 1 — pending: contracts/projects/resources/timeEntries/
    // billingItems have all resolved (synchronous), negotiatedRates has not.
    await tick(fixture);
    const pendingText = host(fixture).textContent ?? '';
    expect(pendingText).toContain('Loading recognition data');
    expect(pendingText).not.toContain('Total Recognized');

    // Resolve the pending dependency.
    negotiatedRates$.next([rate]);
    negotiatedRates$.complete();
    await tick(fixture);

    // CHECKPOINT 2 — resolved: the figure renders, and at the negotiated price
    // (10h x 100 €/h = 1,000), not the reference (10h x 200 €/h = 2,000) and not
    // the un-converted day rate (10h x 800 = 8,000 — the C1 unit bug).
    const resolvedText = host(fixture).textContent ?? '';
    expect(resolvedText).toContain('Total Recognized');
    expect(resolvedText).toMatch(/1,000\.00/);
    expect(resolvedText).not.toMatch(/2,000\.00/);
    expect(resolvedText).not.toMatch(/8,000\.00/);
  });

  it('does not render Total Recognized when a dependency ERRORED, and offers a retry instead', async () => {
    // An errored resource reports isLoading() === false. A gate written only on
    // isLoading() therefore passes, and the figure renders priced off the
    // reference billRate at the default-8 divisor — 10h x 200 €/h = 2,000
    // instead of the negotiated 1,000. Reachable in production the moment a
    // principal-gated read 401s. Revert recognitionDataReady() to the
    // isLoading()-only form and this test sees "Total Recognized" and 2,000.00.
    const contract: Contract = {
      id: 'CT2', customerId: 'C1', name: 'T&M Framework', type: 'T&M', totalValue: 0,
      currency: 'EUR', status: 'Active', startDate: '2020-01-01', endDate: '2030-12-31',
    };
    const customer: Customer = { id: 'C1', name: 'Acme Co' };
    const project: Project = {
      id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2020-01-01',
      endDate: '2030-12-31', status: 'Active', contractId: 'CT2',
    };
    const resource: Resource = {
      id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
      externalExperience: [], utilization: 80, capacity: 40, billRate: 200,
    };
    const entry: TimeEntry = {
      id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: 'R1',
      projectId: 'P2', date: '2026-05-01', hours: 10, status: 'Approved',
    };
    const item: BillingPlanItem = {
      id: 'BP1', contractId: 'CT2', projectId: 'P2', type: 'TimeAndMaterials',
      label: 'T&M', amount: 0, currency: 'EUR', status: 'Ready',
    };

    const apiStub = {
      getContracts: () => of([contract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([project]),
      getOrders: () => of([]),
      getOrderLines: () => of([]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([resource]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([entry]),
      getBillingPlanItems: () => of([item]),
      getMilestones: () => of([]),
      getFxRates: () => of([]),
      getProjectRoles: () => of([]),
      // The failing read: exactly what a 401 on a principal-gated GET produces.
      getNegotiatedRates: () => throwError(() => new Error('401 Unauthorized')),
      getHoursPerDay: () => of({ value: 8 }),
    } as unknown as ApiService;
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;

    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'CT2');
    await tick(fixture);

    const text = host(fixture).textContent ?? '';
    expect(text).not.toContain('Total Recognized');
    expect(text).not.toMatch(/2,000\.00/);
    // And it must not claim to still be loading something that already failed.
    expect(text).not.toContain('Loading recognition data');
    expect(text).toContain('Recognition figures are unavailable');
  });
});

describe('ContractDetails — Negotiated Rates table (Task 5)', () => {
  const contract: Contract = {
    id: 'CT1', customerId: 'C1', name: 'Framework Agreement', type: 'T&M', totalValue: 0,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const customer: Customer = { id: 'C1', name: 'Acme Co' };
  const resource: Resource = {
    id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 80, capacity: 40, billRate: 1200,
  };

  /** Every read this component makes, all synchronous, so a single tick() settles the DOM. */
  function baseStub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getContracts: () => of([contract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([]),
      getOrders: () => of([]),
      getOrderLines: () => of([]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([resource]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([]),
      getBillingPlanItems: () => of([]),
      getMilestones: () => of([]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => of([]),
      getHoursPerDay: () => of({ value: 8 }),
      // The project-roles CATALOG — the same authority the server validates a
      // rate's role against. 'Project Manager' is in it and held by no resource.
      getProjectRoles: () => of([
        { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
        { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false },
      ]),
      ...overrides,
    } as unknown as ApiService;
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<ContractDetails>> {
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'CT1');
    await tick(fixture);
    return fixture;
  }

  it('lists the negotiated rates of the contract', async () => {
    const rate: NegotiatedRate = { id: 'NR1', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 1000 };
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([rate]) }));

    const rows = host(fixture).querySelectorAll('[data-test="negotiated-rate-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Developer');
    // Rendered through `number:'1.0-2'` (two-decimal display rule) — locale grouping applies.
    expect(rows[0].textContent).toContain('1,000');
  });

  it('offers every catalog role, including one no resource holds (final review, finding 5)', async () => {
    // Same finding as project-rates.spec.ts: the server accepts any catalog role
    // so a rate can be negotiated before the profile is staffed, and a picker
    // built from the staffed roles hides exactly that workflow.
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Rate'));
    addButton!.click();
    await tick(fixture);

    const options = [...h.querySelectorAll<HTMLOptionElement>('#rateRole option')].map(o => o.value);
    expect(options).toContain('Developer');
    expect(options).toContain('Project Manager');   // in the catalog, held by nobody
  });

  it('offers only the EUR base currency even when the FX catalog contains other currencies', async () => {
    const fixture = await setUp(baseStub({
      getFxRates: () => of([
        { currency: 'EUR', rateToBase: 1 },
        { currency: 'USD', rateToBase: 0.91 },
      ]),
    }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Rate'));
    expect(addButton).toBeTruthy();
    addButton!.click();
    await tick(fixture);

    const currencies = [...h.querySelectorAll<HTMLOptionElement>('#rateCurrency option')]
      .map(option => option.value);
    expect(currencies).toEqual(['EUR']);
  });

  it('sends contractId and never projectId when adding on a contract', async () => {
    const createSpy = vi.fn().mockReturnValue(of({ id: 'NR9', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 950 }));
    const fixture = await setUp(baseStub({ createNegotiatedRate: createSpy }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Rate'));
    expect(addButton).toBeTruthy();
    addButton!.click();
    await tick(fixture);

    const roleSelect = h.querySelector<HTMLSelectElement>('#rateRole');
    expect(roleSelect).toBeTruthy();
    roleSelect!.value = 'Developer';
    roleSelect!.dispatchEvent(new Event('change'));

    const billRateInput = h.querySelector<HTMLInputElement>('#rateBillRate');
    expect(billRateInput).toBeTruthy();
    billRateInput!.value = '950';
    billRateInput!.dispatchEvent(new Event('input'));
    await tick(fixture);

    const saveButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Rate');
    expect(saveButton).toBeTruthy();
    saveButton!.click();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const payload = createSpy.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({ contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 950 }));
    expect('projectId' in payload).toBe(false);
  });

  it('surfaces the server refusal without closing the form', async () => {
    const existing: NegotiatedRate = { id: 'NR1', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 1000 };
    const createSpy = vi.fn().mockReturnValue(
      throwError(() => ({ error: { error: 'a negotiated rate already exists for this key (existing id NR1)' } })),
    );
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([existing]), createNegotiatedRate: createSpy }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Rate'));
    addButton!.click();
    await tick(fixture);

    const roleSelect = h.querySelector<HTMLSelectElement>('#rateRole');
    roleSelect!.value = 'Developer';
    roleSelect!.dispatchEvent(new Event('change'));
    const billRateInput = h.querySelector<HTMLInputElement>('#rateBillRate');
    billRateInput!.value = '900';
    billRateInput!.dispatchEvent(new Event('input'));
    await tick(fixture);

    const saveButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Rate');
    saveButton!.click();
    await tick(fixture);

    // The form must still be open, and the exact server message rendered.
    expect(h.querySelector('#rateRole')).toBeTruthy();
    const errorEl = h.querySelector('[data-test="negotiated-rate-error"]');
    expect(errorEl?.textContent).toContain('a negotiated rate already exists for this key (existing id NR1)');
  });
});

describe('ContractDetails — money regions never show a fabricated figure (P1-10, round 2)', () => {
  const contract: Contract = {
    id: 'CT9', customerId: 'C1', name: 'Fixed Price', type: 'Fixed Price', totalValue: 100_000,
    currency: 'EUR', status: 'Active', startDate: '2020-01-01', endDate: '2030-12-31',
  };
  const customer: Customer = { id: 'C1', name: 'Acme Co' };
  const project: Project = {
    id: 'P9', name: 'Alpha', location: 'Remote', startDate: '2020-01-01',
    endDate: '2030-12-31', status: 'Active', contractId: 'CT9',
  };
  // 100h of approved time at a 100 €/h cost rate = 10,000 actual cost, so the
  // resolved margin is 50,000 - 10,000 = 40,000. If /resources 401s, that cost
  // silently becomes 0 and the margin renders as 50,000 at 100.0%.
  const resource: Resource = {
    id: 'R9', name: 'Dev', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 50, capacity: 40, costRate: 100, billRate: 200,
  };
  const entry: TimeEntry = {
    id: 'TE9', assignmentId: 'a9', requestId: 'r9', resourceId: 'R9',
    projectId: 'P9', date: '2026-05-01', hours: 100, status: 'Approved',
  };

  function stub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getContracts: () => of([contract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([project]),
      getOrders: () => of([{ id: 'O9', contractId: 'CT9', type: 'Customer', amount: 50_000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-01-01' }]),
      getOrderLines: () => of([{ id: 'OL9', orderId: 'O9', projectId: 'P9', description: 'work', amount: 50_000 }]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([resource]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([entry]),
      getBillingPlanItems: () => of([]),
      getMilestones: () => of([]),
      getFxRates: () => of([]),
      getProjectRoles: () => of([]),
      getNegotiatedRates: () => of([]),
      getHoursPerDay: () => of({ value: 8 }),
      ...overrides,
    } as unknown as ApiService;
  }

  async function render(api: ApiService) {
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'CT9');
    await tick(fixture);
    return fixture;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('shows the real cost-derived figures when every read resolves', async () => {
    // POSITIVE CONTROL FIRST: without it the assertions below could pass because
    // nothing renders at all.
    const text = host(await render(stub())).textContent ?? '';
    expect(text).not.toContain('Limited data');
    expect(text).toMatch(/40,000\.00/);   // 50,000 revenue - 10,000 actual cost
    expect(text).toContain('Order Revenue');
  });

  it('shows Limited data and a Retry instead of a 100% margin when a cost read is FORBIDDEN', async () => {
    // THE DEFECT THIS WAVE INTRODUCED. /resources is gated by READ_RULES to the
    // staffing roles, which EXCLUDES sales, so resourcesRes 401s. The
    // status()==='error' ? [] : value() accessor then yields [], the labour cost
    // sums to nothing, and margin = revenue - 0 renders as Margin = Order Revenue
    // at Margin % 100.0 — P1-10's exact symptom, with a confident number in place
    // of the crash it replaced. Remove the moneyFiguresState() gate and this test
    // sees 50,000.00 and 100.0%.
    const text = host(await render(stub({
      getResources: () => throwError(() => new Error('401 Unauthorized')),
    }))).textContent ?? '';

    expect(text).toContain('Limited data');
    expect(text).toContain('Retry');
    expect(text).not.toContain('100.0%');
    // Note: the Orders table further down legitimately shows the real €50,000.00
    // ORDER amount — that read succeeded — so this asserts the absence of the
    // DERIVED figures, not of every occurrence of the number.
    // Every money region is covered, not just the KPI strip: the per-project
    // table, the billing control strip and the billing plan strip too.
    expect(text).not.toContain('Order Revenue');
    expect(text).not.toContain('Actual To Date');
    expect(text).not.toContain('Retention Held');
  });

  it('never states "none" as a fact under its own Limited-data banner', async () => {
    // ROUND 3. Orders, Negotiated Rates and Billing Plan items all derive from
    // resources in moneyInputs(), so when one fails the banner appears above —
    // and these three printed "No orders for this contract" / "No negotiated
    // rates" / "No billing plan items" underneath it. An empty list presented as
    // fact next to a notice saying the data is missing.
    const text = host(await render(stub({
      getOrders: () => throwError(() => new Error('401 Unauthorized')),
    }))).textContent ?? '';

    expect(text).toContain('Limited data');
    expect(text).not.toContain('No orders for this contract');
    expect(text).not.toContain('No negotiated rates for this contract');
    expect(text).not.toContain('No billing plan items for this contract');
    expect(text).toContain('Unavailable — a read this list depends on failed.');
  });

  it('still says "none" when the reads succeed and there genuinely is nothing', async () => {
    // The positive control: the fix must not turn every empty list into
    // "unavailable", which would be the same lie in the other direction.
    const text = host(await render(stub())).textContent ?? '';
    expect(text).not.toContain('Unavailable — a read this list depends on failed.');
    expect(text).toContain('No negotiated rates for this contract');
    expect(text).toContain('No billing plan items for this contract');
  });

  it('gates EAC on the requests and assignments it derives from', async () => {
    // moneyInputs() claimed to hold "every read a money figure derives from" and
    // did not hold these two. plannedLaborCostForProject reads d.requests and
    // d.assignments; if either fails, plannedLaborCost collapses to 0 and EAC
    // understates while the gate still said 'ready'. Drop either from
    // moneyInputs() and this test sees the figures instead of the banner.
    for (const failing of ['getRequests', 'getAssignments'] as const) {
      const text = host(await render(stub({
        [failing]: () => throwError(() => new Error('transient')),
      }))).textContent ?? '';
      expect(text, failing).toContain('Limited data');
      expect(text, failing).not.toContain('Order Revenue');
      TestBed.resetTestingModule();
    }
  });

  it('covers the per-project table, which shows the same money', async () => {
    const text = host(await render(stub({
      getTimeEntries: () => throwError(() => new Error('401 Unauthorized')),
    }))).textContent ?? '';

    expect(text).toContain('Limited data — per-project figures are unavailable.');
    expect(text).not.toContain('Alpha');
  });
});

describe('ContractDetails — derived figures are in the reporting base currency (MF-02)', () => {
  /** The seed's own table: EUR is the base, so 1 USD is worth 0.92 EUR. */
  const FX: FxRate[] = [
    { currency: 'EUR', rateToBase: 1 },
    { currency: 'USD', rateToBase: 0.92 },
  ];

  /**
   * Read a KPI tile's VALUE by its label, so an assertion about one tile cannot
   * be satisfied by a number rendered somewhere else on this long page. Both the
   * header block and the strips use the same label/value pair of <p> elements.
   */
  function kpi(h: HTMLElement, label: string): string {
    const el = [...h.querySelectorAll('.command-kpi-label')].find(node => node.textContent?.trim() === label);
    expect(el, `KPI tile "${label}" is not rendered`).toBeTruthy();
    return el!.parentElement!.querySelector('.command-kpi-value')!.textContent!.trim();
  }

  // --- The seed's USD chain, trimmed to what these figures read -------------
  // CT2 'Initech T&M Framework': USD, totalValue 300000, period 2026-03..2027-02.
  const usdContract: Contract = {
    id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300_000,
    currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28',
  };
  const customer: Customer = { id: 'C2', name: 'Initech' };
  const project: Project = {
    id: '2', name: 'Project Beta', location: 'Munich', startDate: '2026-05-01',
    endDate: '2027-05-01', status: 'In Execution', contractId: 'CT2',
  };
  // O3/OL3: a USD customer order of 120,000 imputed to project 2.
  const usdOrder: Order = { id: 'O3', contractId: 'CT2', type: 'Customer', amount: 120_000, currency: 'USD', status: 'Open', orderDate: '2026-03-10' };
  const usdLine: OrderLine = { id: 'OL3', orderId: 'O3', projectId: '2', description: 'UI/UX work package', amount: 120_000 };
  // BP2: Monthly Recurring, 12,000 USD, already Invoiced -> recognized in full.
  const bp2: BillingPlanItem = {
    id: 'BP2', contractId: 'CT2', projectId: '2', type: 'Recurring', label: 'Monthly retainer',
    recurrence: 'Monthly', expectedDate: '2026-03-31', issuedDate: '2026-03-31', dueDate: '2026-04-30',
    amount: 12_000, currency: 'USD', status: 'Invoiced',
  };
  // BP3: the as-incurred T&M obligation — its own `amount` is never recognized;
  // approved hours priced at the negotiated sell rate are, and that price is
  // EUR-denominated already. This is the item that makes the pre-fix total a sum
  // of two different units.
  const bp3: BillingPlanItem = {
    id: 'BP3', contractId: 'CT2', projectId: '2', type: 'TimeAndMaterials', label: 'T&M consuntivo Q1',
    expectedDate: '2026-04-15', amount: 28_500, currency: 'USD', status: 'Ready',
  };
  const developer: Resource = {
    id: '1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 80, capacity: 40, billRate: 200, costRate: 100,
  };
  // TE4: one 8h approved day on project 2, priced by NR_P2_DEV (1150 EUR/day ÷
  // 8h = 143.75 EUR/h) = 1,150 EUR — never touched by FX.
  const te4: TimeEntry = {
    id: 'TE4', assignmentId: '6', requestId: '6', resourceId: '1',
    projectId: '2', date: '2026-06-01', hours: 8, status: 'Approved',
  };
  const projectRate: NegotiatedRate = { id: 'NR_P2_DEV', projectId: '2', role: 'Developer', currency: 'EUR', billRate: 1150 };

  function usdStub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getContracts: () => of([usdContract]),
      getCustomers: () => of([customer]),
      getProjects: () => of([project]),
      getOrders: () => of([usdOrder]),
      getOrderLines: () => of([usdLine]),
      getRequests: () => of([]),
      getAssignments: () => of([]),
      getResources: () => of([developer]),
      getProjectFinancials: () => of([]),
      getTimeEntries: () => of([te4]),
      getBillingPlanItems: () => of([bp2, bp3]),
      getMilestones: () => of([]),
      getFxRates: () => of(FX),
      getProjectRoles: () => of([]),
      getNegotiatedRates: () => of([projectRate]),
      getHoursPerDay: () => of({ value: 8 }),
      ...overrides,
    } as unknown as ApiService;
  }

  async function render(api: ApiService, contractId: string): Promise<ComponentFixture<ContractDetails>> {
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', contractId);
    await tick(fixture);
    return fixture;
  }

  afterEach(() => TestBed.resetTestingModule());

  // THE DEFECT. `data()` omitted `fxRates`, and convertToBase with no rate table
  // is documented to be an exact identity — so 'Total Recognised' printed
  // 12,000 USD + 1,150 EUR = 13,150 as one number under a '$' symbol: an amount
  // in no currency at all. Each figure gets its OWN case, so each red is
  // observable on its own rather than hidden behind an earlier assertion that
  // aborts the test. Every assertion is on the CONVERSION RATIO, never on a
  // currency token alone — a token assertion is the class of check this repo has
  // already been burned by; the token is only ever checked alongside its number.

  it('converts an order line at its ORDER currency before summing into Order Revenue', async () => {
    const fixture = await render(usdStub(), 'CT2');
    const cmp = fixture.componentInstance;

    // OL3's 120,000 is denominated in O3's USD.
    expect(cmp.kpis().revenue).toBeCloseTo(120_000 * 0.92, 6);

    // The envelope actually carries the table. `toStrictEqual` plus the key check
    // because `toEqual({fxRates: undefined})` is also satisfied by an absent key.
    expect(cmp['data']().fxRates).toStrictEqual(FX);
    expect(Object.keys(cmp['data']())).toContain('fxRates');

    // The guard must still ALLOW: fx-rates resolved, so nothing is suppressed.
    expect(cmp['moneyFiguresState']()).toBe('ready');

    const h = host(fixture);
    // Value and label together — a base-currency number under a '$' symbol is
    // the defect, not the fix.
    expect(kpi(h, 'Order Revenue')).toBe('€110,400.00');
    // Contract Value is the contract's OWN stored amount, so it STAYS USD. This
    // is the case that must still be allowed, and the reason a page-wide
    // "no $ anywhere" assertion would be wrong.
    expect(kpi(h, 'Contract Value')).toContain('$300,000.00');
    expect(kpi(h, 'Total Value')).toContain('$300,000.00');
  });

  it('recognises the USD billing item converted and the as-incurred EUR hours at par', async () => {
    const fixture = await render(usdStub(), 'CT2');
    const cmp = fixture.componentInstance;

    // THE SHARPEST ASSERTION IN THIS BATCH: no blanket rescaling of the tile can
    // produce this number, because only the BP2 half converts — the as-incurred
    // 1,150 is priced from a EUR/day negotiated rate and is already base
    // currency. 12,000 USD -> 11,040 EUR, plus 1,150 EUR = 12,190 EUR.
    expect(cmp.recognitionSummary().totalRecognized).toBeCloseTo(12_000 * 0.92 + 1150, 6);
    // ...and the pre-fix unit-less sum must be gone, not merely "different".
    expect(cmp.recognitionSummary().totalRecognized).not.toBeCloseTo(12_000 + 1150, 6);
    expect(kpi(host(fixture), 'Total Recognized')).toBe('€12,190.00');
  });

  it('converts the billing-control strip to the base currency too', async () => {
    const fixture = await render(usdStub(), 'CT2');
    const cmp = fixture.componentInstance;

    // BP2 + BP3, both USD, both dated in the past so the to-date filter keeps
    // them for good.
    expect(cmp.expectedBillingToDate()).toBeCloseTo((12_000 + 28_500) * 0.92, 6);
    expect(kpi(host(fixture), 'Expected To Date')).toBe('€37,260.00');
    // The billing-plan strip is the same money: BP3's 28,500 USD is Ready.
    expect(cmp.billingKpis().ready).toBeCloseTo(28_500 * 0.92, 6);
    expect(kpi(host(fixture), 'Ready')).toBe('€26,220.00');
  });

  it('converts an actual invoice at its order currency', async () => {
    // The other half of the billing-control strip. An order LINE carries no
    // currency of its own, so the amount is denominated in its parent order's —
    // the same rule finance.util's lineSum applies, and the reason this cannot be
    // read off the line alone.
    const fixture = await render(usdStub({
      getOrders: () => of([{ ...usdOrder, status: 'Invoiced' } as Order]),
    }), 'CT2');
    const cmp = fixture.componentInstance;

    expect(cmp.actualBillingToDate()).toBeCloseTo(120_000 * 0.92, 6);
    expect(kpi(host(fixture), 'Actual To Date')).toBe('€110,400.00');

    // The header-only fallback (an invoiced order with no lines) reads the SAME
    // currency off the order, so it needs its own case — otherwise that branch
    // could stay unconverted with every assertion above still green.
    TestBed.resetTestingModule();
    const headerOnly = await render(usdStub({
      getOrders: () => of([{ ...usdOrder, status: 'Invoiced' } as Order]),
      getOrderLines: () => of([]),
    }), 'CT2');
    expect(headerOnly.componentInstance.actualBillingToDate()).toBeCloseTo(120_000 * 0.92, 6);
  });

  it('leaves a single-currency EUR contract byte-identical — no blanket rescaling', async () => {
    // THE ABSENCE ASSERTION, and what makes the case above non-vacuous. The FX
    // table is present and non-trivial (USD 0.92), but nothing in this fixture is
    // USD, so every figure must be exactly what it was before fxRates was wired
    // in. A fix that multiplied by a rate unconditionally fails here.
    const eurContract: Contract = {
      id: 'CT1', customerId: 'C1', name: 'Acme Framework', type: 'T&M', totalValue: 250_000,
      currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
    };
    const eurProject: Project = {
      id: '1', name: 'Project Alpha', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'In Execution', contractId: 'CT1',
    };
    // Invoiced, so this fixture also exercises the actuals path (actualBillingEvents).
    const eurOrder: Order = { id: 'O1', contractId: 'CT1', type: 'Customer', amount: 200_000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-01-10' };
    const eurLine: OrderLine = { id: 'OL1', orderId: 'O1', projectId: '1', description: 'Phase 1', amount: 200_000 };
    const eurItem: BillingPlanItem = {
      id: 'BP1', contractId: 'CT1', projectId: '1', type: 'Recurring', label: 'Monthly retainer',
      recurrence: 'Monthly', expectedDate: '2026-02-28', issuedDate: '2026-02-28',
      amount: 5_000, currency: 'EUR', status: 'Invoiced',
    };
    // The EUR mirror of BP3, so this fixture exercises BOTH halves of the sum —
    // the converted (Recurring) half and the never-converted as-incurred half.
    const eurTm: BillingPlanItem = {
      id: 'BP1T', contractId: 'CT1', projectId: '1', type: 'TimeAndMaterials', label: 'T&M consuntivo',
      expectedDate: '2026-03-15', amount: 10_000, currency: 'EUR', status: 'Ready',
    };
    const eurEntry: TimeEntry = {
      id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: '1',
      projectId: '1', date: '2026-03-01', hours: 10, status: 'Approved',
    };

    const fixture = await render(usdStub({
      getContracts: () => of([eurContract]),
      getCustomers: () => of([{ id: 'C1', name: 'Acme Co' }]),
      getProjects: () => of([eurProject]),
      getOrders: () => of([eurOrder]),
      getOrderLines: () => of([eurLine]),
      getBillingPlanItems: () => of([eurItem, eurTm]),
      getTimeEntries: () => of([eurEntry]),
      getNegotiatedRates: () => of([]),      // priced at the reference 200 €/h
    }), 'CT1');
    const cmp = fixture.componentInstance;

    // DELIBERATELY no envelope assertion here: this case must pass IDENTICALLY
    // before and after the fix, so every assertion in it has to be one the
    // pre-fix code also satisfies. Checking that `fxRates` is wired in would make
    // it fail pre-fix and destroy exactly the invariance it exists to prove.
    expect(cmp.kpis().revenue).toBeCloseTo(200_000, 6);
    // 5,000 recurring + 10h × 200 €/h = 7,000 — the pre-fix number, unchanged.
    expect(cmp.recognitionSummary().totalRecognized).toBeCloseTo(7_000, 6);
    expect(cmp.expectedBillingToDate()).toBeCloseTo(5_000 + 10_000, 6);
    expect(cmp.actualBillingToDate()).toBeCloseTo(200_000, 6);
    expect(cmp.billingKpis().ready).toBeCloseTo(10_000, 6);
    expect(kpi(host(fixture), 'Order Revenue')).toBe('€200,000.00');
  });

  it('suppresses every money figure when /fx-rates is the ONLY failed read', async () => {
    // A failed /fx-rates read yields [] through the error-to-empty accessor, and
    // an empty rate table makes convertToBase an identity — so without fxRatesRes
    // in the gate the page silently reprints the pre-fix mixed-unit sum under a
    // '€' label, which is worse than the pre-fix state. Drop this.fxRatesRes from
    // recognitionInputs() and this test sees the figures instead of the banner.
    const fixture = await render(usdStub({
      getFxRates: () => throwError(() => new Error('500 fx-rates unavailable')),
    }), 'CT2');
    const cmp = fixture.componentInstance;

    expect(cmp['moneyFiguresState']()).toBe('error');
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Limited data');
    expect(text).not.toContain('Order Revenue');
    expect(text).not.toContain('Total Recognized');
    // The pre-fix unconverted sum must not appear anywhere on the page either.
    expect(text).not.toContain('13,150.00');
    expect(text).toContain('Recognition figures are unavailable');
  });
});

// -----------------------------------------------------------------------------
// The no-revenue margin-% sentinel on a contract page.
//
// finance.util computes marginPct as `revenue > 0 ? … : 0` — a sentinel for
// "undefined", not a measurement. The reachable state here is ordinary rather
// than exotic: a signed contract whose delivery has started before the customer
// order landed earns nothing yet while already carrying labour cost, and the
// page printed "0.0%" for it — break-even, on a project that had only spent.
//
// Both directions are asserted at both sites (the per-project row and the
// contract KPI). One fixture carries both populations: PR has revenue, PN has
// only cost, and they sit under the SAME contract — so a guard that keyed off
// the contract instead of the row would fail the row test.
// -----------------------------------------------------------------------------
describe('ContractDetails — a margin % is rendered only where revenue makes it measurable', () => {
  const CONTRACT: Contract = {
    id: 'CTM', customerId: 'CM', name: 'Mixed', type: 'T&M', totalValue: 50_000,
    currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31',
  };
  const CUSTOMER: Customer = { id: 'CM', name: 'Mixed Co' };
  const EARNING: Project = { id: 'PR', name: 'Earning Project', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', contractId: 'CTM' };
  const UNBILLED: Project = { id: 'PN', name: 'Unbilled Project', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', contractId: 'CTM' };
  const DEV: Resource = { id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, costRate: 100, billRate: 200 };
  const TIME: TimeEntry[] = [
    // PR: 10h x 100 = 1000 of cost.   PN: 20h x 100 = 2000 of cost.
    { id: 'TE-R', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PR', date: '2026-05-01', hours: 10, status: 'Approved' },
    { id: 'TE-N', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PN', date: '2026-05-01', hours: 20, status: 'Approved' },
  ];
  const ORDER: Order = { id: 'OM', contractId: 'CTM', type: 'Customer', amount: 5000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-01-01' };
  /** Imputed to PR ONLY — PN is the project that has not been ordered yet. */
  const LINE: OrderLine = { id: 'OLM', orderId: 'OM', projectId: 'PR', description: 'x', amount: 5000 };

  function stub(overrides: Partial<Record<string, unknown>> = {}): ApiService {
    const empty = () => of([]);
    return {
      getContracts: () => of([CONTRACT]),
      getCustomers: () => of([CUSTOMER]),
      getProjects: () => of([EARNING, UNBILLED]),
      getOrders: () => of([ORDER]),
      getOrderLines: () => of([LINE]),
      getResources: () => of([DEV]),
      getTimeEntries: () => of(TIME),
      getBillingPlanItems: empty,
      getProjectFinancials: empty,
      getRequests: empty,
      getAssignments: empty,
      getNegotiatedRates: empty,
      getFxRates: empty,
      getHoursPerDay: () => of({ value: 8 }),
      ...overrides,
    } as unknown as ApiService;
  }

  async function show(api: ApiService): Promise<ComponentFixture<ContractDetails>> {
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    TestBed.configureTestingModule({
      imports: [ContractDetails],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ContractDetails> = TestBed.createComponent(ContractDetails);
    fixture.componentRef.setInput('id', 'CTM');
    await tick(fixture);
    return fixture;
  }

  /** The margin-% cell of the project row named `label`. */
  function rowPct(fixture: ComponentFixture<ContractDetails>, label: string): string {
    const rows = Array.from(host(fixture).querySelectorAll('tbody tr'));
    const row = rows.find(r => (r.textContent ?? '').includes(label));
    expect(row, `a project row for ${label} must exist`).toBeTruthy();
    const cell = row!.querySelector('[data-test="contract-project-margin-pct"]');
    expect(cell, `${label}'s row must carry a margin-% cell`).not.toBeNull();
    return cell!.textContent ?? '';
  }

  afterEach(() => TestBed.resetTestingModule());

  it('keeps the percentage on the project that HAS revenue', async () => {
    // PR: revenue 5000, cost 1000 -> margin 4000 -> 80.0%.
    expect(rowPct(await show(stub()), 'Earning Project')).toContain('80.0%');
  });

  it('em-dashes the project under the SAME contract that has none', async () => {
    // PN: revenue 0, cost 2000. Before the fix this cell read "0.0%".
    const text = rowPct(await show(stub()), 'Unbilled Project');
    expect(text).toContain('—');
    expect(text).not.toContain('%');
  });

  it('keeps the contract KPI percentage while the contract has billed anything', async () => {
    const fixture = await show(stub());
    // Contract: revenue 5000, margin 4000 - 2000 = 2000 -> 40.0%.
    expect(fixture.componentInstance.kpis().revenue).toBe(5000);
    expect(fixture.componentInstance.kpis().margin).toBe(2000);
    const kpi = host(fixture).querySelector('[data-test="contract-margin-pct"]')?.textContent ?? '';
    expect(kpi).toContain('40.0%');
  });

  it('em-dashes the contract KPI, and drops its danger tint, when nothing has been ordered', async () => {
    // Same cost, no customer order. `margin` is -3000 and `marginPct` the
    // sentinel 0 — so the pre-fix tile showed a NON-negative "0.0%" and, being
    // >= 0, was not even tinted as the loss it is. The tint must not key off
    // the sentinel in either direction.
    const fixture = await show(stub({ getOrders: () => of([]), getOrderLines: () => of([]) }));
    expect(fixture.componentInstance.kpis().revenue).toBe(0);
    expect(fixture.componentInstance.kpis().margin).toBe(-3000);

    const cell = host(fixture).querySelector('[data-test="contract-margin-pct"]');
    expect(cell?.textContent).toContain('—');
    expect(cell?.textContent).not.toContain('%');
    expect(cell!.closest('.command-kpi')!.classList.contains('danger'), 'no percentage means no verdict to tint').toBe(false);

    // Both project rows are unmeasurable now, and both say so.
    expect(rowPct(fixture, 'Earning Project')).toContain('—');
    expect(rowPct(fixture, 'Unbilled Project')).toContain('—');
  });
});
