import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ProjectPartners } from './project-partners';
import { ApiService, Partner, PartnerRole, Project, Vendor } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Microtask ticks, not whenStable(): whenStable HANGS while an rxResource stream
 *  is open. Same idiom as project-issues.spec.ts. */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const PROJECT: Project = {
  id: 'P1', name: 'Project One', location: 'Berlin',
  startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution',
};

const PARTNER: Partner = {
  id: 'PT1', projectId: 'P1', company: 'Northwind Consulting',
  role: 'Implementation Subcontractor', contact: 'Jane Doe', status: 'Active',
};

const VENDORS: Vendor[] = [{ id: 'V1', name: 'Northwind Consulting' } as Vendor];
const ROLES: PartnerRole[] = [{ id: 'PR1', name: 'Implementation Subcontractor' } as PartnerRole];

type ApiOverrides = Partial<Record<string, unknown>>;

function makeApiStub(overrides: ApiOverrides = {}) {
  const base: Record<string, (...args: never[]) => unknown> = {
    getProjects: () => of([PROJECT]),
    getProjectPartners: () => of([PARTNER]),
    getVendors: () => of(VENDORS),
    getPartnerRoles: () => of(ROLES),
    createProjectPartner: () => of(PARTNER),
    deleteProjectPartner: () => of(undefined),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService & Record<string, ReturnType<typeof vi.fn>>;
}

async function render(overrides: ApiOverrides = {}) {
  const api = makeApiStub(overrides);
  TestBed.configureTestingModule({
    imports: [ProjectPartners],
    providers: [
      { provide: ApiService, useValue: api },
      // authReady() MUST be true: every authGatedResource here otherwise stays on its
      // empty default and the partner row never renders.
      { provide: AuthService, useValue: { authReady: () => true } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture: ComponentFixture<ProjectPartners> = TestBed.createComponent(ProjectPartners);
  fixture.componentRef.setInput('projectId', 'P1');
  await tick(fixture);
  return { fixture, api };
}

function removeButton(fixture: ComponentFixture<ProjectPartners>): HTMLButtonElement {
  const btn = host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="Remove ${PARTNER.company}"]`);
  expect(btn, 'the row remove button must be rendered').toBeTruthy();
  return btn!;
}

function confirmRegion(fixture: ComponentFixture<ProjectPartners>): HTMLElement | null {
  return host(fixture).querySelector<HTMLElement>('[data-test="partner-remove-confirm"]');
}

/**
 * The copy predicate, kept as a function so the SAME predicate can be pointed at
 * the generic string this dialog used to carry. "Are you sure you want to remove X
 * from this project? This action cannot be undone." named the object but said
 * nothing the PM could weigh — which is why `statesTaskReference` is the assertion
 * that actually moved.
 */
function namesObjectAndConsequence(text: string) {
  return {
    namesCompany: text.includes(PARTNER.company),
    namesRole: text.includes(PARTNER.role),
    namesContact: text.includes(PARTNER.contact),
    statesTaskReference: /no longer resolves/i.test(text) && /raw partner id/i.test(text),
    statesNoUndo: /cannot be undone/i.test(text),
  };
}

describe('ProjectPartners — the remove confirm states what leaves with the row', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the FIRST click issues no deleteProjectPartner and names the company, its role, its contact and the dangling task reference', async () => {
    // THE DEFECT (the copy half): the confirm step was already here, but it read
    // "Are you sure you want to remove <company> from this project? This action
    // cannot be undone." What actually leaves is this project's only record of the
    // engagement — role and key contact — and every subcontractor task still
    // pointing at this partner keeps a partnerId that no longer resolves, so
    // project-tasks.ts:409-411 prints the raw id in place of the company name.
    const { fixture, api } = await render();

    expect(confirmRegion(fixture), 'nothing may be armed before the first click').toBeNull();

    removeButton(fixture).click();
    await tick(fixture);

    expect(api.deleteProjectPartner).not.toHaveBeenCalled();

    const dialog = confirmRegion(fixture);
    expect(dialog, 'the confirm dialog must be armed').toBeTruthy();
    expect(namesObjectAndConsequence(dialog!.textContent ?? '')).toStrictEqual({
      namesCompany: true,
      namesRole: true,
      namesContact: true,
      statesTaskReference: true,
      statesNoUndo: true,
    });
  });

  it('rejects the old generic copy — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The control is the EXACT string this dialog shipped before the
    // change, so a predicate that passed it would have passed the defect. Note it
    // satisfies namesCompany and statesNoUndo: those two halves alone would have made
    // the test green with nothing fixed.
    expect(namesObjectAndConsequence(
      `Are you sure you want to remove ${PARTNER.company} from this project? This action cannot be undone.`,
    )).toStrictEqual({
      namesCompany: true,
      namesRole: false,
      namesContact: false,
      statesTaskReference: false,
      statesNoUndo: true,
    });
  });

  it('only the confirm control issues the DELETE, and exactly once', async () => {
    const { fixture, api } = await render();
    removeButton(fixture).click();
    await tick(fixture);

    const confirm = confirmRegion(fixture)!.querySelector<HTMLButtonElement>('[data-test="partner-remove-confirm-action"]')!;
    confirm.click();
    await tick(fixture);

    expect(api.deleteProjectPartner).toHaveBeenCalledTimes(1);
    expect(api.deleteProjectPartner).toHaveBeenCalledWith('PT1');
  });

  it('MUST STILL let Cancel abandon the removal, leaving no request and no armed dialog', async () => {
    const { fixture, api } = await render();
    removeButton(fixture).click();
    await tick(fixture);

    const cancel = Array.from(confirmRegion(fixture)!.querySelectorAll<HTMLButtonElement>('button'))
      .find(b => b.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await tick(fixture);

    expect(api.deleteProjectPartner).not.toHaveBeenCalled();
    expect(confirmRegion(fixture)).toBeNull();
  });
});

describe('ProjectPartners — the invite dialog survives a refused POST', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the dialog open and all three picked values when the POST is refused', async () => {
    // THE DEFECT: closeForm() ran unconditionally right after firing the POST, so
    // partnerForm.reset() wiped the vendor, the role and the key contact while the
    // request was still in flight.
    const { fixture } = await render({
      createProjectPartner: () => throwError(() => new HttpErrorResponse({
        status: 400, error: { error: 'partner already invited' },
      })),
    });
    const component = fixture.componentInstance;

    component.openForm();
    component.partnerForm.setValue({
      company: 'Northwind Consulting', role: 'Implementation Subcontractor', contact: 'Jane Doe',
    });
    component.savePartner();
    await tick(fixture);

    expect(component.showForm()).toBe(true);
    expect(component.partnerForm.getRawValue()).toStrictEqual({
      company: 'Northwind Consulting', role: 'Implementation Subcontractor', contact: 'Jane Doe',
    });
    // The refusal is stated INLINE, because error toasts in this app auto-dismiss and
    // a dialog left open with a vanished toast is an unexplained refusal.
    const inline = host(fixture).querySelector<HTMLElement>('[data-test="partner-save-error"]');
    expect(inline?.textContent).toContain('partner already invited');
  });

  it('MUST STILL close and reset when the POST is accepted', async () => {
    // The assertion of ABSENCE: "never close the dialog" passes the case above and
    // fails here.
    const { fixture } = await render();
    const component = fixture.componentInstance;

    component.openForm();
    component.partnerForm.setValue({
      company: 'Northwind Consulting', role: 'Implementation Subcontractor', contact: 'Jane Doe',
    });
    component.savePartner();
    await tick(fixture);

    expect(component.showForm()).toBe(false);
    expect(component.partnerForm.controls.company.value).toBeNull();
    expect(host(fixture).querySelector('[data-test="partner-save-error"]')).toBeNull();
  });
});
