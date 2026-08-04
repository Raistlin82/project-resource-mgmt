import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { FinancialPlans } from './financial-plans';
import { ApiService, FinancialItem } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: ComponentFixture<FinancialPlans>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

async function tick(fixture: ComponentFixture<FinancialPlans>, microtasks = 6): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

async function setup(
  financials: Observable<FinancialItem[]>,
  overrides: Partial<ApiService> = {},
): Promise<ComponentFixture<FinancialPlans>> {
  const api = {
    getProjects: () => of([]),
    getCostCategories: () => of([]),
    getProjectFinancials: () => financials,
    ...overrides,
  } as unknown as ApiService;
  TestBed.configureTestingModule({
    imports: [FinancialPlans],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { authReady: signal(true), canApproveFinancials: signal(true) } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(FinancialPlans);
  fixture.componentRef.setInput('projectId', 'P1');
  return fixture;
}

describe('Financial Plans KPI correctness', () => {
  it('uses the reporting base currency and styles a negative Remaining as critical', async () => {
    const fixture = await setup(of([{
      id: 'F1', projectId: 'P1', category: 'Delivery', budget: 100, actual: 150,
    }]));
    await fixture.whenStable();
    fixture.detectChanges();

    const text = host(fixture).textContent ?? '';
    expect(text).toContain('€100');
    expect(text).not.toContain('$100');
    const remainingHeading = Array.from(host(fixture).querySelectorAll('.command-kpi-label'))
      .find(element => element.textContent?.trim() === 'Remaining');
    const remainingCard = remainingHeading?.closest('.command-kpi');
    expect(remainingCard?.classList.contains('danger')).toBe(true);
    expect(remainingCard?.classList.contains('green')).toBe(false);
  });

  it('withholds KPI values while financial data is pending', async () => {
    const pending = new Subject<FinancialItem[]>();
    const fixture = await setup(pending as Observable<FinancialItem[]>);
    await tick(fixture);

    expect(host(fixture).querySelector('[aria-label="Financial plan metrics"]')).toBeNull();
    expect(host(fixture).textContent).toContain('Loading financial plans');
    pending.next([]);
    pending.complete();
  });

  it('shows a retryable error instead of evaluating zero/partial KPIs', async () => {
    const fixture = await setup(throwError(() => new Error('financials unavailable')));
    await tick(fixture);

    expect(host(fixture).querySelector('[aria-label="Financial plan metrics"]')).toBeNull();
    expect(host(fixture).querySelector('[role="alert"]')?.textContent).toContain('financial plans');
  });

  it('keeps the form and its values open until a save succeeds', async () => {
    const pendingSave = new Subject<FinancialItem>();
    const fixture = await setup(of([]), {
      createProjectFinancial: vi.fn(() => pendingSave),
    });
    await tick(fixture);

    fixture.componentInstance.openForm();
    fixture.componentInstance.finForm.setValue({ category: 'Delivery', budget: 100, actual: 25 });
    fixture.componentInstance.savePlan();
    fixture.detectChanges();

    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(fixture.componentInstance.finForm.getRawValue()).toEqual({
      category: 'Delivery', budget: 100, actual: 25,
    });

    pendingSave.error({ error: { error: 'Budget conflicts with the approved plan' } });
    await tick(fixture);
    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(fixture.componentInstance.finForm.getRawValue().category).toBe('Delivery');
    expect(host(fixture).querySelector('[role="alert"]')?.textContent).toContain('Budget conflicts');
  });
});
