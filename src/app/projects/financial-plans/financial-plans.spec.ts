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

  /**
   * The labelled KPI wrapper carries `aria-label` but had no `role`, so the name was
   * dropped by the accessible-name computation entirely: the region was nameless and
   * its three tiles announced as loose text. Asserted as the PAIR — a role-less
   * labelled div is the defect, and either half alone would let it back in.
   */
  it('gives the labelled KPI region a role, so its aria-label is a permitted accessible name', async () => {
    const fixture = await setup(of([{ id: 'F1', projectId: 'P1', category: 'Delivery', budget: 100, actual: 25 }]));
    await tick(fixture);

    const region = host(fixture).querySelector('[aria-label="Financial plan metrics"]');
    expect(region).toBeTruthy();
    expect(region!.getAttribute('role')).toBe('group');
    // ABSENCE TWIN: no labelled-but-role-less element may remain in this template —
    // the scan the register describes, applied to this one screen.
    expect(host(fixture).querySelector('div[aria-label]:not([role])')).toBeNull();
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

/**
 * A budget line IS the project's budget: `budgetForProject` sums these rows, so
 * deleting one moves Burn %, Variance at Completion, `deliveryHealth()`'s red
 * threshold, /reporting's Margin & Variance row and the eacOverBudget alert — and
 * the figure is displayed nowhere afterwards. The DELETE used to fire on the first
 * click of a 24px icon with no dialog and no undo.
 */
describe('Financial Plans — deleting a budget line is confirmed, never fired on the first click', () => {
  const ROW: FinancialItem = { id: 'F1', projectId: 'P1', category: 'Delivery', budget: 30_000, actual: 12_000 };
  const OTHER: FinancialItem = { id: 'F2', projectId: 'P1', category: 'Licences', budget: 12_500, actual: 0 };

  function deleteButton(fixture: ComponentFixture<FinancialPlans>): HTMLButtonElement {
    const button = host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Delete the Delivery budget line"]');
    expect(button).toBeTruthy();
    return button!;
  }

  it('the row control ARMS a dialog and issues no DELETE; the dialog names the category, the amount and the resulting budget', async () => {
    const deleteProjectFinancial = vi.fn(() => of(void 0));
    const fixture = await setup(of([ROW, OTHER]), { deleteProjectFinancial } as unknown as Partial<ApiService>);
    await tick(fixture);

    deleteButton(fixture).click();
    await tick(fixture);

    // THE ABSENCE ASSERTION, and the one the pre-fix code fails outright.
    expect(deleteProjectFinancial).not.toHaveBeenCalled();

    const dialog = host(fixture).querySelector('[data-test="financial-plan-delete-confirm"]');
    expect(dialog).toBeTruthy();
    const text = dialog!.textContent ?? '';
    // The category AND the figure — a bare "Are you sure?" must not pass.
    expect(text).toContain('Delivery');
    expect(text).toContain('€30,000');
    // The consequence as a number: 42,500 of total budget becomes 12,500.
    expect(text).toContain('€12,500');
    // ABSENCE TWIN for that consequence: quoting the CURRENT total instead of the
    // post-delete one would be the plausible wrong number, and it is the one figure
    // that makes the sentence useless.
    expect(text).not.toContain('€42,500');
    // 2-decimal rule: no long float may reach the copy.
    expect(text).not.toMatch(/\d\.\d{3,}/);
  });

  it('only the dialog’s own control issues the DELETE, exactly once, for the armed row', async () => {
    const deleteProjectFinancial = vi.fn(() => of(void 0));
    const fixture = await setup(of([ROW, OTHER]), { deleteProjectFinancial } as unknown as Partial<ApiService>);
    await tick(fixture);

    deleteButton(fixture).click();
    await tick(fixture);
    host(fixture).querySelector<HTMLButtonElement>('[data-test="financial-plan-delete-confirm-action"]')!.click();
    await tick(fixture);

    expect(deleteProjectFinancial).toHaveBeenCalledTimes(1);
    expect(deleteProjectFinancial).toHaveBeenCalledWith('F1'); // the armed row, not the other one
    expect(host(fixture).querySelector('[data-test="financial-plan-delete-confirm"]')).toBeNull();
  });

  it('Cancel disarms it: the dialog closes and NOTHING is deleted', async () => {
    // The other absence twin. Without it, a confirm that deletes on open — or on
    // either button — would pass the two cases above.
    const deleteProjectFinancial = vi.fn(() => of(void 0));
    const fixture = await setup(of([ROW, OTHER]), { deleteProjectFinancial } as unknown as Partial<ApiService>);
    await tick(fixture);

    deleteButton(fixture).click();
    await tick(fixture);
    const cancel = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('[data-test="financial-plan-delete-confirm"] button'))
      .find(b => (b.textContent ?? '').trim() === 'Cancel');
    expect(cancel).toBeTruthy();
    cancel!.click();
    await tick(fixture);

    expect(deleteProjectFinancial).not.toHaveBeenCalled();
    expect(host(fixture).querySelector('[data-test="financial-plan-delete-confirm"]')).toBeNull();
    // The row survives the cancelled delete.
    expect(host(fixture).textContent ?? '').toContain('Delivery');
  });
});
