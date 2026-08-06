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

describe('MyProfile external-experience removal', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Two REAL stints that legitimately share a project name at different companies. */
  const TWO_ATLAS = [
    { projectName: 'Atlas', company: 'Accenture', role: 'Developer', startDate: '2019-01-01', endDate: '2020-01-01' },
    { projectName: 'Atlas', company: 'Deloitte', role: 'Tech Lead', startDate: '2022-01-01', endDate: '2023-01-01' },
  ];

  async function renderWithTwoAtlas() {
    const withDupes = { ...profile, externalExperience: [...TWO_ATLAS] } as Resource;
    const api = { ...makeApiStub(), getMyProfile: vi.fn(() => of(withDupes)) };
    const auth = { authReady: signal(true), userId: signal('1'), hasResourceIdentity: signal(true) };
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

  it('removes the chosen stint and KEEPS the same-named sibling', async () => {
    // THE DEFECT. removeExtExp() filtered on projectName, which is not a key, and the
    // PUT sends the WHOLE array — so deleting either 'Atlas' card wiped both and the
    // server had nothing left to restore the untouched one from.
    //
    // This pair is where the assertion of ABSENCE lives: it is not "one entry was
    // removed" (a name-keyed filter also removes entries) but "the SIBLING SURVIVED,
    // and which one survives depends on which index was asked for". No
    // implementation keyed on projectName can satisfy both halves.
    const first = await renderWithTwoAtlas();
    first.component.removeExtExp(0);
    expect(first.api.updateMyProfile).toHaveBeenCalledWith({
      externalExperience: [expect.objectContaining({ company: 'Deloitte' })],
    });

    TestBed.resetTestingModule();

    const second = await renderWithTwoAtlas();
    second.component.removeExtExp(1);
    expect(second.api.updateMyProfile).toHaveBeenCalledWith({
      externalExperience: [expect.objectContaining({ company: 'Accenture' })],
    });
  });

  it('ignores an out-of-range or non-integer index instead of sending a no-op wipe', async () => {
    // ASSERTION OF ABSENCE #2: a bounds-blind implementation would PUT the full array
    // back (a pointless write, and an audit entry for a change that did not happen),
    // or with a negative index silently drop nothing while claiming success.
    const { component, api } = await renderWithTwoAtlas();
    component.removeExtExp(-1);
    component.removeExtExp(2);
    component.removeExtExp(1.5);
    expect(api.updateMyProfile).not.toHaveBeenCalled();
  });

  it('renders one remove control per stint, each naming its own company', async () => {
    // The aria-label had to change too: two cards labelled 'Remove Atlas' are
    // indistinguishable to a screen-reader user, who then cannot tell which stint
    // they are about to delete. Asserting the PAIR of distinct labels is what pins it.
    const { fixture } = await renderWithTwoAtlas();
    const labels = Array.from(fixture.nativeElement.querySelectorAll('button[aria-label^="Remove Atlas"]'))
      .map(b => (b as HTMLElement).getAttribute('aria-label'));
    expect(labels).toEqual(['Remove Atlas at Accenture', 'Remove Atlas at Deloitte']);
  });
});
