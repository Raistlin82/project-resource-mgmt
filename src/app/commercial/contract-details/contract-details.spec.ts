import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
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
    // Reference billRate (1500) is ABOVE the negotiated rate (1000) — the
    // resolved figure must reflect the negotiated price, not the reference.
    const resource: Resource = {
      id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
      externalExperience: [], utilization: 80, capacity: 40, billRate: 1500,
    };
    const entry: TimeEntry = {
      id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: 'R1',
      projectId: 'P2', date: '2026-05-01', hours: 10, status: 'Approved',
    };
    const item: BillingPlanItem = {
      id: 'BP1', contractId: 'CT2', projectId: 'P2', type: 'TimeAndMaterials',
      label: 'T&M', amount: 0, currency: 'EUR', status: 'Ready',
    };
    const rate: NegotiatedRate = { id: 'nr1', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 1000 };

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
    // (10h x 1000 = 10,000), not the reference (10h x 1500 = 15,000).
    const resolvedText = host(fixture).textContent ?? '';
    expect(resolvedText).toContain('Total Recognized');
    expect(resolvedText).toMatch(/10,000\.00/);
    expect(resolvedText).not.toMatch(/15,000\.00/);
  });
});
