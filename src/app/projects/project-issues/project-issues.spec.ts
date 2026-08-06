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
