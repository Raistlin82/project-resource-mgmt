import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ManageCostCentersComponent } from './manage-cost-centers.component';
import { ApiService, CostCenter, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';

const COST_CENTERS: CostCenter[] = [
  { id: 'CC1', name: 'Engineering & Dev', manager: 'Marco Bianchi', allocated: 100000, actual: 75000 },
];

function setup(items: CostCenter[] = COST_CENTERS) {
  const apiStub = {
    getCostCenters: vi.fn(() => of(items)),
    getResources: vi.fn(() => of([] as Resource[])),
    createCostCenter: vi.fn(() => of({} as CostCenter)),
    updateCostCenter: vi.fn(() => of({} as CostCenter)),
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
  return { fixture };
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
