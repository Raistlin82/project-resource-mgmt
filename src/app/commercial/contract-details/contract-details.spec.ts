import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ContractDetails } from './contract-details';
import {
  ApiService,
  BillingPlanItem,
  Contract,
  Customer,
  NegotiatedRate,
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
