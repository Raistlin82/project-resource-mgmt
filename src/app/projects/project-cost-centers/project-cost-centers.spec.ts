import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ProjectCostCenters } from './project-cost-centers';
import { ApiService, CostCenter, Project, ProjectCostCenter } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Microtask ticks, the repo idiom for a synchronous rxResource (project-rates.spec.ts). */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

/**
 * The dialog used to close and `reset()` unconditionally, right after firing the
 * request. The 400 this picker invited — 'project cost center CC-1001 already
 * exists', because a catalog entry attached to ANOTHER project was still offered —
 * therefore landed on an already-cleared form, so the typed budget and manager were
 * gone and had to be retyped with no way to see which project held CC-1001.
 *
 * CC-1001 is a real seed row (src/db/seed.ts:695 attaches it to project '1';
 * :738 is the same id in the catalog), so these cases exercise the shipped data.
 */
describe('ProjectCostCenters — a refused save must not discard what was typed', () => {
  const project: Project = {
    id: '9', name: 'Project Nine', location: 'Rome', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'In Execution', ownerId: 'R1',
  };
  /** Attached to project '1', NOT to project '9' — the duplicate-id trap. */
  const takenElsewhere: ProjectCostCenter = {
    id: 'CC-1001', projectId: '1', name: 'Engineering & Dev', manager: 'Alice Smith',
    allocated: 150000, actual: 125000,
  };
  const catalog: CostCenter[] = [
    { id: 'CC-1001', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
    { id: 'CC-1002', name: 'Quality Assurance', manager: 'Bob Ray', allocated: 90000, actual: 10000 },
  ];

  function baseStub(overrides: Record<string, unknown> = {}) {
    return {
      getProjects: () => of([project]),
      getResources: () => of([]),
      getCostCenters: () => of(catalog),
      getProjectCostCenters: () => of([takenElsewhere]),
      createProjectCostCenter: vi.fn(() => of(takenElsewhere)),
      updateProjectCostCenter: vi.fn(() => of(takenElsewhere)),
      ...overrides,
    } as unknown as ApiService & { createProjectCostCenter: ReturnType<typeof vi.fn> };
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<ProjectCostCenters>> {
    const authStub = { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ProjectCostCenters],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ProjectCostCenters> = TestBed.createComponent(ProjectCostCenters);
    fixture.componentRef.setInput('projectId', '9');
    await tick(fixture);
    return fixture;
  }

  /** Fill the create form exactly as the UI does: pick an id, then derive the name. */
  function fillCreateForm(component: ProjectCostCenters, id: string, budget: number): void {
    component.openForm();
    component.ccForm.controls.id.setValue(id);
    component.onCostCenterPicked();
    component.ccForm.controls.allocatedBudget.setValue(budget);
    component.ccForm.controls.manager.setValue('Sam Cole');
  }

  afterEach(() => TestBed.resetTestingModule());

  it('keeps the dialog open and the typed budget intact when the server refuses a duplicate id', async () => {
    const createSpy = vi.fn(() => throwError(() => new HttpErrorResponse({
      status: 400,
      error: { error: 'project cost center CC-1001 already exists' },
    })));
    const fixture = await setUp(baseStub({ createProjectCostCenter: createSpy }));
    const component = fixture.componentInstance;

    fillCreateForm(component, 'CC-1001', 250000);
    component.saveCostCenter();
    await tick(fixture);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(component.showForm()).toBe(true);
    expect(component.ccForm.controls.allocatedBudget.value).toBe(250000);
    // The manager was equally retype-able, and equally must survive.
    expect(component.ccForm.controls.manager.value).toBe('Sam Cole');
    // Error toasts auto-dismiss in this app, so the refusal is rendered inline —
    // otherwise an open dialog with a vanished toast is an unexplained refusal.
    expect(host(fixture).querySelector('[data-test="cost-center-save-error"]')?.textContent)
      .toContain('project cost center CC-1001 already exists');
  });

  /**
   * THE PAIRED ASSERTION OF ABSENCE. Without it, 'never close the dialog' passes the
   * case above — so the committing path has to be proven to still close and reset.
   */
  it('closes the dialog and clears the budget once the save actually succeeds', async () => {
    const created: ProjectCostCenter = {
      id: 'CC-1002', projectId: '9', name: 'Quality Assurance', manager: 'Sam Cole',
      allocated: 250000, actual: 0,
    };
    const createSpy = vi.fn(() => of(created));
    const fixture = await setUp(baseStub({ createProjectCostCenter: createSpy }));
    const component = fixture.componentInstance;

    fillCreateForm(component, 'CC-1002', 250000);
    component.saveCostCenter();
    await tick(fixture);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(component.showForm()).toBe(false);
    expect(component.ccForm.controls.allocatedBudget.value).toBe(0);
    expect(host(fixture).querySelector('[data-test="cost-center-save-error"]')).toBeNull();
  });

  it('an edit refused by the server likewise keeps its dialog and its edited budget', async () => {
    const updateSpy = vi.fn(() => throwError(() => new HttpErrorResponse({
      status: 400, error: { error: 'allocated must be a non-negative number' },
    })));
    const attachedHere: ProjectCostCenter = { ...takenElsewhere, projectId: '9' };
    const fixture = await setUp(baseStub({
      getProjectCostCenters: () => of([attachedHere]),
      updateProjectCostCenter: updateSpy,
    }));
    const component = fixture.componentInstance;

    component.openEditForm(attachedHere);
    component.ccForm.controls.allocatedBudget.setValue(275000);
    component.saveCostCenter();
    await tick(fixture);

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(component.showForm()).toBe(true);
    expect(component.ccForm.controls.allocatedBudget.value).toBe(275000);
  });

  /**
   * The picker itself invited the 400: the id is the PRIMARY KEY of
   * /project-cost-centers, not a (projectId, id) pair, so an entry attached to any
   * project is unavailable everywhere.
   */
  it('does not offer a catalog cost center already attached to a DIFFERENT project', async () => {
    const fixture = await setUp(baseStub());
    const component = fixture.componentInstance;
    component.openForm();
    await tick(fixture);

    const offered = component.availableCostCenters().map(cc => cc.id);
    // The absence: CC-1001 belongs to project '1', so offering it here guarantees a 400.
    expect(offered).not.toContain('CC-1001');
    // Its twin — the option that must STILL be offered, or a filter that refuses
    // everything would pass the line above.
    expect(offered).toContain('CC-1002');

    const optionValues = [...host(fixture).querySelectorAll<HTMLOptionElement>('#ccId option')]
      .map(o => o.value).filter(Boolean);
    expect(optionValues).toEqual(['CC-1002']);
  });
});

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /project-cost-centers route
// and a tab panel inside project-details, which renders its own h1 (the project
// name). `headingLevel` is the one mechanism all eight embeddable panels use; the
// twin of these cases — that /projects/:id still has exactly ONE h1 with a panel
// open — lives in project-details.spec.ts.
//
// This panel is the one that ALSO carried a level-skip: embedded, its title was
// an h3 sitting directly under the project-name h1.
// ---------------------------------------------------------------------------

/** Class tokens, SPLIT — never a className substring check. 'text-3xl' is a
 *  substring of 'sm:text-3xl', so a substring test cannot tell the responsive
 *  variant from the base one. */
function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

/** The heading — at whatever level — whose trimmed text is exactly `text`. */
function headingFor(fixture: { nativeElement: unknown }, text: string): HTMLElement {
  const el = Array.from(host(fixture).querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find(h => h.textContent?.trim() === text);
  expect(el, `a heading reading "${text}" must be rendered`).toBeTruthy();
  return el!;
}

describe('ProjectCostCenters — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Cost Centers';
  const PROJECT: Project = {
    id: '9', name: 'Project Nine', location: 'Rome', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'In Execution', ownerId: 'R1',
  };
  const ROW: ProjectCostCenter = {
    id: 'CC-1001', projectId: '9', name: 'Engineering & Dev', manager: 'Alice Smith',
    allocated: 150000, actual: 125000,
  };

  /** The /project-cost-centers route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<ProjectCostCenters> {
    const api = {
      getProjects: () => of([PROJECT]),
      getResources: () => of([]),
      getCostCenters: () => of([] as CostCenter[]),
      getProjectCostCenters: () => of([ROW]),
    } as unknown as ApiService;
    TestBed.configureTestingModule({
      imports: [ProjectCostCenters],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { authReady: signal(true), canApproveFinancials: signal(true) } as unknown as AuthService },
        { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
      ],
    });
    return TestBed.createComponent(ProjectCostCenters);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<ProjectCostCenters> {
    const fixture = renderStandalone();
    fixture.componentRef.setInput('projectId', '9');
    fixture.componentRef.setInput('headingLevel', 2);
    return fixture;
  }

  it('standalone: EXACTLY ONE h1, and it carries the screen title', async () => {
    const fixture = renderStandalone();
    await tick(fixture);
    // RED before the fix: 0 — the title was an h2 and the route had no h1 at all.
    // COUNTED, not looked up: querySelector('h1') would also pass with two.
    const h1s = host(fixture).querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(TITLE);
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — NOT the h3 it used to be', async () => {
    const fixture = renderEmbedded();
    await tick(fixture);
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    // RED before the fix: 'H3' — a level skipped straight under the page h1,
    // which is a defect of its own rather than a milder form of the missing h1.
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
    expect(headingFor(fixture, TITLE).tagName).not.toBe('H3');
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).toBeNull();
    // The panel really rendered its table, so the count above is not vacuous.
    expect(host(fixture).textContent).toContain(ROW.name);
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
    // Promoting the h3 to an h2 must not have promoted its SIZE: text-lg, exactly
    // as before.
    const embeddedTokens = classTokens(headingFor(embedded, TITLE));
    expect(embeddedTokens).toEqual(expect.arrayContaining(['text-lg']));
    expect(embeddedTokens).not.toContain('text-2xl');
    expect(embeddedTokens).not.toContain('sm:text-3xl');
  });
});
