import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { ProjectClassificationComponent } from './project-classification';
import { ApiService, BillingPlanItem, Project, UserRole } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

/**
 * jsdom PERFORMS NO LAYOUT: nothing here proves a control is visible or
 * reachable at a given width. The disabled/checked/aria contract and the
 * payload ARE structural, and those are what is claimed.
 */

function project(over: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    location: 'Milano', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution',
    ...over,
  };
}

const BILLABLE_WITH_ITEMS = project({ id: '1', name: 'Project Alpha', billable: true, type: 'Delivery' });
const BASKET = project({ id: '3', name: 'BASKET — Engineering Practice', billable: false, type: 'Basket' });
/** No `billable`, no `type` on the wire — the C1-shaped optional-field case. */
const UNSPELLED = project({ id: '5', name: 'Project Gamma' });

const PROJECTS: Project[] = [BILLABLE_WITH_ITEMS, BASKET, UNSPELLED];

function item(id: string, projectId: string, label: string): BillingPlanItem {
  return {
    id, contractId: 'CT1', projectId, type: 'Milestone', label,
    amount: 1000, currency: 'EUR', status: 'Planned',
  };
}

const ITEMS: BillingPlanItem[] = [
  item('BP1', '1', 'SAL Go-Live milestone'),
  item('BP6', '1', 'Progress billing (POC 60%)'),
];

class AuthStub {
  readonly _ready = signal(true);
  readonly authReady = this._ready.asReadonly();
  constructor(private readonly role: UserRole = 'delivery-executive') {}
  hasAnyRole(roles: UserRole[]): boolean { return roles.includes(this.role); }
}

interface Overrides {
  classifyProject?: (id: string, body: { billable: boolean; type: string }) => Observable<Project>;
  billingItems?: () => Observable<BillingPlanItem[]>;
}

function setup(o: Overrides = {}) {
  const classifyProject = vi.fn(o.classifyProject ?? (() => of(BASKET)));
  const api = {
    getProjects: vi.fn(() => of(PROJECTS)),
    getBillingPlanItems: vi.fn(o.billingItems ?? (() => of(ITEMS))),
    classifyProject,
  } as unknown as ApiService;
  const auth = new AuthStub();

  TestBed.configureTestingModule({
    imports: [ProjectClassificationComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
    ],
  });
  return { fixture: TestBed.createComponent(ProjectClassificationComponent), api, auth, classifyProject };
}

