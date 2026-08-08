import { ErrorHandler } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ProjectTasks } from './project-tasks';
import { ApiService, Order, OrderLine, Partner, Project, Task, UserRole } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { capabilitiesForRoles } from '../../services/access-policy.util';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open; microtask
 * ticks are the established idiom in this repo (project-rates.spec.ts) for
 * letting an already-synchronous `rxResource` read reach the DOM.
 */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const PROJECT: Project = {
  id: 'P1', name: 'Project One', location: 'Berlin',
  startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution',
};
const PARTNER: Partner = { id: 'V-1', projectId: 'P1', company: 'Acme Subco', role: 'Development', contact: 'a@acme.test', status: 'Active' };

/** A subcontractor task WITH a partner — the only shape whose verdict needs /orders. */
const SUBCO_TASK: Task = {
  id: 'T-1', projectId: 'P1', name: 'Subco build', assignee: 'Unassigned',
  assigneeType: 'Subcontractor', partnerId: 'V-1', dueDate: '2026-09-30',
  status: 'To Do', priority: 'High',
};
/** Internal work: its verdict is derived from the task alone. */
const INTERNAL_TASK: Task = {
  id: 'T-2', projectId: 'P1', name: 'Design schema', assignee: 'Res One',
  assigneeType: 'Internal', dueDate: '2026-09-15', status: 'To Do', priority: 'Low',
};
/** Subcontractor work with no partner picked yet: also task-derived. */
const NO_PARTNER_TASK: Task = {
  id: 'T-3', projectId: 'P1', name: 'Subco unassigned', assignee: 'Unassigned',
  assigneeType: 'Subcontractor', partnerId: '', dueDate: '2026-10-31',
  status: 'To Do', priority: 'Medium',
};

const PURCHASE_ORDER: Order = {
  id: 'OB-1', contractId: 'CT-1', type: 'Purchase', partnerId: 'V-1',
  amount: 40_000, currency: 'EUR', status: 'Confirmed', orderDate: '2026-02-01',
};
const PURCHASE_LINE: OrderLine = { id: 'OL-1', orderId: 'OB-1', projectId: 'P1', description: 'Subco build', amount: 40_000 };

type ApiOverrides = Partial<Record<string, unknown>>;

