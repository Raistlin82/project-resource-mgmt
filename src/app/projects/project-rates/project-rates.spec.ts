import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ProjectRates } from './project-rates';
import { ApiService, NegotiatedRate, Project, ProjectRole, Resource } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open — not needed
 * here since every stub below resolves synchronously, but microtask ticks are
 * still the established idiom (contract-details.spec.ts) for letting an
 * already-synchronous `rxResource` read reach the DOM before asserting.
 */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

describe('ProjectRates — inherited vs override (Task 5)', () => {
  const project: Project = {
    id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
  };
  const resource: Resource = {
    id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 80, capacity: 40, billRate: 1200,
  };
  const contractRate: NegotiatedRate = { id: 'NR1', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 1000 };
  /**
   * The project-roles CATALOG — the authority the SERVER validates a rate's role
   * against (validateRoleRefs, src/server.ts). 'Project Manager' is in it and is
   * held by NO resource above, which is the whole point: a sell rate is
   * negotiated BEFORE anyone with that profile is hired.
   */
  const projectRoles: ProjectRole[] = [
    { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
    { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false },
  ];

  function baseStub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getProjects: () => of([project]),
      getResources: () => of([resource]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => of([contractRate]),
      getProjectRoles: () => of(projectRoles),
      ...overrides,
    } as unknown as ApiService;
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<ProjectRates>> {
    const authStub = { authReady: signal(true), canManageCommercial: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ProjectRates],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ProjectRates> = TestBed.createComponent(ProjectRates);
    fixture.componentRef.setInput('projectId', 'P2');
    await tick(fixture);
    return fixture;
  }

  it('shows the contract rate greyed out on a project that does not override it', async () => {
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const inherited = h.querySelectorAll('[data-test="inherited-rate"]');
    expect(inherited.length).toBe(1);
    expect(inherited[0].textContent).toContain('Developer');
    // Rendered through `number:'1.0-2'` (two-decimal display rule) — locale grouping applies.
    expect(inherited[0].textContent).toContain('1,000');
    // Greyed: the row carries the muted styling, not the plain default row.
    expect(inherited[0].className).toContain('text-ink-muted');
  });

  it('shows the project override instead of the inherited row once one exists', async () => {
    const override: NegotiatedRate = { id: 'NR2', projectId: 'P2', role: 'Developer', currency: 'EUR', billRate: 1150 };
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([contractRate, override]) }));
    const h = host(fixture);

    // The paired absence assertion: no inherited marker once an override exists.
    expect(h.querySelectorAll('[data-test="inherited-rate"]').length).toBe(0);

    const overrideRows = h.querySelectorAll('[data-test="project-rate-row"]');
    expect(overrideRows.length).toBe(1);
    expect(overrideRows[0].textContent).toContain('Developer');
    // Rendered through `number:'1.0-2'` (two-decimal display rule) — locale grouping applies.
    expect(overrideRows[0].textContent).toContain('1,150');
  });

  it('surfaces the server refusal without closing the form', async () => {
    const createSpy = vi.fn().mockReturnValue(
      throwError(() => ({ error: { error: 'a negotiated rate already exists for this key (existing id NR2)' } })),
    );
    const fixture = await setUp(baseStub({ createNegotiatedRate: createSpy }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Override'));
    expect(addButton).toBeTruthy();
    addButton!.click();
    await tick(fixture);

    const roleSelect = h.querySelector<HTMLSelectElement>('#projectRateRole');
    expect(roleSelect).toBeTruthy();
    roleSelect!.value = 'Developer';
    roleSelect!.dispatchEvent(new Event('change'));

    const billRateInput = h.querySelector<HTMLInputElement>('#projectRateBillRate');
    expect(billRateInput).toBeTruthy();
    billRateInput!.value = '900';
    billRateInput!.dispatchEvent(new Event('input'));
    await tick(fixture);

    const saveButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Rate');
    expect(saveButton).toBeTruthy();
    saveButton!.click();
    await tick(fixture);

    // The form must still be open, and the exact server message rendered.
    expect(h.querySelector('#projectRateRole')).toBeTruthy();
    const errorEl = h.querySelector('[data-test="negotiated-rate-error"]');
    expect(errorEl?.textContent).toContain('a negotiated rate already exists for this key (existing id NR2)');
  });

  it('opens the plain "Add Override" entry point with no role pre-selected (Task 5 review, Finding 2)', async () => {
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Override'));
    addButton!.click();
    await tick(fixture);

    // Defaulting to roleOptions()[0] let a user save a rate keyed to the wrong role
    // without ever touching the field — the select must open on the placeholder.
    const roleSelect = h.querySelector<HTMLSelectElement>('#projectRateRole');
    expect(roleSelect!.value).toBe('');
  });

  it('still pre-fills the role when "Add Override" is seeded from an inherited row', async () => {
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const editInheritedButton = h.querySelector<HTMLButtonElement>('[aria-label="Override rate for Developer"]');
    expect(editInheritedButton).toBeTruthy();
    editInheritedButton!.click();
    await tick(fixture);

    const roleSelect = h.querySelector<HTMLSelectElement>('#projectRateRole');
    expect(roleSelect!.value).toBe('Developer');
  });

  /**
   * FINAL REVIEW, finding 2 — the tab renders unconditionally
   * (project-details.ts's tab strip sits OUTSIDE its `@if (project(); as p)`),
   * so it can be shown with NO resolved project: a deep link to a project id
   * that does not exist, or the tick before the ungated getProjects() read
   * lands. `projectId` is `input<string>()` with no default, i.e. `undefined` —
   * and a CONTRACT-level rate has no `projectId` either, so a filter written as
   * `r.projectId === this.projectId()` matched `undefined === undefined` and
   * claimed every contract-scoped rate in the system as THIS project's own
   * override: green "Override" badge, live edit, and a delete button wired to
   * the real contract rate's id. Membership must be decided by the FIELD, never
   * by two absences agreeing.
   */
  async function setUpWithoutProjectId(apiStub: ApiService): Promise<ComponentFixture<ProjectRates>> {
    const authStub = { authReady: signal(true), canManageCommercial: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ProjectRates],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    // projectId is deliberately NEVER set — the phantom-project case.
    const fixture: ComponentFixture<ProjectRates> = TestBed.createComponent(ProjectRates);
    await tick(fixture);
    return fixture;
  }

  it('claims NO contract-level rate as an override when there is no project (final review, finding 2)', async () => {
    const fixture = await setUpWithoutProjectId(baseStub());
    const h = host(fixture);

    // The contract rate must not appear as this project's own row...
    expect(h.querySelectorAll('[data-test="project-rate-row"]').length).toBe(0);
    // ...nor as an inherited one (no project => no contract to inherit from)...
    expect(h.querySelectorAll('[data-test="inherited-rate"]').length).toBe(0);
    // ...and above all, no DELETE aimed at a real contract rate's id.
    expect(h.querySelector('[aria-label="Delete override for Developer"]')).toBeNull();
    expect(h.textContent).toContain('No negotiated rates apply to this project');
  });

  it('claims NO contract-level rate as an override for a project id that does not exist', async () => {
    const fixture = await setUp(baseStub());
    fixture.componentRef.setInput('projectId', 'NOPE');
    await tick(fixture);
    const h = host(fixture);

    expect(h.querySelectorAll('[data-test="project-rate-row"]').length).toBe(0);
    expect(h.querySelectorAll('[data-test="inherited-rate"]').length).toBe(0);
  });

  it('offers every catalog role, including one no resource holds (final review, finding 5)', async () => {
    // The server was widened THIS wave to accept any project-roles catalog role,
    // precisely so a price can be negotiated before anyone with that profile is
    // hired — and docs/functional/commercial.md now describes that workflow. A
    // picker built from `resources.map(r => r.role)` makes it unreachable from
    // the UI: the only way to create such a rate would be to hand-post to the API.
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Override'));
    addButton!.click();
    await tick(fixture);

    const options = [...h.querySelectorAll<HTMLOptionElement>('#projectRateRole option')].map(o => o.value);
    expect(options).toContain('Developer');
    expect(options).toContain('Project Manager');   // in the catalog, held by nobody
  });

  it('offers only the base currency even when the FX catalog carries others (P1-12)', async () => {
    // sellRateFor reads nothing but a BASE_CURRENCY row, so an FX-driven picker
    // offered a save that was guaranteed to move no revenue. Existing non-EUR
    // rows are still RENDERED (with the "Not applied" badge, asserted below) —
    // only creating a new one is closed off.
    //
    // THE FX ROWS ARE THE POINT. baseStub()'s default is `getFxRates: () => of([])`,
    // and the reverted implementation was
    // `[...new Set([BASE_CURRENCY, ...fxRates.map(r => r.currency)])]` — which over
    // an EMPTY list is also ['EUR']. So without a non-EUR row injected here this
    // test passed identically before and after the fix it was written for.
    // contract-details.spec.ts:215 gets this right; this is the same shape.
    const fixture = await setUp(baseStub({
      getFxRates: () => of([
        { currency: 'EUR', rateToBase: 1 },
        { currency: 'USD', rateToBase: 0.91 },
        { currency: 'GBP', rateToBase: 1.17 },
      ]),
    }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Override'));
    addButton!.click();
    await tick(fixture);

    const currencies = [...h.querySelectorAll<HTMLOptionElement>('#projectRateCurrency option')].map(o => o.value);
    expect(currencies).toEqual(['EUR']);
  });

  it('flags a non-EUR rate as not applied, since sellRateFor only ever reads EUR (Task 5 review, Finding 1)', async () => {
    const usdOverride: NegotiatedRate = { id: 'NR3', projectId: 'P2', role: 'Developer', currency: 'USD', billRate: 950 };
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([contractRate, usdOverride]) }));
    const h = host(fixture);

    // The EUR contract row is still shown, inherited, alongside the USD override —
    // (role, currency) pairing means neither hides the other.
    const inherited = h.querySelectorAll('[data-test="inherited-rate"]');
    expect(inherited.length).toBe(1);
    expect(inherited[0].textContent).not.toContain('Not applied');

    const overrideRows = h.querySelectorAll('[data-test="project-rate-row"]');
    expect(overrideRows.length).toBe(1);
    expect(overrideRows[0].textContent).toContain('Not applied');
  });
});
