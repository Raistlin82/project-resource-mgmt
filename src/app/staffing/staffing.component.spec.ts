import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { StaffingComponent } from './staffing.component';
import { ApiService, Assignment, Resource, ResourceOrganization, ResourceRequest } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/** Two plain internal resources — enough to exercise the "no request selected" list mode. */
const RESOURCES: Resource[] = [
  { id: '1', name: 'Alice', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '2', name: 'Bob', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];

function setup(overrides: { resources?: Resource[]; requests?: ResourceRequest[]; orgNodes?: ResourceOrganization[] } = {}) {
  const getRequests = vi.fn(() => of(overrides.requests ?? []));
  const getResources = vi.fn(() => of(overrides.resources ?? RESOURCES));
  // D (Task 8): the org tree the capability/practice/competence filters derive from.
  const getResourceOrganizations = vi.fn(() => of(overrides.orgNodes ?? []));
  const createAssignment = vi.fn(() => of({} as Assignment));
  const apiStub = { getRequests, getResources, getResourceOrganizations, createAssignment } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [StaffingComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(StaffingComponent);
  return { fixture, getRequests, getResources, createAssignment, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('StaffingComponent', () => {
  it('renders the plain resource list when no request is selected', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  describe('org-dimension and people-manager filters (D, Task 8)', () => {
    /**
     * D (Task 8): Engineering (capability) > Platform (practice) > Backend
     * (competence), plus Consulting, a capability with no children of its own —
     * same ids the real seed uses ('2'/'5'/'6').
     */
    const ORG_NODES: ResourceOrganization[] = [
      { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
      { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
      { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
      { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
    ];

    /** Jane Doe sits on Backend (competence, two levels under Engineering);
     *  John Miller sits directly on Consulting (a capability with no children).
     *  Each has a distinct People Manager. */
    const ORG_RESOURCES: Resource[] = [
      { id: '10', name: 'Jane Doe', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Backend', managerId: 'm1' },
      { id: '11', name: 'John Miller', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Consulting', managerId: 'm2' },
      { id: 'm1', name: 'Mona Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
      { id: 'm2', name: 'Nora Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
    ];

    it('filters the list by capability', async () => {
      // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
      // one on 'Consulting' (a capability of its own).
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');        // on Backend, under Engineering
      expect(names).not.toContain('John Miller'); // on Consulting
    });

    it('offers only the dimensions that exist in the tree', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
        .map(o => o.value);
      expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
    });

    it('filters the list by practice and by competence', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.practiceFilter.set('Platform');
      fixture.detectChanges();
      let names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);

      fixture.componentInstance.practiceFilter.set('');
      fixture.componentInstance.competenceFilter.set('Backend');
      fixture.detectChanges();
      names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);
    });

    it('filters the list by People Manager and offers only the managers present', async () => {
      const { fixture } = setup({ resources: ORG_RESOURCES, orgNodes: ORG_NODES });
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="manager-filter"] option')]
        .map(o => o.textContent?.trim());
      expect(opts).toEqual(['All people managers', 'Mona Manager', 'Nora Manager']);

      fixture.componentInstance.managerFilter.set('m1');
      fixture.detectChanges();
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toEqual(['Jane Doe']);
    });
  });
});
