import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NEVER, Observable, of } from 'rxjs';
import { ManageRateCardsComponent } from './manage-rate-cards.component';
import { ApiService, RateCard, ProjectRole, ResourceOrganization, FxRate } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * Same shape used across this block's other specs (resources.component.spec.ts,
 * manage-resource-organizations.component.spec.ts): Engineering (capability,
 * id '2') > Platform (practice, id '5') > Backend (competence, id '6'), plus
 * Consulting (id '3'), an unrelated capability with no children of its own —
 * so the sort/indentation logic has a case that must NOT be nested under
 * Engineering by mistake.
 */
const ORG_NODES: ResourceOrganization[] = [
  { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
  { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
  { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
  { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
];

const ROLES: ProjectRole[] = [{ id: 'r1', code: 'Developer', name: 'Developer', description: '', restricted: false }];

function setup(orgNodes: ResourceOrganization[] = ORG_NODES, items: RateCard[] = []) {
  const getRateCards = vi.fn(() => of(items));
  const getProjectRoles = vi.fn(() => of(ROLES));
  const getResourceOrganizations = vi.fn(() => of(orgNodes));
  const getFxRates = vi.fn(() => of([] as FxRate[]));
  const getHoursPerDay = vi.fn(() => of({ value: 8 }));
  const createRateCard = vi.fn(() => of({} as RateCard));
  const updateRateCard = vi.fn(() => of({} as RateCard));
  const deleteRateCard = vi.fn(() => of(undefined));
  const apiStub = {
    getRateCards, getProjectRoles, getResourceOrganizations, getFxRates, getHoursPerDay,
    createRateCard, updateRateCard, deleteRateCard,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageRateCardsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageRateCardsComponent);
  return { fixture, getRateCards, createRateCard, updateRateCard, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ManageRateCardsComponent', () => {
  describe('organization select hierarchy indentation (rate-card-inheritance block, Task 5)', () => {
    it('orders a capability before its practice before its competence', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const names = fixture.componentInstance.indentedOrgOptions().map(o => o.node.name);
      const engineeringIdx = names.indexOf('Engineering');
      const platformIdx = names.indexOf('Platform');
      const backendIdx = names.indexOf('Backend');
      expect(engineeringIdx).toBeGreaterThanOrEqual(0);
      expect(engineeringIdx).toBeLessThan(platformIdx);
      expect(platformIdx).toBeLessThan(backendIdx);
    });

    it('assigns depth 0/1/2 to capability/practice/competence respectively', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const byName = new Map(fixture.componentInstance.indentedOrgOptions().map(o => [o.node.name, o.depth]));
      expect(byName.get('Engineering')).toBe(0);
      expect(byName.get('Platform')).toBe(1);
      expect(byName.get('Backend')).toBe(2);
      // Consulting is ALSO a capability (no parent) -- depth 0, not accidentally
      // inheriting a nonzero depth from its position later in the list.
      expect(byName.get('Consulting')).toBe(0);
    });

    it('renders the indentation as a visual prefix, scoped to the org select only', async () => {
      const { fixture } = setup();
      await flush(fixture);
      fixture.componentInstance.openForm();
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const options = [...host.querySelectorAll<HTMLOptionElement>('#rc-org option')];
      const engineeringOpt = options.find(o => o.value === 'Engineering');
      const backendOpt = options.find(o => o.value === 'Backend');
      expect(engineeringOpt).toBeTruthy();
      expect(backendOpt).toBeTruthy();
      // Backend (depth 2) must carry strictly more leading indentation than
      // Engineering (depth 0) -- the pair to the depth assertions above, now
      // checked against what actually renders, scoped to THIS select only.
      const leadingWs = (t: string | null) => (t ?? '').match(/^\s*/)?.[0].length ?? 0;
      expect(leadingWs(backendOpt!.textContent)).toBeGreaterThan(leadingWs(engineeringOpt!.textContent));
    });
  });

  describe('non-blocking conflict warning on save (rate-card-inheritance block, Task 6)', () => {
    /** An existing card on Engineering (an ancestor of Platform/Backend). */
    const CARD_ON_ENGINEERING: RateCard[] = [
      { id: 'ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 640, billRate: 1200 },
    ];
    /** An existing card on Backend (a descendant of Platform/Engineering). */
    const CARD_ON_BACKEND: RateCard[] = [
      { id: 'BACK', role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 },
    ];

    function fillAndSave(fixture: ReturnType<typeof setup>['fixture'], organization: string) {
      const c = fixture.componentInstance;
      c.openForm();
      c.form.controls.role.setValue('Developer');
      c.form.controls.organization.setValue(organization);
      c.form.controls.currency.setValue('EUR');
      c.form.controls.costRate.setValue(660);
      c.form.controls.billRate.setValue(1250);
      c.save();
    }

    it('shows an info toast when saving a card whose node has an ancestor with a card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(notifyStub.show).toHaveBeenCalledWith(expect.stringContaining('This role already has a card on Engineering'), 'info');
    });

    it('shows an info toast when saving a card whose node has a descendant with its own card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_BACKEND);
      await flush(fixture);
      fillAndSave(fixture, 'Engineering');
      expect(notifyStub.show).toHaveBeenCalledWith(expect.stringContaining('This role already has a card on Backend'), 'info');
    });

    it('does NOT show the conflict toast when saving a generic card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, ''); // generic -- no organization
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });

    it('does NOT show the conflict toast when there is no conflict at all', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, []); // no existing cards anywhere
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });

    it('never blocks the save when a conflict is detected', async () => {
      const { fixture, createRateCard } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(createRateCard).toHaveBeenCalled();
      expect(fixture.componentInstance.showForm()).toBe(false); // form closed -- save proceeded
    });

    it('editing a card to move it does not false-positive warn about its own pre-edit position', async () => {
      // Round-1 review (Important 2): this.items() is the stale pre-reload
      // cache, so on an edit it still holds the OLD copy of the very card
      // being saved -- conflictingCardMessage has no id parameter to
      // self-exclude by. The card being edited itself sits on Backend;
      // moving it to Platform must NOT warn "this role already has a card on
      // Backend" about itself. This is the ONLY test in this block that
      // exercises the edit branch of save() -- every other test here calls
      // openForm() with no argument (create path only).
      const cardToMove: RateCard = { id: 'MOVE', role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 };
      const { fixture, notifyStub, updateRateCard } = setup(ORG_NODES, [cardToMove]);
      await flush(fixture);
      const c = fixture.componentInstance;
      c.openForm(cardToMove); // EDIT path -- editingId() becomes 'MOVE'
      c.form.controls.organization.setValue('Platform');
      c.save();
      expect(updateRateCard).toHaveBeenCalledWith('MOVE', expect.objectContaining({ organization: 'Platform' }));
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });
  });
});

