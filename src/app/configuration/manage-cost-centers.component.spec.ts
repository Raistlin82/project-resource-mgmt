import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { ManageCostCentersComponent } from './manage-cost-centers.component';
import { ApiService, CostCenter, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';

const COST_CENTERS: CostCenter[] = [
  { id: 'CC1', name: 'Engineering & Dev', manager: 'Marco Bianchi', allocated: 100000, actual: 75000 },
];

function setup(items: CostCenter[] = COST_CENTERS) {
  const createCostCenter = vi.fn(() => of({} as CostCenter));
  const updateCostCenter = vi.fn(() => of({} as CostCenter));
  const apiStub = {
    getCostCenters: vi.fn(() => of(items)),
    getResources: vi.fn(() => of([] as Resource[])),
    createCostCenter,
    updateCostCenter,
    deleteCostCenter: vi.fn(() => of(undefined as unknown as void)),
  } as unknown as ApiService;
  // This screen's read is gated on authReady AND canApproveFinancials — a stub
  // missing the capability would render an empty table and no overlay at all.
  const authStub = {
    authReady: signal(true),
    isAuthenticated: signal(true),
    canApproveFinancials: signal(true),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageCostCentersComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageCostCentersComponent);
  return { fixture, createCostCenter, updateCostCenter };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/**
 * The scroll-safety predicate, evaluated on TOKENS rather than on the raw class
 * string. 'items-center' is a substring of 'sm:items-center', so a
 * `className.includes()` check would be satisfied by the very class that has to go
 * — the class-string form of the trap where toContain('0%') matches '100%'.
 * Identical to the landed helper in manage-rate-cards.component.spec.ts.
 */
function scrollSafety(overlay: HTMLElement, panel: HTMLElement) {
  const overlayTokens = overlay.className.split(/\s+/);
  const body = panel.querySelector<HTMLElement>('form > div');
  return {
    overlayScrolls: overlayTokens.includes('overflow-y-auto'),
    anchoredOnShortViewports: overlayTokens.includes('items-start') && !overlayTokens.includes('items-center'),
    panelBounded: /max-h-\[/.test(panel.className),
    bodyScrolls: !!body && body.className.split(/\s+/).includes('overflow-y-auto'),
  };
}

describe('ManageCostCentersComponent form overlay — STRUCTURAL contract only (jsdom performs no layout)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('declares its own scroller, a top anchor and a bounded panel whose body scrolls', async () => {
    // THE DEFECT: four fields plus a header and footer, and a 320x568 phone leaves
    // ~460px of visual viewport. `flex items-center` on a POSITION:FIXED overlay
    // split the surplus above and below the centre, so the header went above y=0 and
    // the "Save Cost Center" footer below the fold — and a fixed box cannot be
    // scrolled by the page, nor did the overlay have a scroller of its own. The admin
    // could fill the form in and never submit it.
    //
    // jsdom CAN prove these class tokens sit on the right elements. It CANNOT prove
    // the clipping: it performs no layout, offsetHeight is 0 and there is no viewport.
    // Only a real browser at 320x460 could assert the submit button's
    // getBoundingClientRect().bottom <= innerHeight, and this repo has no browser
    // runner (no playwright dependency or script in package.json).
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const overlay = host.querySelector<HTMLElement>('[data-test="cost-center-form-overlay"]')!;
    const panel = host.querySelector<HTMLElement>('[data-test="cost-center-form-panel"]')!;
    expect(scrollSafety(overlay, panel)).toStrictEqual({
      overlayScrolls: true,
      anchoredOnShortViewports: true,
      panelBounded: true,
      bodyScrolls: true,
    });
    // Spelled out separately from the object comparison, because 'sm:items-center' is
    // the half that keeps the panel centred on a normal viewport — dropping it would
    // leave every desktop dialog stuck to the top edge.
    expect(overlay.className.split(/\s+/)).toContain('sm:items-center');
  });

  it('keeps the submit control inside the form element, so Enter still submits', async () => {
    // ABSENCE TWIN for the restructure: moving the footer OUT of the <form> to pin it
    // would satisfy every class-token assertion above while silently removing implicit
    // submission — the keyboard path the register explicitly says still works today.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const form = (fixture.nativeElement as HTMLElement).querySelector<HTMLFormElement>('[data-test="cost-center-form-panel"] form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit!.textContent?.trim()).toBe('Save Cost Center');
  });

  it('rejects a plain centred overlay — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The predicate must discriminate a scroll-safe overlay from a
    // clipping one, or it is a class-string tautology. The control is a REAL element
    // rendered by this very component: the delete confirmation, a short warning dialog
    // that fits the ~460px a 320x568 phone leaves and therefore deliberately keeps the
    // plain centred overlay. Its className is exactly what the FORM overlay carried
    // before the fix, so a predicate that passed it would pass the defect.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.deleteCostCenter('CC1');
    fixture.detectChanges();

    const control = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="cost-center-delete-overlay"]')!;
    const panel = control.querySelector<HTMLElement>('.command-card')!;
    const verdict = scrollSafety(control, panel);
    expect(verdict.overlayScrolls).toBe(false);
    expect(verdict.anchoredOnShortViewports).toBe(false);
    expect(verdict.panelBounded).toBe(false);
  });
});

