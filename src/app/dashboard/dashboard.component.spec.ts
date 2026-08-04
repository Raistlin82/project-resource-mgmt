import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { ApiService, UserRole } from '../services/api.service';
import { AuthService } from '../services/auth.service';

const DASHBOARD_METHODS = [
  'getFxRates',
  'getResources',
  'getRequests',
  'getProjects',
  'getAssignments',
  'getOrders',
  'getOrderLines',
  'getProjectFinancials',
  'getTimeEntries',
  'getBillingPlanItems',
  'getProjectIssues',
  'getChangeRequests',
  'getContracts',
  'getNegotiatedRates',
] as const;

function makeApiStub(): Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>> {
  return Object.fromEntries(DASHBOARD_METHODS.map(name => [name, vi.fn(() => of([]))])) as
    Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>>;
}

function makeAuthStub(role: UserRole) {
  const canView = ['finance', 'delivery-executive', 'admin'].includes(role);
  return {
    authReady: signal(true),
    role: signal(role),
    canViewPortfolioDashboard: computed(() => canView),
    canManageStaffing: computed(() => ['pm', 'resource-manager', 'delivery-executive', 'admin'].includes(role)),
    canReadCommercial: computed(() => ['sales', 'finance', 'delivery-executive', 'admin'].includes(role)),
  };
}

async function render(role: UserRole) {
  const api = makeApiStub();
  TestBed.configureTestingModule({
    imports: [DashboardComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
    ],
  });
  const fixture = TestBed.createComponent(DashboardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api };
}

describe('Dashboard capability-aware loading', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a self-service workspace without firing portfolio endpoints for employee', async () => {
    const { fixture, api } = await render('employee');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).not.toHaveBeenCalled();
    }
    expect(fixture.nativeElement.textContent).toContain('My workspace');
    expect(fixture.nativeElement.textContent).not.toContain('Portfolio Financials');
  });

  it('does not treat sales commercial access as authorization for finance dashboard data', async () => {
    const { api } = await render('sales');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).not.toHaveBeenCalled();
    }
  });

  it('loads the complete portfolio dataset only for a portfolio reader', async () => {
    const { api } = await render('finance');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).toHaveBeenCalledOnce();
    }
  });
});
