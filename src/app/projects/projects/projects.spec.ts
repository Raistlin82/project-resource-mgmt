import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ProjectsComponent } from './projects';
import { ApiService, Project, UserRole } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

const project: Project = {
  id: 'P1',
  name: 'Read-only project',
  location: 'Rome',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'In Execution',
  ownerId: '1',
  contractId: 'C1',
};

function makeApiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getProjects: vi.fn(() => of([project])),
    getContracts: vi.fn(() => of([])),
    getResources: vi.fn(() => of([])),
    getCountries: vi.fn(() => of([])),
    getCities: vi.fn(() => of([])),
    createProject: vi.fn(() => of(project)),
    updateProject: vi.fn(() => of(project)),
    deleteProject: vi.fn(() => of(undefined)),
    ...overrides,
  };
}

function makeAuthStub(role: UserRole) {
  return {
    authReady: signal(true),
    userId: signal('1'),
    canReadCommercial: computed(() => ['sales', 'finance', 'delivery-executive', 'admin'].includes(role)),
    canManageProjects: computed(() => ['pm', 'delivery-executive', 'admin'].includes(role)),
    // DERIVED FROM THE SAME `role` as the others, not hand-set per test: this is the
    // role set that access-policy.util.ts grants canReadStaffing, and it is what
    // /projects/:id's own roleGuard consults. A hand-set boolean here would let the
    // two cases below disagree with the real policy and still pass.
    canReadStaffing: computed(() => ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'].includes(role)),
  };
}

async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

async function render(role: UserRole, apiOverrides: Partial<Record<string, unknown>> = {}) {
  const api = makeApiStub(apiOverrides);
  TestBed.configureTestingModule({
    imports: [ProjectsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
    ],
  });
  const fixture = TestBed.createComponent(ProjectsComponent);
  await tick(fixture);
  return { fixture, component: fixture.componentInstance, api };
}

describe('Projects role affordances and dependency loading', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not load forbidden contracts for a PM, while keeping project actions available', async () => {
    const { fixture, api } = await render('pm');
    expect(api.getContracts).not.toHaveBeenCalled();
    expect(api.getResources).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain('Create Project');
    expect(fixture.nativeElement.querySelector('[aria-label="Edit project Read-only project (P1)"]')).not.toBeNull();
  });

  it('keeps finance project browsing read-only and skips form-only dependencies', async () => {
    const { fixture, api, component } = await render('finance');
    expect(api.getContracts).toHaveBeenCalledOnce();
    expect(api.getResources).not.toHaveBeenCalled();
    expect(api.getCountries).not.toHaveBeenCalled();
    expect(api.getCities).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('Create Project');
    expect(fixture.nativeElement.querySelector('[aria-label^="Edit project "]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label^="Delete project "]')).toBeNull();

    component.openCreateForm();
    component.deleteProject(project.id);
    component.confirmDelete();
    expect(component.showForm()).toBe(false);
    expect(api.deleteProject).not.toHaveBeenCalled();
  });
});