describe('ManageCostCentersComponent responsive table pan port', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps all columns and actions in a labelled keyboard-scrollable region', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const region = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="cost-centers-table-scroll"]')!;
    const table = region.querySelector<HTMLTableElement>('table')!;

    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Cost centers table');
    expect(region.tabIndex).toBe(0);
    expect(region.className.split(/\s+/)).toContain('overflow-x-auto');
    expect(table.className).toContain('min-w-[');
    expect(table.querySelectorAll('thead th')).toHaveLength(5);
  });
});

describe('ManageCostCentersComponent resilient form flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  const validValue = {
    name: 'Operations', manager: 'Giulia Verdi', allocated: 50000, actual: 20000,
  };

  it('keeps invalid submit actionable, exposes required errors and focuses the first invalid field', async () => {
    const { fixture, createCostCenter } = setup();
    await flush(fixture);
    fixture.componentInstance.openForm();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    expect(submit.disabled).toBe(false);
    submit.click();
    await flush(fixture);

    const name = host.querySelector<HTMLInputElement>('#costCenterName')!;
    const manager = host.querySelector<HTMLSelectElement>('#costCenterManager')!;
    expect(fixture.componentInstance.form.controls.name.touched).toBe(true);
    expect(fixture.componentInstance.form.controls.manager.touched).toBe(true);
    expect(name.required).toBe(true);
    expect(name.getAttribute('aria-describedby')).toBe('costCenterNameError');
    expect(manager.required).toBe(true);
    expect(manager.getAttribute('aria-describedby')).toBe('costCenterManagerError');
    expect(document.activeElement).toBe(name);
    expect(createCostCenter).not.toHaveBeenCalled();
  });

  it('asks before Cancel, backdrop or Escape can discard a dirty form', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openForm();
    fixture.componentInstance.form.controls.name.setValue('Changed');
    fixture.componentInstance.form.controls.name.markAsDirty();
    fixture.detectChanges();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const overlay = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLElement>('[data-test="cost-center-form-overlay"]')!;

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    const cancel = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Cancel')!;
    cancel.click();
    fixture.detectChanges();

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(fixture.componentInstance.showForm()).toBe(true);
    confirm.mockReturnValue(true);
    cancel.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.showForm()).toBe(false);
  });

  it('blocks duplicate submit and dismiss while the save is pending', async () => {
    const pending = new Subject<CostCenter>();
    const { fixture, createCostCenter } = setup();
    createCostCenter.mockReturnValue(pending);
    await flush(fixture);
    fixture.componentInstance.openForm();
    fixture.componentInstance.form.setValue(validValue);
    fixture.detectChanges();

    fixture.componentInstance.saveCostCenter();
    fixture.componentInstance.saveCostCenter();
    fixture.componentInstance.closeForm();
    fixture.detectChanges();
    const overlay = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLElement>('[data-test="cost-center-form-overlay"]')!;
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(createCostCenter).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.saving()).toBe(true);
    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(overlay.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);

    pending.next({ id: 'CC2', ...validValue });
    pending.complete();
    fixture.detectChanges();
    expect(fixture.componentInstance.showForm()).toBe(false);
  });

  it('keeps an API failure and the entered values in the form for retry', async () => {
    const { fixture, createCostCenter } = setup();
    createCostCenter
      .mockReturnValueOnce(throwError(() => ({ error: { error: 'Cost center code conflicts with an existing record.' } })))
      .mockReturnValueOnce(of({ id: 'CC2', ...validValue }));
    await flush(fixture);
    fixture.componentInstance.openForm();
    fixture.componentInstance.form.setValue(validValue);

    fixture.componentInstance.saveCostCenter();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(fixture.componentInstance.form.controls.name.value).toBe('Operations');
    expect(host.querySelector('#costCenterSaveError')?.textContent).toContain('conflicts');
    expect(fixture.componentInstance.saving()).toBe(false);

    fixture.componentInstance.saveCostCenter();
    fixture.detectChanges();
    expect(createCostCenter).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.showForm()).toBe(false);
  });

  it('distinguishes a filtered-empty search and offers Clear filters', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.search.set('no-match');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('No cost centers match your search.');

    const clear = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Clear filters')!;
    clear.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.search()).toBe('');
    expect(host.textContent).toContain('Engineering & Dev');
  });

  it('labels a genuinely empty source without presenting filter recovery', async () => {
    const { fixture } = setup([]);
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('No cost centers defined yet.');
    expect(host.textContent).not.toContain('No cost centers match your search.');
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Clear filters')).toBe(false);
  });
});
