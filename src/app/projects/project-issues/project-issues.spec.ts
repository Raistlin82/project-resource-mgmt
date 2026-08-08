import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ProjectIssues } from './project-issues';
import { ApiService, Issue, Project } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open; microtask
 * ticks are the established idiom in this repo (project-tasks.spec.ts,
 * project-rates.spec.ts) for letting an already-synchronous `rxResource` read
 * reach the DOM.
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

const OPEN_ISSUE: Issue = {
  id: 'IS-1', projectId: 'P1', title: 'API rate limiting', type: 'Bug',
  severity: 'High', status: 'Open', reportedBy: 'Julie Armstrong',
  owner: 'John Miller', dueDate: '2026-09-30', actionPlan: 'Add a token bucket',
};

type ApiOverrides = Partial<Record<string, unknown>>;

function makeApiStub(overrides: ApiOverrides = {}) {
  const base: Record<string, (...args: never[]) => unknown> = {
    getProjects: () => of([PROJECT]),
    getResources: () => of([]),
    getProjectIssues: () => of([OPEN_ISSUE]),
    updateProjectIssue: () => of(OPEN_ISSUE),
    createProjectIssue: () => of(OPEN_ISSUE),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService;
}

function create(overrides: ApiOverrides = {}): { fixture: ComponentFixture<ProjectIssues>; api: ApiService } {
  const api = makeApiStub(overrides);
  TestBed.configureTestingModule({
    imports: [ProjectIssues],
    providers: [
      { provide: ApiService, useValue: api },
      // authReady() must be true or every authGatedResource stays on its empty
      // default and the table renders no rows at all — a fixture that lies about
      // readiness certifies an inert feature.
      { provide: AuthService, useValue: { authReady: () => true } },
      { provide: NotificationService, useValue: { show: vi.fn(), error: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectIssues);
  fixture.componentRef.setInput('projectId', 'P1');
  return { fixture, api };
}

async function render(overrides: ApiOverrides = {}) {
  const rendered = create(overrides);
  await tick(rendered.fixture);
  return rendered;
}

function rowFor(fixture: ComponentFixture<ProjectIssues>, title: string): HTMLElement {
  const rows = Array.from(host(fixture).querySelectorAll<HTMLElement>('[data-test="issue-row"]'));
  const row = rows.find(r => r.querySelector('[data-test="issue-title"]')?.textContent?.trim() === title);
  expect(row, `the row for issue "${title}" must be rendered`).toBeTruthy();
  return row!;
}

function statusSelect(fixture: ComponentFixture<ProjectIssues>, title: string): HTMLSelectElement {
  const select = rowFor(fixture, title).querySelector<HTMLSelectElement>('[data-test="issue-status"]');
  expect(select, `the status select for issue "${title}" must be rendered`).toBeTruthy();
  return select!;
}

/** The chip beside the select. Read as its OWN element, never as the row's
 *  textContent: the row text also contains every <option> label ('Open',
 *  'Mitigated', 'Closed'), so a row-level `toContain` is satisfied by the
 *  dropdown's own markup no matter what the chip says. */
function statusChip(fixture: ComponentFixture<ProjectIssues>, title: string): HTMLElement {
  const chip = rowFor(fixture, title).querySelector<HTMLElement>('[data-test="issue-status-chip"]');
  expect(chip, `the status chip for issue "${title}" must be rendered`).toBeTruthy();
  return chip!;
}

describe('ProjectIssues — responsive table and form structure', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps every column in a labelled keyboard-scrollable region with issue identity visible', async () => {
    const { fixture } = await render();
    const rendered = host(fixture);
    const region = rendered.querySelector<HTMLElement>('[data-test="issues-table-scroll"]')!;
    const table = region.querySelector<HTMLTableElement>('table')!;
    const hint = rendered.querySelector<HTMLElement>(`#${region.getAttribute('aria-describedby')}`)!;
    const identityHeader = table.querySelector<HTMLElement>('thead th:first-child')!;
    const identityCell = table.querySelector<HTMLElement>('[data-test="issue-title"]')!;
    const status = table.querySelector<HTMLElement>('[data-test="issue-status"]')!;

    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Project issues table');
    expect(region.tabIndex).toBe(0);
    expect(classTokens(region)).toEqual(expect.arrayContaining([
      'overflow-x-auto', 'overscroll-x-contain', 'outline-none', 'focus-visible:ring-2',
    ]));
    expect(hint.textContent).toContain('Swipe horizontally');
    expect(classTokens(hint)).toContain('lg:hidden');
    expect(table.className).toContain('min-w-[');
    expect(table.querySelectorAll('thead th')).toHaveLength(7);
    expect(classTokens(identityHeader)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface-muted!']));
    expect(classTokens(identityCell)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface!']));
    expect(classTokens(status)).toContain('min-h-11');
  });

  it('stacks the header and both paired field groups at 320px and keeps the long dialog scroll-safe', async () => {
    const { fixture } = await render();
    const rendered = host(fixture);
    const header = rendered.querySelector<HTMLElement>('[data-test="issues-header"]')!;
    expect(classTokens(header)).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
    expect(classTokens(header)).not.toContain('flex-row');

    fixture.componentInstance.openForm();
    await tick(fixture);

    const overlay = rendered.querySelector<HTMLElement>('[data-test="issue-form-overlay"]')!;
    const panel = rendered.querySelector<HTMLElement>('[data-test="issue-form-panel"]')!;
    const body = rendered.querySelector<HTMLElement>('[data-test="issue-form-body"]')!;
    const typeGrid = rendered.querySelector<HTMLElement>('[data-test="issue-type-grid"]')!;
    const ownerGrid = rendered.querySelector<HTMLElement>('[data-test="issue-owner-grid"]')!;
    const actions = rendered.querySelector<HTMLElement>('[data-test="issue-form-actions"]')!;
    const close = rendered.querySelector<HTMLElement>('[data-test="issue-form-close"]')!;

    expect(classTokens(overlay)).toEqual(expect.arrayContaining(['items-start', 'sm:items-center', 'overflow-y-auto']));
    expect(classTokens(overlay)).not.toContain('items-center');
    expect(classTokens(panel)).toEqual(expect.arrayContaining(['max-h-[90vh]', 'overflow-hidden']));
    expect(classTokens(body)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
    for (const grid of [typeGrid, ownerGrid]) {
      expect(classTokens(grid)).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
      expect(classTokens(grid)).not.toContain('grid-cols-2');
    }
    expect(classTokens(actions)).toContain('flex-wrap');
    expect(classTokens(close)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
  });
});

/**
 * The status <select> is a one-way `[ngModel]` binding: when the server refuses
 * the PUT the model never moves, so Angular re-renders nothing and the control
 * keeps displaying a status the server rejected. The chip immediately beside it
 * stays bound to `issue.status`, so the row ends up contradicting itself — one
 * cell claiming 'Closed' while the other still reads 'Open'.
 *
 * This is the same defect project-tasks.ts had; closing it there and leaving the
 * sibling open is how a fix wave becomes the source of the next finding.
 */
describe('ProjectIssues — status select after a refused PUT', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reverts to the status the server still holds when the PUT is refused', async () => {
    const update = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 403, statusText: 'Forbidden' })));
    const { fixture } = await render({ updateProjectIssue: update });
    const select = statusSelect(fixture, 'API rate limiting');
    expect(select.value).toBe('Open');

    select.value = 'Closed';
    select.dispatchEvent(new Event('change'));
    await tick(fixture);

    // RED before the fix: 'Closed' — the row advertised a change that never happened.
    expect(select.value).toBe('Open');
    expect(update).toHaveBeenCalledWith('IS-1', { status: 'Closed' });
    // A revert that re-entered the write pipeline would retry the refused PUT
    // forever; exactly one attempt must have been made.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('MUST STILL keep the new status when the PUT is accepted', async () => {
    // The pair that rules out reverting unconditionally: that would pass the test
    // above while undoing every accepted change on screen.
    let stored: Issue[] = [{ ...OPEN_ISSUE }];
    const update = vi.fn((id: string, patch: Partial<Issue>) => {
      stored = stored.map(i => (i.id === id ? { ...i, ...patch } : i));
      return of(stored.find(i => i.id === id)!);
    });
    const { fixture } = await render({
      getProjectIssues: () => of(stored),
      updateProjectIssue: update,
    });
    const select = statusSelect(fixture, 'API rate limiting');

    select.value = 'Mitigated';
    select.dispatchEvent(new Event('change'));
    await tick(fixture);

    expect(update).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('Mitigated');
    // ...and the reloaded list agrees with the control, so the screen does not
    // contradict itself in the other direction either.
    expect(stored[0].status).toBe('Mitigated');
    // The chip's twin: it must MOVE on an accepted change. Without this the chip
    // assertion in the refusal case could be satisfied by a chip that is simply
    // frozen on the seeded value forever.
    expect(statusChip(fixture, 'API rate limiting').textContent?.trim()).toBe('Mitigated');
  });

  it('leaves the status chip and the select agreeing after a refusal', async () => {
    // The chip is the other half of the contradiction: it reads `issue.status`
    // directly, so it never moved. Asserting the select alone would not catch a
    // "fix" that instead advanced the local model to the rejected value.
    const update = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 403 })));
    const { fixture } = await render({ updateProjectIssue: update });
    const select = statusSelect(fixture, 'API rate limiting');

    select.value = 'Closed';
    select.dispatchEvent(new Event('change'));
    await tick(fixture);

    expect(select.value).toBe('Open');
    expect(statusChip(fixture, 'API rate limiting').textContent?.trim()).toBe('Open');
  });

  it('lets the user retry the same pick after a refusal', async () => {
    // The revert must not leave the control unable to re-emit the value it was
    // snapped back from — otherwise a role that regains the right (or a
    // transient 503) cannot be retried without a reload.
    const update = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 503 })));
    const { fixture } = await render({ updateProjectIssue: update });
    const select = statusSelect(fixture, 'API rate limiting');

    for (let attempt = 0; attempt < 2; attempt++) {
      select.value = 'Closed';
      select.dispatchEvent(new Event('change'));
      await tick(fixture);
      expect(select.value).toBe('Open');
    }
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not fire a PUT on first render — the revert path must not be self-triggering', async () => {
    // A one-way [ngModel] whose (ngModelChange) fired during hydration would PUT
    // on every load; this pins that only a user change reaches the API.
    const { api } = await render();
    expect(api.updateProjectIssue).not.toHaveBeenCalled();
  });
});

