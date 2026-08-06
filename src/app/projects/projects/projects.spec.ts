import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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

function makeApiStub() {
  return {
    getProjects: vi.fn(() => of([project])),
    getContracts: vi.fn(() => of([])),
    getResources: vi.fn(() => of([])),
    getCountries: vi.fn(() => of([])),
    getCities: vi.fn(() => of([])),
    createProject: vi.fn(() => of(project)),
    updateProject: vi.fn(() => of(project)),
    deleteProject: vi.fn(() => of(undefined)),
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

async function render(role: UserRole) {
  const api = makeApiStub();
  TestBed.configureTestingModule({
    imports: [ProjectsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
    ],
  });
  const fixture = TestBed.createComponent(ProjectsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, api };
}

describe('Projects role affordances and dependency loading', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not load forbidden contracts for a PM, while keeping project actions available', async () => {
    const { fixture, api } = await render('pm');
    expect(api.getContracts).not.toHaveBeenCalled();
    expect(api.getResources).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain('Create Project');
    expect(fixture.nativeElement.querySelector('[aria-label="Edit project"]')).not.toBeNull();
  });

  it('keeps finance project browsing read-only and skips form-only dependencies', async () => {
    const { fixture, api, component } = await render('finance');
    expect(api.getContracts).toHaveBeenCalledOnce();
    expect(api.getResources).not.toHaveBeenCalled();
    expect(api.getCountries).not.toHaveBeenCalled();
    expect(api.getCities).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('Create Project');
    expect(fixture.nativeElement.querySelector('[aria-label="Edit project"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Delete project"]')).toBeNull();

    component.openCreateForm();
    component.deleteProject(project.id);
    component.confirmDelete();
    expect(component.showForm()).toBe(false);
    expect(api.deleteProject).not.toHaveBeenCalled();
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