async function flush(fixture: ComponentFixture<ProjectClassificationComponent>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function q<T extends HTMLElement>(fixture: ComponentFixture<ProjectClassificationComponent>, test: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-test="${test}"]`);
}

function chooseType(fixture: ComponentFixture<ProjectClassificationComponent>, type: 'Delivery' | 'Basket') {
  const select = q<HTMLSelectElement>(fixture, 'classification-type-select')!;
  select.value = type;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

function toggleBillable(fixture: ComponentFixture<ProjectClassificationComponent>, checked: boolean) {
  const box = q<HTMLInputElement>(fixture, 'classification-billable-input')!;
  box.checked = checked;
  box.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

afterEach(() => TestBed.resetTestingModule());

// ---------------------------------------------------------------------------

describe('ProjectClassificationComponent — the Basket invariant lives IN the control', () => {
  it('locks billability off for Basket, and leaves it live for Delivery', async () => {
    // BOTH DIRECTIONS ON ONE DIALOG. "disabled when Basket" alone passes against
    // a checkbox that is always disabled, which would silently make every
    // engagement unclassifiable as billable.
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();

    chooseType(fixture, 'Basket');
    const locked = q<HTMLInputElement>(fixture, 'classification-billable-input')!;
    expect({
      disabled: locked.disabled,
      checked: locked.checked,
      describedBy: locked.getAttribute('aria-describedby'),
      hint: q(fixture, 'classification-basket-hint')?.textContent?.trim() ?? null,
    }).toStrictEqual({
      disabled: true,
      checked: false,
      describedBy: 'classificationBasketHint',
      hint: 'A Basket engagement is non-billable by definition, so billability is fixed to "no" while Basket is selected.',
    });

    chooseType(fixture, 'Delivery');
    const free = q<HTMLInputElement>(fixture, 'classification-billable-input')!;
    expect({
      disabled: free.disabled,
      describedBy: free.getAttribute('aria-describedby'),
      hintPresent: q(fixture, 'classification-basket-hint') !== null,
    }).toStrictEqual({ disabled: false, describedBy: null, hintPresent: false });
  });

  it('cannot compose Basket + billable, whatever order the two controls are touched in', async () => {
    // THE SERVER ANSWERS 400 TO THIS PAIR. A UI that can assemble it produces a
    // refusal the user did not ask for and cannot see the cause of. The payload
    // is built from the DERIVED value, so the raw choice cannot reach the wire.
    const { fixture, classifyProject } = setup();
    await flush(fixture);
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();

    toggleBillable(fixture, true);   // the user says "billable"...
    chooseType(fixture, 'Basket');   // ...and then picks Basket.
    fixture.componentInstance.save();

    expect(classifyProject).toHaveBeenCalledOnce();
    expect(classifyProject.mock.calls[0]).toStrictEqual(['1', { billable: false, type: 'Basket' }]);
  });

  it('restores the raw choice when Basket is undone, instead of stranding the user on "not billable"', async () => {
    // The twin of the lock: the override is applied at the derived value, not by
    // overwriting what the user picked, so backing out of Basket is not a trap.
    const { fixture, classifyProject } = setup();
    await flush(fixture);
    fixture.componentInstance.openFor(BASKET);
    fixture.detectChanges();

    toggleBillable(fixture, true);
    expect(fixture.componentInstance.billable()).toBe(false); // still Basket
    chooseType(fixture, 'Delivery');
    expect(fixture.componentInstance.billable()).toBe(true);

    fixture.componentInstance.save();
    expect(classifyProject.mock.calls[0]).toStrictEqual(['3', { billable: true, type: 'Delivery' }]);
  });

  it('disables Save until something actually changes', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openFor(BASKET);
    fixture.detectChanges();
    expect(q<HTMLButtonElement>(fixture, 'classification-save')!.disabled).toBe(true);
    expect(q(fixture, 'classification-unchanged-hint')).not.toBeNull();

    chooseType(fixture, 'Delivery');
    expect(q<HTMLButtonElement>(fixture, 'classification-save')!.disabled).toBe(false);
    expect(q(fixture, 'classification-unchanged-hint')).toBeNull();
  });
});

describe('ProjectClassificationComponent — gate 2 (409) is rendered, not toasted', () => {
  const REFUSAL = 'cannot classify this engagement as non-billable: 2 billing plan item(s) still reference it';

  it('names how many items block the flip AND which ones, and keeps the dialog open', async () => {
    const { fixture } = setup({
      classifyProject: () => throwError(() => ({ status: 409, error: { error: REFUSAL } })),
    });
    await flush(fixture);
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();
    chooseType(fixture, 'Basket');
    fixture.componentInstance.save();
    fixture.detectChanges();

    const panel = q(fixture, 'classification-blocked');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain('2 billing plan item(s) still reference it');
    // "What to remove" is the whole content of this refusal; a count alone sends
    // the user to hunt through the billing plan.
    const listed = Array.from(q(fixture, 'classification-blocking-items')!.querySelectorAll('li'))
      .map(li => li.textContent?.trim());
    expect(listed).toStrictEqual([
      'SAL Go-Live milestone — Milestone, Planned',
      'Progress billing (POC 60%) — Milestone, Planned',
    ]);
    expect(fixture.componentInstance.editing()).not.toBeNull();
  });

  it('routes a NON-409 refusal to the ordinary error line, so the 409 panel is not a catch-all', async () => {
    // THE TWIN. Without it, `blocked` could be set on every failure and the
    // "billing plan items block this" panel would appear over refusals that have
    // nothing to do with billing — a confidently wrong explanation.
    const { fixture } = setup({
      classifyProject: () => throwError(() => ({
        status: 400, error: { error: 'a Basket engagement must be non-billable (billable: false)' },
      })),
    });
    await flush(fixture);
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();
    chooseType(fixture, 'Basket');
    fixture.componentInstance.save();
    fixture.detectChanges();

    expect(q(fixture, 'classification-blocked')).toBeNull();
    expect(q(fixture, 'classification-error')?.textContent).toContain('must be non-billable');
  });

  it('warns before the click when the pending flip would be refused, and stays quiet when it would not', async () => {
    const { fixture } = setup();
    await flush(fixture);

    // (a) A billable engagement with two items, being flipped to non-billable.
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();
    chooseType(fixture, 'Basket');
    expect(q(fixture, 'classification-precheck')?.textContent)
      .toContain('2 billing plan item(s) still reference this engagement');
    // Deliberately a WARNING and not a disabled Save: the server owns this rule,
    // and a client-side gate would either drift from it or hide it.
    expect(q<HTMLButtonElement>(fixture, 'classification-save')!.disabled).toBe(false);

    // (b) Same flip, an engagement with no items: nothing to warn about.
    fixture.componentInstance.close();
    fixture.detectChanges();
    fixture.componentInstance.openFor(UNSPELLED);
    fixture.detectChanges();
    chooseType(fixture, 'Basket');
    expect(q(fixture, 'classification-precheck')).toBeNull();

    // (c) The same engagement WITH items, staying billable: also nothing, because
    //     the gate is about non-billability and not about having items.
    fixture.componentInstance.close();
    fixture.detectChanges();
    fixture.componentInstance.openFor(BILLABLE_WITH_ITEMS);
    fixture.detectChanges();
    chooseType(fixture, 'Delivery');
    toggleBillable(fixture, true);
    expect(q(fixture, 'classification-precheck')).toBeNull();
  });
});

describe('ProjectClassificationComponent — the table', () => {
  it('spells billability as a word, so colour is never the only signal', async () => {
    const { fixture } = setup();
    await flush(fixture);
    expect(q(fixture, 'classification-billable-1')?.textContent?.trim()).toBe('Billable');
    expect(q(fixture, 'classification-billable-3')?.textContent?.trim()).toBe('Not billable');
    expect(q(fixture, 'classification-type-3')?.textContent?.trim()).toBe('Basket');
  });

  it('reads an ABSENT billable/type defensively as billable Delivery', async () => {
    // The optional-on-the-wire case (same shape as C1's `Resource.kind`). Reading
    // it as anything but billable would switch a project's margin alerts off for
    // no reason other than a field the backend did not spell out.
    const { fixture } = setup();
    await flush(fixture);
    expect(q(fixture, 'classification-billable-5')?.textContent?.trim()).toBe('Billable');
    expect(q(fixture, 'classification-type-5')?.textContent?.trim()).toBe('Delivery');
  });

  it('counts the billing plan items per engagement', async () => {
    const { fixture } = setup();
    await flush(fixture);
    expect([
      q(fixture, 'classification-items-1')?.textContent?.trim(),
      q(fixture, 'classification-items-3')?.textContent?.trim(),
    ]).toStrictEqual(['2', '0']);
  });

  it('survives a failing billing-plan read, and says "unknown" rather than "none"', async () => {
    // TWO defects in one test, and the second is the subtle one.
    //
    // (1) The item count is an aid, not the subject: tying the table to that read
    //     would take the screen down for a reason unrelated to classifying. The
    //     failure is caught in the stream, so value() never throws.
    // (2) Having caught it, the count must not fall back to 0. "0 items" is a
    //     claim about the engagement; the truth here is that we do not know, and
    //     0 is exactly the reassuring answer that would send someone to flip an
    //     engagement they then cannot flip.
    const { fixture } = setup({ billingItems: () => throwError(() => new Error('boom')) });
    await flush(fixture);
    expect(q(fixture, 'classification-row-1')).not.toBeNull();
    expect(q(fixture, 'classification-items-1')?.textContent?.trim()).toBe('—');
    expect(q(fixture, 'classification-items-unavailable')).not.toBeNull();

    // THE TWIN: a healthy read prints real numbers and no banner, so "—" is a
    // signal and not this column's permanent contents.
    TestBed.resetTestingModule();
    const healthy = setup();
    await flush(healthy.fixture);
    expect(q(healthy.fixture, 'classification-items-1')?.textContent?.trim()).toBe('2');
    expect(q(healthy.fixture, 'classification-items-unavailable')).toBeNull();
  });

  it('reads nothing before the OIDC bootstrap settles, and reads once it does', async () => {
    const { fixture, api, auth } = setup();
    auth._ready.set(false);
    await flush(fixture);
    expect(api.getProjects).not.toHaveBeenCalled();

    auth._ready.set(true);
    await flush(fixture);
    expect(api.getProjects).toHaveBeenCalled();
  });
});