describe('ProjectIssues — the Report Issue dialog survives a refused POST', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the dialog open with the title, impact and action plan intact when the POST is refused', async () => {
    // THE DEFECT: closeForm() ran unconditionally right after firing the POST, so
    // issueForm.reset() wiped every field — including the multi-line action plan —
    // while the request was still in flight. On a refusal the reporter saw a toast
    // over an empty screen and had to retype a long free-text field from memory.
    const { fixture } = await render({
      createProjectIssue: () => throwError(() => new HttpErrorResponse({
        status: 400, error: { error: 'title already reported on this project' },
      })),
    });
    const component = fixture.componentInstance;

    component.showForm.set(true);
    component.issueForm.patchValue({
      title: 'Queue backlog', type: 'Risk', severity: 'High',
      impact: 'Schedule slip of two weeks', actionPlan: 'Add consumers and re-baseline the sprint',
    });
    component.saveIssue();
    await tick(fixture);

    expect(component.showForm()).toBe(true);
    expect(component.issueForm.controls.title.value).toBe('Queue backlog');
    expect(component.issueForm.controls.impact.value).toBe('Schedule slip of two weeks');
    expect(component.issueForm.controls.actionPlan.value).toBe('Add consumers and re-baseline the sprint');
    // Stated INLINE, because error toasts in this app auto-dismiss and a dialog left
    // open with a vanished toast is an unexplained refusal.
    expect(host(fixture).querySelector('[data-test="issue-save-error"]')?.textContent)
      .toContain('title already reported on this project');
  });

  it('MUST STILL close and reset when the POST is accepted', async () => {
    // The assertion of ABSENCE: "never close the dialog" passes the case above and
    // fails here, so the two together pin the actual behaviour.
    const { fixture } = await render();
    const component = fixture.componentInstance;

    component.showForm.set(true);
    component.issueForm.patchValue({ title: 'Queue backlog', actionPlan: 'Add consumers' });
    component.saveIssue();
    await tick(fixture);

    expect(component.showForm()).toBe(false);
    expect(component.issueForm.controls.title.value).toBeNull();
    expect(host(fixture).querySelector('[data-test="issue-save-error"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /project-issues route and a
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

describe('ProjectIssues — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Issues';

  /** The /project-issues route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<ProjectIssues> {
    TestBed.configureTestingModule({
      imports: [ProjectIssues],
      providers: [
        { provide: ApiService, useValue: makeApiStub() },
        { provide: AuthService, useValue: { authReady: () => true } },
        { provide: NotificationService, useValue: { show: vi.fn(), error: vi.fn() } },
      ],
    });
    return TestBed.createComponent(ProjectIssues);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<ProjectIssues> {
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
    // Proof this really is the standalone shape — and that splitting the title
    // out of the old `@if (!projectId())` block kept the project picker.
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — the absence twin', async () => {
    const fixture = renderEmbedded();
    await tick(fixture);
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
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
    expect(embeddedTokens).not.toContain('text-2xl');
    expect(embeddedTokens).not.toContain('sm:text-3xl');
  });
});
