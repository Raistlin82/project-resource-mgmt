import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ManageIndustriesComponent } from './manage-industries.component';
import { ApiService, Industry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

const INDUSTRIES: Industry[] = [{ id: 'I1', name: 'Technology' }];

function setup(items: Industry[] = INDUSTRIES) {
  const apiStub = {
    getIndustries: vi.fn(() => of(items)),
    createIndustry: vi.fn(() => of({} as Industry)),
    updateIndustry: vi.fn(() => of({} as Industry)),
    deleteIndustry: vi.fn(() => of(undefined as unknown as void)),
  } as unknown as ApiService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageIndustriesComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
    ],
  });

  const fixture = TestBed.createComponent(ManageIndustriesComponent);
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

describe('ManageIndustriesComponent form overlay — STRUCTURAL contract only (jsdom performs no layout)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('declares its own scroller, a top anchor and a bounded panel whose body scrolls', async () => {
    // THE DEFECT: `flex items-center` on a POSITION:FIXED overlay splits any surplus
    // height above and below the centre, so once the panel exceeds the viewport the
    // header goes above y=0 and the "Save Industry" footer below the fold — and a
    // fixed box cannot be scrolled by the page, nor did the overlay have a scroller of
    // its own. This panel is short today, so the reachable failure is 200% browser
    // zoom (which halves the effective viewport) rather than a stock 320x568 phone;
    // the contract is the same one the taller siblings needed.
    //
    // jsdom CAN prove these class tokens sit on the right elements. It CANNOT prove
    // the clipping: it performs no layout, offsetHeight is 0 and there is no viewport.
    // Only a real browser could assert the submit button's rect stays inside the
    // viewport, and this repo has no browser runner.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const overlay = host.querySelector<HTMLElement>('[data-test="industry-form-overlay"]')!;
    const panel = host.querySelector<HTMLElement>('[data-test="industry-form-panel"]')!;
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

    const form = (fixture.nativeElement as HTMLElement).querySelector<HTMLFormElement>('[data-test="industry-form-panel"] form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit!.textContent?.trim()).toBe('Save Industry');
  });

  it('rejects a plain centred overlay — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The predicate must discriminate a scroll-safe overlay from a
    // clipping one, or it is a class-string tautology. The control is a REAL element
    // rendered by this very component: the delete confirmation, which deliberately
    // keeps the plain centred overlay. Its className is exactly what the FORM overlay
    // carried before the fix, so a predicate that passed it would pass the defect.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.deleteItem('I1');
    fixture.detectChanges();

    const control = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="industry-delete-overlay"]')!;
    const panel = control.querySelector<HTMLElement>('.command-card')!;
    const verdict = scrollSafety(control, panel);
    expect(verdict.overlayScrolls).toBe(false);
    expect(verdict.anchoredOnShortViewports).toBe(false);
    expect(verdict.panelBounded).toBe(false);
  });
});