describe('ManageRateCardsComponent form overlay — STRUCTURAL contract only (jsdom performs no layout)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * The scroll-safety predicate, evaluated on TOKENS rather than on the raw class
   * string. 'items-center' is a substring of 'sm:items-center', so a
   * `className.includes()` check would be satisfied by the very class that has to
   * go — the class-string form of the trap where toContain('0%') matches '100%'.
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

  it('declares its own scroller, a top anchor and a bounded panel whose body scrolls', async () => {
    // THE DEFECT: this panel needs ~508px and a 320x568 phone leaves ~460px of
    // visual viewport. `flex items-center` on a POSITION:FIXED overlay split the
    // ~48px surplus above and below the centre, so the header went above y=0 and
    // the "Save Rate Card" footer below the fold — and a fixed box cannot be
    // scrolled by the page, nor did the overlay have a scroller of its own. The
    // admin could fill the card in and never save it.
    //
    // jsdom CAN prove these class tokens sit on the right elements. It CANNOT prove
    // the clipping: it performs no layout, offsetHeight is 0 and there is no
    // viewport. The height arithmetic above is only demonstrable in a real browser
    // (320x460, submit button's getBoundingClientRect().bottom <= innerHeight), and
    // this repo has no browser runner.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const overlay = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="rate-card-form-overlay"]')!;
    const panel = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="rate-card-form-panel"]')!;
    expect(scrollSafety(overlay, panel)).toStrictEqual({
      overlayScrolls: true,
      anchoredOnShortViewports: true,
      panelBounded: true,
      bodyScrolls: true,
    });
    // Spelled out separately from the object comparison, because 'sm:items-center'
    // is the half that keeps the panel centred on a normal viewport — dropping it
    // would leave every desktop dialog stuck to the top edge.
    expect(overlay.className.split(/\s+/)).toContain('sm:items-center');
  });

  it('rejects a plain centred overlay — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The predicate above must discriminate a scroll-safe overlay
    // from a clipping one, or it is a class-string tautology. The control is a REAL
    // element rendered by this very component: the delete confirmation, a short
    // warning dialog (icon + title + two lines + footer) that fits the ~460px a
    // 320x568 phone leaves and therefore deliberately keeps the plain centred
    // overlay. Its className is exactly what the FORM overlay carried before the
    // fix — `fixed inset-0 ... flex items-center justify-center z-50 p-4` — so a
    // predicate that passed it would pass the defect.
    const { fixture } = setup(ORG_NODES, [
      { id: 'RC1', role: 'Developer', organization: '', currency: 'EUR', costRate: 600, billRate: 1120 },
    ]);
    await flush(fixture);

    fixture.componentInstance.deleteItem('RC1');
    fixture.detectChanges();

    const control = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="rate-card-delete-overlay"]')!;
    const panel = control.querySelector<HTMLElement>('.command-card')!;
    const verdict = scrollSafety(control, panel);
    expect(verdict.overlayScrolls).toBe(false);
    expect(verdict.anchoredOnShortViewports).toBe(false);
    expect(verdict.panelBounded).toBe(false);
  });
});