function makeApiStub(overrides: ApiOverrides = {}) {
  const empty = () => of([]);
  const base: Record<string, (...args: never[]) => unknown> = {
    getProjects: () => of([PROJECT]),
    getResources: empty,
    getProjectTasks: () => of([SUBCO_TASK]),
    getProjectPartners: () => of([PARTNER]),
    getOrders: empty,
    getOrderLines: empty,
    updateProjectTask: () => of(SUBCO_TASK),
    createProjectTask: () => of(SUBCO_TASK),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService;
}

/**
 * The capability booleans are READ FROM THE REAL POLICY TABLE, never hand-written
 * here. A fixture that lies about the principal's identity certifies an inert
 * feature: hard-coding `canReadCommercial: () => false` for 'pm' would keep
 * passing even if the table later granted pm the commercial reads, at which point
 * the gate under test would be wrong and this spec would say nothing.
 * `states the premise it depends on` below asserts that mapping explicitly.
 */
function makeAuthStub(role: UserRole) {
  const caps = capabilitiesForRoles([role]);
  return {
    authReady: () => true,
    canReadCommercial: () => caps.canReadCommercial,
  } as unknown as AuthService;
}

interface Rendered {
  fixture: ComponentFixture<ProjectTasks>;
  api: ApiService;
  errors: unknown[];
}

/** Creates the component with inputs set but WITHOUT a first change detection,
 *  so a test can assert that the very first render does not blow up. */
function create(role: UserRole, overrides: ApiOverrides = {}): Rendered {
  const api = makeApiStub(overrides);
  // Angular reports a template exception to the ErrorHandler in some scheduling
  // modes and rethrows it from detectChanges() in others. Collecting here means
  // "the table rendered without blowing up" is provable either way.
  const errors: unknown[] = [];
  TestBed.configureTestingModule({
    imports: [ProjectTasks],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
      { provide: NotificationService, useValue: { show: vi.fn() } },
      { provide: ErrorHandler, useValue: { handleError: (e: unknown) => errors.push(e) } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectTasks);
  fixture.componentRef.setInput('projectId', 'P1');
  return { fixture, api, errors };
}

async function render(role: UserRole, overrides: ApiOverrides = {}): Promise<Rendered> {
  const rendered = create(role, overrides);
  await tick(rendered.fixture);
  return rendered;
}

function rowFor(fixture: ComponentFixture<ProjectTasks>, taskName: string): HTMLElement {
  const rows = Array.from(host(fixture).querySelectorAll<HTMLElement>('[data-test="task-row"]'));
  const row = rows.find(r => r.querySelector('[data-test="task-name"]')?.textContent?.trim() === taskName);
  expect(row, `the row for task "${taskName}" must be rendered`).toBeTruthy();
  return row!;
}

function coverageChip(fixture: ComponentFixture<ProjectTasks>, taskName: string): HTMLElement {
  // Scoped to the row AND to the coverage cell: the Priority column renders the
  // same `.command-status` pill, so an unscoped query could read the wrong chip.
  const chip = rowFor(fixture, taskName).querySelector<HTMLElement>('[data-test="coverage-chip"]');
  expect(chip, `the coverage chip for task "${taskName}" must be rendered`).toBeTruthy();
  return chip!;
}

function statusSelect(fixture: ComponentFixture<ProjectTasks>, taskName: string): HTMLSelectElement {
  const select = rowFor(fixture, taskName).querySelector<HTMLSelectElement>('[data-test="task-status"]');
  expect(select, `the status select for task "${taskName}" must be rendered`).toBeTruthy();
  return select!;
}

const REFUSED = () => throwError(() => new HttpErrorResponse({ status: 403, statusText: 'Forbidden' }));

/**
 * /project-tasks is readable by pm, but READ_RULES in src/server.ts restricts
 * /orders and /order-lines to sales/finance/delivery-executive/admin. The
 * Commercial Coverage column is computed FROM those two collections, so a pm
 * opening a project with a subcontractor task used to take a 403, error the
 * resource, and throw ResourceValueError out of the middle of the table.
 */
describe('ProjectTasks — Commercial Coverage under the commercial read gate', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('states the premise it depends on: pm has no commercial read, delivery-executive does', () => {
    expect(capabilitiesForRoles(['pm']).canReadCommercial).toBe(false);
    expect(capabilitiesForRoles(['resource-manager']).canReadCommercial).toBe(false);
    expect(capabilitiesForRoles(['delivery-executive']).canReadCommercial).toBe(true);
  });

  it('renders the whole table for a pm and never asks for /orders', async () => {
    const { fixture, api, errors } = create('pm', { getOrders: REFUSED, getOrderLines: REFUSED });
    // RED before the fix: the request went out, 403'd, and this very call threw
    // ResourceValueError from commercialCoverage() during change detection.
    expect(() => fixture.detectChanges()).not.toThrow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(errors).toStrictEqual([]);

    // The row rendered to its LAST column — proof the table did not stop at the
    // coverage cell, which is where the pre-fix render aborted.
    expect(rowFor(fixture, 'Subco build').textContent).toContain('High');
    expect(api.getOrders).not.toHaveBeenCalled();
    expect(api.getOrderLines).not.toHaveBeenCalled();
  });

  it('tells a pm the coverage is not available instead of accusing the task of a missing PO', async () => {
    const { fixture } = await render('pm', { getOrders: REFUSED, getOrderLines: REFUSED });
    const chip = coverageChip(fixture, 'Subco build');
    expect(chip.textContent?.trim()).toBe('Coverage not available');
    // THE LOAD-BEARING ABSENCE: an empty orders() reads as "no PO exists", which
    // is a confident lie about a task that may well be covered.
    expect(chip.textContent).not.toContain('Missing purchase order');
    // An unknown must not be painted as a critical finding.
    expect(chip.classList.contains('red')).toBe(false);
    expect(chip.classList.contains('neutral')).toBe(true);
  });

  it('still answers the two task-derived verdicts for a pm', async () => {
    // The capability guard sits BELOW these: they need no commercial data, so
    // withholding them from a pm would be its own defect.
    const { fixture } = await render('pm', {
      getProjectTasks: () => of([INTERNAL_TASK, NO_PARTNER_TASK]),
      getOrders: REFUSED,
      getOrderLines: REFUSED,
    });
    expect(coverageChip(fixture, 'Design schema').textContent?.trim()).toBe('Internal capacity');
    expect(coverageChip(fixture, 'Subco unassigned').textContent?.trim()).toBe('Subco without partner');
  });

  it('MUST STILL show delivery-executive the real verdict: PO covered', async () => {
    const { fixture, api } = await render('delivery-executive', {
      getOrders: () => of([PURCHASE_ORDER]),
      getOrderLines: () => of([PURCHASE_LINE]),
    });
    const chip = coverageChip(fixture, 'Subco build');
    expect(chip.textContent?.trim()).toBe('PO covered');
    expect(chip.classList.contains('green')).toBe(true);
    // The gate must open, not merely refuse everyone: a guard that always
    // refuses passes every negative test above.
    expect(api.getOrders).toHaveBeenCalled();
    expect(api.getOrderLines).toHaveBeenCalled();
  });

  it('MUST STILL show delivery-executive an uncovered subcontractor task in red', async () => {
    // The pair of the pm case: 'Missing purchase order' has to remain reachable,
    // or the fix would be "stop reporting the problem".
    const { fixture } = await render('delivery-executive', { getOrders: () => of([]), getOrderLines: () => of([]) });
    const chip = coverageChip(fixture, 'Subco build');
    expect(chip.textContent?.trim()).toBe('Missing purchase order');
    expect(chip.classList.contains('red')).toBe(true);
    expect(chip.classList.contains('neutral')).toBe(false);
  });

  it('does not count a purchase order that is still Open, or one for another partner', async () => {
    // Guards the lookup the new branches sit in front of: only a Confirmed /
    // Invoiced / Paid PO for THIS partner covers the task.
    const { fixture } = await render('delivery-executive', {
      getOrders: () => of([
        { ...PURCHASE_ORDER, status: 'Open' as const },
        { ...PURCHASE_ORDER, id: 'OB-2', partnerId: 'V-OTHER' },
      ]),
      getOrderLines: () => of([PURCHASE_LINE, { ...PURCHASE_LINE, id: 'OL-2', orderId: 'OB-2' }]),
    });
    expect(coverageChip(fixture, 'Subco build').textContent?.trim()).toBe('Missing purchase order');
  });

  it('says the coverage check failed when /orders errors for a role that MAY read it', async () => {
    // The second half of the fix: gating on the capability alone leaves the
    // permitted roles crashing on a 500 or an expired bearer.
    const { fixture, errors } = create('delivery-executive', {
      getOrders: () => throwError(() => new HttpErrorResponse({ status: 500 })),
      getOrderLines: () => of([PURCHASE_LINE]),
    });
    expect(() => fixture.detectChanges()).not.toThrow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(errors).toStrictEqual([]);

    const chip = coverageChip(fixture, 'Subco build');
    expect(chip.textContent?.trim()).toBe('Coverage check failed');
    expect(chip.textContent).not.toContain('Missing purchase order');
    // Distinct from the capability verdict: "we could not load this" is not
    // "you may not see this", and neither label may match the other.
    expect(chip.textContent).not.toContain('Coverage not available');
    expect(chip.classList.contains('red')).toBe(false);
  });

  it('says the coverage check failed when /order-lines is the leg that errors', async () => {
    const { fixture } = await render('delivery-executive', {
      getOrders: () => of([PURCHASE_ORDER]),
      getOrderLines: () => throwError(() => new HttpErrorResponse({ status: 500 })),
    });
    // Without the orderLines half of the guard this row would read 'PO covered'
    // — a verdict pronounced with half its evidence missing.
    expect(coverageChip(fixture, 'Subco build').textContent?.trim()).toBe('Coverage check failed');
  });
});

describe('ProjectTasks — responsive table pan port', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps every column in a labelled keyboard-scrollable region', async () => {
    const { fixture } = await render('pm');
    const rendered = host(fixture);
    const region = rendered.querySelector<HTMLElement>('[data-test="tasks-table-scroll"]')!;
    const table = region.querySelector<HTMLTableElement>('table')!;
    const hint = rendered.querySelector<HTMLElement>(`#${region.getAttribute('aria-describedby')}`)!;
    const identityHeader = table.querySelector<HTMLElement>('thead th:first-child')!;
    const identityCell = table.querySelector<HTMLElement>('[data-test="task-name"]')!;
    const status = table.querySelector<HTMLElement>('[data-test="task-status"]')!;

    expect(region).not.toBeNull();
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Project tasks table');
    expect(region.tabIndex).toBe(0);
    expect(classTokens(region)).toEqual(expect.arrayContaining([
      'overflow-x-auto', 'overscroll-x-contain', 'outline-none', 'focus-visible:ring-2',
    ]));
    expect(hint.textContent).toContain('Swipe horizontally');
    expect(classTokens(hint)).toContain('lg:hidden');
    expect(table.className).toContain('min-w-[');
    expect(table.querySelectorAll('thead th')).toHaveLength(6);
    expect(classTokens(identityHeader)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface-muted!']));
    expect(classTokens(identityCell)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface!']));
    expect(classTokens(status)).toContain('min-h-11');
  });

  it('stacks the header and task date fields at 320px and keeps the long dialog scroll-safe', async () => {
    const { fixture } = await render('pm');
    const rendered = host(fixture);
    const header = rendered.querySelector<HTMLElement>('[data-test="tasks-header"]')!;
    expect(classTokens(header)).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
    expect(classTokens(header)).not.toContain('flex-row');

    fixture.componentInstance.openForm();
    await tick(fixture);

    const overlay = rendered.querySelector<HTMLElement>('[data-test="task-form-overlay"]')!;
    const panel = rendered.querySelector<HTMLElement>('[data-test="task-form-panel"]')!;
    const body = rendered.querySelector<HTMLElement>('[data-test="task-form-body"]')!;
    const dateGrid = rendered.querySelector<HTMLElement>('[data-test="task-date-grid"]')!;
    const actions = rendered.querySelector<HTMLElement>('[data-test="task-form-actions"]')!;
    const close = rendered.querySelector<HTMLElement>('[data-test="task-form-close"]')!;

    expect(classTokens(overlay)).toEqual(expect.arrayContaining(['items-start', 'sm:items-center', 'overflow-y-auto']));
    expect(classTokens(overlay)).not.toContain('items-center');
    expect(classTokens(panel)).toEqual(expect.arrayContaining(['max-h-[90vh]', 'overflow-hidden']));
    expect(classTokens(body)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
    expect(classTokens(dateGrid)).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
    expect(classTokens(dateGrid)).not.toContain('grid-cols-2');
    expect(classTokens(actions)).toContain('flex-wrap');
    expect(classTokens(close)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
  });
});

/**
 * The status <select> is a one-way `[ngModel]` binding: when the server refuses
 * the PUT the model never moves, so Angular re-renders nothing and the control
 * keeps displaying a status the server rejected. A `resource-manager` can READ
 * /project-tasks (no READ_RULE narrows it) but cannot write it.
 */
describe('ProjectTasks — status select after a refused PUT', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reverts to the status the server still holds when the PUT is refused', async () => {
    const update = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 403, statusText: 'Forbidden' })));
    const { fixture } = await render('resource-manager', {
      getProjectTasks: () => of([INTERNAL_TASK]),
      updateProjectTask: update,
    });
    const select = statusSelect(fixture, 'Design schema');
    expect(select.value).toBe('To Do');

    select.value = 'Done';
    select.dispatchEvent(new Event('change'));
    await tick(fixture);

    // RED before the fix: 'Done' — the row advertised a change that never happened.
    expect(select.value).toBe('To Do');
    expect(update).toHaveBeenCalledWith('T-2', { status: 'Done' });
    // A revert that re-enters the write pipeline would retry the refused PUT
    // forever; exactly one attempt must have been made.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('MUST STILL keep the new status when the PUT is accepted', async () => {
    // The pair that rules out reverting unconditionally: that would pass the
    // test above while undoing every accepted change on screen.
    let stored: Task[] = [{ ...INTERNAL_TASK }];
    const update = vi.fn((id: string, patch: Partial<Task>) => {
      stored = stored.map(t => (t.id === id ? { ...t, ...patch } : t));
      return of(stored.find(t => t.id === id)!);
    });
    const { fixture } = await render('resource-manager', {
      getProjectTasks: () => of(stored),
      updateProjectTask: update,
    });
    const select = statusSelect(fixture, 'Design schema');

    select.value = 'Done';
    select.dispatchEvent(new Event('change'));
    await tick(fixture);

    expect(update).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('Done');
    // ...and the reloaded list agrees with the control, so the screen does not
    // contradict itself in the other direction either.
    expect(stored[0].status).toBe('Done');
  });

  it('lets the user retry the same pick after a refusal', async () => {
    // The revert must not leave the control unable to re-emit the value it was
    // snapped back from — otherwise a role that regains the right (or a
    // transient 503) cannot be retried without a reload.
    const update = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 503 })));
    const { fixture } = await render('resource-manager', {
      getProjectTasks: () => of([INTERNAL_TASK]),
      updateProjectTask: update,
    });
    const select = statusSelect(fixture, 'Design schema');

    for (let attempt = 0; attempt < 2; attempt++) {
      select.value = 'Done';
      select.dispatchEvent(new Event('change'));
      await tick(fixture);
      expect(select.value).toBe('To Do');
    }
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectTasks — the Create Task dialog survives a refused POST', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the dialog open with the name, assignee, partner and due date intact when the POST is refused', async () => {
    // THE DEFECT: closeForm() ran unconditionally right after firing the POST, so
    // taskForm.reset() wiped every field while the request was still in flight. A
    // resource-manager — who can READ this table but not write it — hit exactly that:
    // a 403, a toast, and an empty form.
    const { fixture } = await render('resource-manager', {
      createProjectTask: () => throwError(() => new HttpErrorResponse({
        status: 403, error: { error: 'Role resource-manager cannot modify /project-tasks' },
      })),
    });
    const component = fixture.componentInstance;

    component.showForm.set(true);
    component.taskForm.setValue({
      name: 'Design schema', assignee: 'Res One', assigneeType: 'Subcontractor',
      partnerId: 'V-1', dueDate: '2026-11-30', priority: 'High', status: 'To Do',
    });
    component.saveTask();
    await tick(fixture);

    expect(component.showForm()).toBe(true);
    expect(component.taskForm.getRawValue()).toStrictEqual({
      name: 'Design schema', assignee: 'Res One', assigneeType: 'Subcontractor',
      partnerId: 'V-1', dueDate: '2026-11-30', priority: 'High', status: 'To Do',
    });
    // Stated INLINE, because error toasts in this app auto-dismiss and a dialog left
    // open with a vanished toast is an unexplained refusal.
    expect(host(fixture).querySelector('[data-test="task-save-error"]')?.textContent)
      .toContain('Role resource-manager cannot modify /project-tasks');
  });

  it('MUST STILL close and reset when the POST is accepted', async () => {
    // The assertion of ABSENCE: "never close the dialog" passes the case above and
    // fails here, so the two together pin the actual behaviour.
    const { fixture } = await render('pm');
    const component = fixture.componentInstance;

    component.showForm.set(true);
    component.taskForm.setValue({
      name: 'Design schema', assignee: 'Res One', assigneeType: 'Internal',
      partnerId: '', dueDate: '2026-11-30', priority: 'High', status: 'To Do',
    });
    component.saveTask();
    await tick(fixture);

    expect(component.showForm()).toBe(false);
    expect(component.taskForm.controls.name.value).toBeNull();
    expect(component.taskForm.controls.priority.value).toBe('Medium');
    expect(host(fixture).querySelector('[data-test="task-save-error"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /project-tasks route and a
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
function headingFor(fixture: { nativeElement: unknown }, text: string): HTMLElement {
  const el = Array.from(host(fixture).querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find(h => h.textContent?.trim() === text);
  expect(el, `a heading reading "${text}" must be rendered`).toBeTruthy();
  return el!;
}

describe('ProjectTasks — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Tasks';

  /** The /project-tasks route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<ProjectTasks> {
    const api = makeApiStub();
    TestBed.configureTestingModule({
      imports: [ProjectTasks],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: makeAuthStub('pm') },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.createComponent(ProjectTasks);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<ProjectTasks> {
    const fixture = renderStandalone();
    fixture.componentRef.setInput('projectId', 'P1');
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
    // Proof this really is the standalone shape and not the embedded one — and
    // that splitting the title out of the old `@if (!projectId())` block did not
    // take the project picker with it.
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — the absence twin', async () => {
    const fixture = renderEmbedded();
    await tick(fixture);
    // The whole point of the input: inside project-details the page h1 is the
    // project name, so this panel must contribute none.
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
    // h2, not h3: a level skipped under the page h1 is its own defect.
    expect(headingFor(fixture, TITLE).tagName).not.toBe('H3');
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).toBeNull();
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
    const embeddedTokens = classTokens(headingFor(embedded, TITLE));
    expect(embeddedTokens).toEqual(expect.arrayContaining(['text-lg']));
    // The pair: the panel title must NOT have been promoted to page size just
    // because its element changed.
    expect(embeddedTokens).not.toContain('text-2xl');
    expect(embeddedTokens).not.toContain('sm:text-3xl');
  });
});
