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

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /financial-plans route and a
// tab panel inside project-details, which renders its own h1 (the project name).
// `headingLevel` is the one mechanism all eight embeddable panels use; the twin
// of these cases — that /projects/:id still has exactly ONE h1 with a panel open
// — lives in project-details.spec.ts.
// ---------------------------------------------------------------------------

/** Class tokens, SPLIT — never a className substring check. 'text-3xl' is a
 *  substring of 'sm:text-3xl', so a substring test cannot tell the responsive
 *  variant from the base one. */
function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

/** The heading — at whatever level — whose trimmed text is exactly `text`. */
function headingFor(fixture: ComponentFixture<FinancialPlans>, text: string): HTMLElement {
  const el = Array.from(host(fixture).querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find(h => h.textContent?.trim() === text);
  expect(el, `a heading reading "${text}" must be rendered`).toBeTruthy();
  return el!;
}

describe('FinancialPlans — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Financial Plans';
  const LINE: FinancialItem = { id: 'F1', projectId: 'P1', category: 'Delivery', budget: 10_000, actual: 2_500 };

  /** The /financial-plans route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<FinancialPlans> {
    const api = {
      getProjects: () => of([]),
      getCostCategories: () => of([]),
      getProjectFinancials: () => of([LINE]),
    } as unknown as ApiService;
    TestBed.configureTestingModule({
      imports: [FinancialPlans],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { authReady: signal(true), canApproveFinancials: signal(true) } },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.createComponent(FinancialPlans);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<FinancialPlans> {
    const fixture = renderStandalone();
    fixture.componentRef.setInput('projectId', 'P1');
    fixture.componentRef.setInput('headingLevel', 2);
    return fixture;
  }

  it('standalone: EXACTLY ONE h1, and it carries the screen title', async () => {
    const fixture = renderStandalone();
    await tick(fixture);
    // RED before the fix: 0 — the title was an h2 and the route had no h1 at all.
    // COUNTED, not looked up: querySelector('h1') would also pass with two, and
    // this panel renders three more headings (its KPI labels) besides the title.
    const h1s = host(fixture).querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(TITLE);
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — the absence twin', async () => {
    const fixture = renderEmbedded();
    await tick(fixture);
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
    expect(headingFor(fixture, TITLE).tagName).not.toBe('H3');
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).toBeNull();
    // The panel really rendered its budget line, so the count is not vacuous.
    expect(host(fixture).textContent ?? '').toContain('Delivery');
  });

  it('the title keeps the type scale it had in each state (class TOKENS read from the source — jsdom loads no stylesheet and computes no size)', async () => {
    const standalone = renderStandalone();
    await tick(standalone);
    expect(classTokens(headingFor(standalone, TITLE))).toEqual(
      expect.arrayContaining(['text-2xl', 'sm:text-3xl', 'tracking-tight']),
    );
    TestBed.resetTestingModule();

    const embedded = renderEmbedded();
    await tick(embedded);
    // This panel's embedded title is font-semibold, not the font-bold its
    // siblings use; each state keeps exactly the styling it already had.
    const embeddedTokens = classTokens(headingFor(embedded, TITLE));
    expect(embeddedTokens).toEqual(expect.arrayContaining(['text-lg', 'font-semibold']));
    expect(embeddedTokens).not.toContain('text-2xl');
    expect(embeddedTokens).not.toContain('sm:text-3xl');
  });
});
