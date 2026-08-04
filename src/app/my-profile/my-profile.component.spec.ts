import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { MyProfileComponent } from './my-profile.component';
import { ApiService, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

const profile = {
  id: '1',
  name: 'Self Service User',
  role: 'Developer',
  skills: [],
  projectRoles: [],
  externalExperience: [],
  profilePicture: '',
  resume: 'data:application/pdf;base64,x',
  utilization: 50,
  capacity: 40,
  organization: 'Engineering',
  location: 'Rome',
} as Resource;

function makeApiStub() {
  return {
    getMyProfile: vi.fn(() => of(profile)),
    updateMyProfile: vi.fn(() => of(profile)),
    getMyAssignments: vi.fn(() => of([])),
    getMyRequests: vi.fn(() => of([])),
    getResource: vi.fn(() => of(profile)),
    updateResource: vi.fn(() => of(profile)),
    getAssignments: vi.fn(() => of([])),
    getRequests: vi.fn(() => of([])),
    getProjectRoles: vi.fn(() => of([])),
    getSkills: vi.fn(() => of([])),
    getProficiencySets: vi.fn(() => of([])),
  };
}

async function render(hasResourceIdentity = true) {
  const api = makeApiStub();
  const auth = {
    authReady: signal(true),
    userId: signal(hasResourceIdentity ? '1' : ''),
    hasResourceIdentity: signal(hasResourceIdentity),
  };
  TestBed.configureTestingModule({
    imports: [MyProfileComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
      { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn(), show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(MyProfileComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, api };
}

describe('MyProfile self-service API boundary', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('loads only self-scoped profile, assignments and requests', async () => {
    const { api } = await render();
    expect(api.getMyProfile).toHaveBeenCalledOnce();
    expect(api.getMyAssignments).toHaveBeenCalledOnce();
    expect(api.getMyRequests).toHaveBeenCalledOnce();
    expect(api.getResource).not.toHaveBeenCalled();
    expect(api.getAssignments).not.toHaveBeenCalled();
    expect(api.getRequests).not.toHaveBeenCalled();
  });

  it('writes profile changes through the self-scoped endpoint', async () => {
    const { component, api } = await render();
    component.removeResume();
    expect(api.updateMyProfile).toHaveBeenCalledWith({ resume: '' });
    expect(api.updateResource).not.toHaveBeenCalled();
  });

  it('does not query any person when the OIDC identity has no resource mapping', async () => {
    const { api } = await render(false);
    expect(api.getMyProfile).not.toHaveBeenCalled();
    expect(api.getMyAssignments).not.toHaveBeenCalled();
    expect(api.getMyRequests).not.toHaveBeenCalled();
    expect(api.getResource).not.toHaveBeenCalled();
  });
});
