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
