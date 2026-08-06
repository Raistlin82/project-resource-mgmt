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