describe('Projects list states and contextual actions', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a loading state without flashing either empty state while the source is pending', async () => {
    const pending = new Subject<Project[]>();
    const { fixture } = await render('pm', {
      getProjects: vi.fn(() => pending.asObservable()),
    });

    const loading = fixture.nativeElement.querySelector('[role="status"]');
    expect(loading?.textContent).toContain('Loading projects');
    expect(fixture.nativeElement.querySelector('[data-test="projects-source-empty"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="projects-filtered-empty"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-search-filter-bar')).toBeNull();
  });

  it('renders a retryable error state and never mislabels a failed read as empty', async () => {
    const getProjects = vi.fn(() => throwError(() => new Error('offline')));
    const { fixture } = await render('pm', { getProjects });

    expect(fixture.nativeElement.textContent).toContain("Couldn't load projects");
    expect(fixture.nativeElement.querySelector('[data-test="projects-source-empty"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="projects-filtered-empty"]')).toBeNull();

    const retry = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find(button => button.textContent?.includes('Retry')) as HTMLButtonElement;
    retry.click();
    await tick(fixture);
    expect(getProjects).toHaveBeenCalledTimes(2);
  });

  it('offers the source-empty creation CTA only to a role that can manage projects', async () => {
    const { fixture } = await render('pm', {
      getProjects: vi.fn(() => of([])),
    });

    const empty = fixture.nativeElement.querySelector('[data-test="projects-source-empty"]');
    expect(empty?.textContent).toContain('No projects available');
    expect(empty?.textContent).toContain('Create the first collaborative project');
    expect(Array.from((empty as HTMLElement).querySelectorAll('button')).some(button => button.textContent?.includes('Create Project'))).toBe(true);
  });

  it('does not invite a read-only role to create data in the source-empty state', async () => {
    const { fixture } = await render('finance', {
      getProjects: vi.fn(() => of([])),
    });

    const empty = fixture.nativeElement.querySelector('[data-test="projects-source-empty"]');
    expect(empty?.textContent).toContain('There are no projects available for your role yet');
    expect(empty?.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Create the first collaborative project');
  });

  it('distinguishes a filtered-empty result and restores the cards with Clear filters', async () => {
    const { fixture, component } = await render('pm');
    component.searchControl.setValue('does-not-exist');
    await tick(fixture);

    const filteredEmpty = fixture.nativeElement.querySelector('[data-test="projects-filtered-empty"]');
    expect(filteredEmpty?.textContent).toContain('No projects match your filters');
    expect(fixture.nativeElement.querySelector('[data-test="projects-source-empty"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('a[href="/projects/P1"]')).toBeNull();

    (filteredEmpty.querySelector('button') as HTMLButtonElement).click();
    await tick(fixture);
    expect(component.searchControl.value).toBe('');
    expect(fixture.nativeElement.querySelector('[data-test="projects-filtered-empty"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('a[href="/projects/P1"]')).not.toBeNull();
  });

  it('keeps the complete card title and puts project name and ID in actions and delete confirmation', async () => {
    const longName = 'A collaborative project name that must remain completely readable at narrow widths';
    const contextualProject: Project = { ...project, id: 'PROJECT-2026-LONG-ID', name: longName };
    const { fixture } = await render('pm', {
      getProjects: vi.fn(() => of([contextualProject])),
    });

    const title = fixture.nativeElement.querySelector('article h3') as HTMLElement;
    expect(title.textContent?.trim()).toBe(longName);
    expect(title.classList.contains('truncate')).toBe(false);
    expect(title.classList.contains('line-clamp-3')).toBe(false);

    const editLabel = `Edit project ${longName} (${contextualProject.id})`;
    const deleteLabel = `Delete project ${longName} (${contextualProject.id})`;
    expect(fixture.nativeElement.querySelector(`[aria-label="${editLabel}"]`)).not.toBeNull();
    const deleteButton = fixture.nativeElement.querySelector(`[aria-label="${deleteLabel}"]`) as HTMLButtonElement;
    expect(deleteButton).not.toBeNull();
    deleteButton.click();
    await tick(fixture);

    const dialog = fixture.nativeElement.querySelector('[aria-labelledby="projectDeleteTitle"]');
    expect(dialog?.textContent).toContain(longName);
    expect(dialog?.textContent).toContain(contextualProject.id);
    expect(dialog?.querySelector(`[aria-label="Confirm delete project ${longName} (${contextualProject.id})"]`)).not.toBeNull();
  });

  it('keeps project edit/delete actions visible, wrapped and at least 44px square', async () => {
    const { fixture } = await render('pm');
    const h = fixture.nativeElement as HTMLElement;
    const edit = h.querySelector<HTMLButtonElement>('[aria-label="Edit project Read-only project (P1)"]')!;
    const remove = h.querySelector<HTMLButtonElement>('[aria-label="Delete project Read-only project (P1)"]')!;
    const actionGroup = edit.parentElement!;

    expect(actionGroup.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(actionGroup.className.split(/\s+/).some(token => token.includes('opacity-0') || token.includes('group-hover'))).toBe(false);
    for (const button of [edit, remove]) {
      expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
    }
  });

  it('uses an h2 list section before h3 card titles', async () => {
    const { fixture } = await render('pm');
    const outline = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('h1, h2, h3'))
      .map(heading => Number(heading.tagName.slice(1)));
    expect(outline.slice(0, 3)).toEqual([1, 2, 3]);
  });
});

describe('Projects form lifecycle', () => {
  afterEach(() => TestBed.resetTestingModule());

  function validProject(component: ProjectsComponent): void {
    component.projectForm.setValue({
      name: 'New project',
      location: 'Remote',
      startDate: '2099-01-01',
      endDate: '2099-12-31',
      status: 'In Planning',
      ownerId: '1',
      contractId: '',
      description: '',
    });
  }

  it('keeps invalid submit operable, exposes inline errors and focuses the first invalid field', async () => {
    const { fixture, component, api } = await render('pm');
    component.openCreateForm();
    await tick(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const submit = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Create Project') && button.closest('[role="dialog"]'))!;

    expect(submit.disabled).toBe(false);
    submit.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(api.createProject).not.toHaveBeenCalled();
    expect(host.querySelector('#projectNameError')?.textContent).toContain('required');
    expect(document.activeElement).toBe(host.querySelector('#projectName'));
  });

  it('asks before discarding a dirty form and preserves it when the operator keeps editing', async () => {
    const { fixture, component } = await render('pm');
    component.openCreateForm();
    await tick(fixture);
    component.projectForm.controls.name.setValue('Draft name');
    component.projectForm.controls.name.markAsDirty();
    component.closeForm();
    fixture.detectChanges();

    expect(component.showForm()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="project-discard-confirm"]')).not.toBeNull();

    (component as unknown as { cancelDiscard: () => void }).cancelDiscard();
    fixture.detectChanges();
    expect(component.showForm()).toBe(true);
    expect(component.projectForm.controls.name.value).toBe('Draft name');
  });

  it('blocks duplicate saves while pending and keeps API failures in the form', async () => {
    const pending = new Subject<Project>();
    const { fixture, component, api } = await render('pm', {
      createProject: vi.fn(() => pending.asObservable()),
    });
    component.openCreateForm();
    await tick(fixture);
    validProject(component);
    component.saveProject();
    component.saveProject();
    fixture.detectChanges();

    expect(api.createProject).toHaveBeenCalledOnce();
    const save = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Saving'))!;
    expect(save.disabled).toBe(true);

    pending.error({ error: { error: 'Owner is unavailable' } });
    fixture.detectChanges();
    expect(component.showForm()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="project-save-error"]')?.textContent)
      .toContain('Owner is unavailable');
  });
});

/**
 * /projects/:id is guarded by roleGuard(a => a.canReadStaffing()) (app.routes.ts:21).
 * For employee and sales that guard emits parseUrl('/'), so the click landed them on
 * the Dashboard with no toast and no message — and since the anchor stretched over
 * the whole card there was no non-link region to click, making the whole list read as
 * broken rather than read-only. For sales it also removed the only route from the
 * project list to a project record.
 */
describe('Projects card links only where /projects/:id will actually open', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders no link to the project detail route for a role the guard bounces, but still shows the name', async () => {
    const { fixture } = await render('employee');

    // THE ASSERTION OF ABSENCE.
    expect(fixture.nativeElement.querySelector('a[href="/projects/P1"]')).toBeNull();
    // The card must not merely be link-free — the project must still be identifiable.
    expect(fixture.nativeElement.textContent).toContain('Read-only project');
    // And the stretched pseudo-element must go with the anchor, or the card still
    // advertises itself as clickable.
    expect(fixture.nativeElement.querySelector('.before\\:inset-0')).toBeNull();
  });

  it('sales is bounced by the same guard, so it gets the same non-linked card', async () => {
    const { fixture } = await render('sales');
    expect(fixture.nativeElement.querySelector('a[href="/projects/P1"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Read-only project');
  });

  /**
   * THE MIRROR THAT ANCHORS BOTH ABSENCES. Without it a wrong href in the selector —
   * or a stub that renders no rows at all — would make the queries trivially null
   * while the dead link survived. It is also the case that must still be ALLOWED: a
   * gate that always refuses passes every assertion above.
   */
  it('still links the card for a role the guard admits', async () => {
    const { fixture } = await render('pm');
    const link = fixture.nativeElement.querySelector('a[href="/projects/P1"]');
    expect(link).not.toBeNull();
    expect(link.textContent).toContain('Read-only project');
    expect(fixture.nativeElement.querySelector('.before\\:inset-0')).not.toBeNull();
  });
});