describe('ManageRateCardsComponent responsive table pan port', () => {
  afterEach(() => TestBed.resetTestingModule());

  const tokens = (element: Element): string[] => element.className.split(/\s+/).filter(Boolean);

  it('keeps all columns and actions in a labelled keyboard-scrollable region', async () => {
    const { fixture } = setup(ORG_NODES, [
      { id: 'RC1', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 600, billRate: 1120 },
    ]);
    await flush(fixture);
    const rendered = fixture.nativeElement as HTMLElement;
    const region = rendered.querySelector<HTMLElement>('[data-test="rate-cards-table-scroll"]')!;
    const table = region.querySelector<HTMLTableElement>('table')!;
    const hint = rendered.querySelector<HTMLElement>(`#${region.getAttribute('aria-describedby')}`)!;
    const headers = table.querySelectorAll<HTMLElement>('thead th');
    const cells = table.querySelectorAll<HTMLElement>('tbody tr:first-child td');

    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Rate cards table');
    expect(region.tabIndex).toBe(0);
    expect(tokens(region)).toEqual(expect.arrayContaining([
      'overflow-x-auto', 'overscroll-x-contain', 'outline-none', 'focus-visible:ring-2',
    ]));
    expect(hint.textContent).toContain('Swipe horizontally');
    expect(tokens(hint)).toContain('lg:hidden');
    expect(table.className).toContain('min-w-[');
    expect(headers).toHaveLength(6);
    expect(tokens(headers[0])).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface-muted!']));
    expect(tokens(headers[5])).toEqual(expect.arrayContaining(['sticky', 'right-0', 'bg-surface-muted!']));
    expect(tokens(cells[0])).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface!']));
    expect(tokens(cells[5])).toEqual(expect.arrayContaining(['sticky', 'right-0', 'bg-surface!']));

    for (const action of cells[5].querySelectorAll('button')) {
      expect(tokens(action)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
    }
  });

  it('includes role and organization in repeated action names', async () => {
    const { fixture } = setup(ORG_NODES, [
      { id: 'RC1', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 600, billRate: 1120 },
    ]);
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[aria-label="Edit rate card for Developer, Engineering"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Delete rate card for Developer, Engineering"]')).not.toBeNull();
  });

  it('stacks the header and paired rate fields at 320px, while keeping dialog controls reachable', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const rendered = fixture.nativeElement as HTMLElement;
    const header = rendered.querySelector<HTMLElement>('[data-test="rate-cards-header"]')!;

    expect(tokens(header)).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
    expect(tokens(header)).not.toContain('flex-row');

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const rateGrid = rendered.querySelector<HTMLElement>('[data-test="rate-card-rate-grid"]')!;
    const actions = rendered.querySelector<HTMLElement>('[data-test="rate-card-form-actions"]')!;
    const close = rendered.querySelector<HTMLElement>('[data-test="rate-card-close"]')!;
    expect(tokens(rateGrid)).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
    expect(tokens(rateGrid)).not.toContain('grid-cols-2');
    expect(tokens(actions)).toContain('flex-wrap');
    expect(tokens(close)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
  });
});

describe('ManageRateCardsComponent working-hours-per-day field', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * Deliberately NOT reusing setup()'s `of({ value: 8 })`: 8 is also the
   * rxResource defaultValue, so a stub emitting 8 cannot tell "the configured
   * value arrived" from "the placeholder was latched". The fixture value must
   * differ from the default or the test proves nothing.
   */
  function setupHpd(hoursPerDay: Observable<{ value: number }>) {
    const getHoursPerDay = vi.fn(() => hoursPerDay);
    const apiStub = {
      getRateCards: vi.fn(() => of([] as RateCard[])),
      getProjectRoles: vi.fn(() => of([] as ProjectRole[])),
      getResourceOrganizations: vi.fn(() => of([] as ResourceOrganization[])),
      getFxRates: vi.fn(() => of([] as FxRate[])),
      getHoursPerDay,
      setHoursPerDay: vi.fn(() => of({ value: 0 })),
      createRateCard: vi.fn(() => of({} as RateCard)),
      updateRateCard: vi.fn(() => of({} as RateCard)),
      deleteRateCard: vi.fn(() => of(undefined)),
    } as unknown as ApiService;
    TestBed.configureTestingModule({
      imports: [ManageRateCardsComponent],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService },
        { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
      ],
    });
    const fixture = TestBed.createComponent(ManageRateCardsComponent);
    return { fixture, component: fixture.componentInstance };
  }

  const hpdInput = (fixture: { nativeElement: HTMLElement }) =>
    fixture.nativeElement.querySelector('input[aria-label="Working hours per day"]') as HTMLInputElement;
  const saveButton = (fixture: { nativeElement: HTMLElement }) =>
    Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find(b => (b as HTMLElement).textContent?.trim() === 'Save') as HTMLButtonElement;

  it('shows the CONFIGURED value, not the placeholder', async () => {
    // THE DEFECT: authGatedResource emits its defaultValue {value: 8} while
    // authReady is false, and that emission is RESOLVED, not loading. The seeding
    // effect latched 8, and its own `hoursPerDay() == null` guard then blocked 7.5
    // from ever landing. Pressing Save wrote 8 over 7.5 — a 6.25% shift on every
    // €/day → €/hour conversion in billing, margins and reporting.
    const { fixture, component } = setupHpd(of({ value: 7.5 }));
    await flush(fixture);
    expect(component.hoursPerDay()).toBe(7.5);
    expect(hpdInput(fixture).value).toBe('7.5');
  });

  it('leaves the field empty and Save disabled until the read settles', async () => {
    // ASSERTION OF ABSENCE. Without it, a fix that merely lets a later value
    // overwrite the placeholder still shows 8 — and still lets the admin SAVE 8 —
    // during the whole pre-settled window. Both halves matter: an implementation
    // that blanks the field but leaves Save enabled writes null/8 on a click.
    const { fixture, component } = setupHpd(NEVER);
    // NOT flush(): whenStable() never resolves while a resource is still loading,
    // which is the whole point of this case. Change detection alone is not enough
    // either — `[disabled]` on an element carrying `ngModel` binds NgModel's OWN
    // `disabled` input, and NgModel applies it through `control.disable()` on a
    // resolved promise, so the DOM property lands one microtask later.
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    expect(component.hoursPerDay()).toBeNull();
    expect(component.hoursPerDaySettled()).toBe(false);
    expect(hpdInput(fixture).disabled).toBe(true);
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('lets the admin CLEAR the field — the seeding effect must not write it back', async () => {
    // A defect that survived the placeholder fix, on the adjacent lines. The effect
    // read `hoursPerDay()` inside its own reactive scope, so it consumed the signal it
    // writes; the input binds one-way and Angular's NumberValueAccessor emits null for
    // an empty box, so backspacing the field to empty re-triggered the effect, satisfied
    // its own `== null` guard and wrote 7.5 straight back. The field was un-clearable:
    // an admin could not type a new number without knowing to select-all first.
    const { fixture, component } = setupHpd(of({ value: 7.5 }));
    await flush(fixture);
    expect(component.hoursPerDay()).toBe(7.5);

    // Exactly what the template does when the input goes empty.
    component.hoursPerDay.set(null);
    await flush(fixture);

    expect(component.hoursPerDay()).toBeNull();
    // The signal and the rendered value are written by different mechanisms, so the
    // DOM read is the half that proves the USER sees an empty box.
    expect(hpdInput(fixture).value).toBe('');
    // Save must be disabled — but for the VALIDITY reason, not the readiness one.
    expect(component.hoursPerDaySettled()).toBe(true);
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('seeds once, so a later refetch does not overwrite an edit in progress', async () => {
    // ASSERTION OF ABSENCE: the one-shot latch must not be satisfiable by simply
    // never seeding again after ANY write — it must still seed the first time (proved
    // above) and must not clobber a deliberate user value afterwards.
    const { fixture, component } = setupHpd(of({ value: 7.5 }));
    await flush(fixture);
    component.hoursPerDay.set(6);
    await flush(fixture);
    expect(component.hoursPerDay()).toBe(6);
  });

  it('re-enables both controls once the value has arrived', async () => {
    // The mirror of the case above: a permanently-disabled field would satisfy it.
    const { fixture } = setupHpd(of({ value: 7.5 }));
    await flush(fixture);
    expect(hpdInput(fixture).disabled).toBe(false);
    expect(saveButton(fixture).disabled).toBe(false);
  });
});
