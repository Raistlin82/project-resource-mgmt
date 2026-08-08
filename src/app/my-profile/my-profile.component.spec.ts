import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, Subject, of, throwError } from 'rxjs';
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

/** Declared signature for the write stub: several tests assert on the PATCH BODY
 *  via `mock.calls[n][0]`, and an untyped vi.fn() records a zero-length tuple. */
type UpdateMyProfile = (patch: Partial<Resource>) => Observable<Resource>;

function makeApiStub() {
  return {
    getMyProfile: vi.fn(() => of(profile)),
    updateMyProfile: vi.fn<UpdateMyProfile>(() => of(profile)),
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

type ApiStub = ReturnType<typeof makeApiStub>;

/** Configures the TestBed without creating the component, so a caller can watch
 *  the very first change-detection pass (the error case must not throw there). */
function configure(opts: {
  api?: Partial<ApiStub>;
  authReady?: boolean;
  hasResourceIdentity?: boolean;
} = {}) {
  const api = { ...makeApiStub(), ...opts.api } as ApiStub;
  const hasResourceIdentity = opts.hasResourceIdentity ?? true;
  const auth = {
    authReady: signal(opts.authReady ?? true),
    userId: signal(hasResourceIdentity ? '1' : ''),
    hasResourceIdentity: signal(hasResourceIdentity),
  };
  const notify = { success: vi.fn(), error: vi.fn(), show: vi.fn() };
  TestBed.configureTestingModule({
    imports: [MyProfileComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return { api, auth, notify };
}

async function render(opts: Parameters<typeof configure>[0] = {}) {
  const { api, auth, notify } = configure(opts);
  const fixture = TestBed.createComponent(MyProfileComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, api, auth, notify };
}

const text = (fixture: ComponentFixture<MyProfileComponent>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';

/** A percent sign with no digit in front of it — i.e. "Average Utilization: %". */
const BARE_PERCENT = /(?<!\d)%/;

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
    // removeResume() now only ARMS the confirmation (see the destructive-removal
    // suite below), so the write is driven from confirmRemoveResume(). The
    // invariant under test here is unchanged: the PUT goes to /self, never to
    // the arbitrary-person /resources/:id endpoint.
    const { component, api } = await render();
    component.removeResume();
    component.confirmRemoveResume();
    expect(api.updateMyProfile).toHaveBeenCalledWith({ resume: '' });
    expect(api.updateResource).not.toHaveBeenCalled();
  });

  it('does not query any person when the OIDC identity has no resource mapping', async () => {
    const { api } = await render({ hasResourceIdentity: false });
    expect(api.getMyProfile).not.toHaveBeenCalled();
    expect(api.getMyAssignments).not.toHaveBeenCalled();
    expect(api.getMyRequests).not.toHaveBeenCalled();
    expect(api.getResource).not.toHaveBeenCalled();
  });
});

describe('MyProfile page read state (loading / not-linked / failed are three different facts)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows a skeleton and no bare percent sign while the OIDC bootstrap has not settled', async () => {
    const { fixture } = await render({ authReady: false });
    expect(fixture.nativeElement.querySelector('.command-skeleton')).not.toBeNull();
    // The header used to print "Average Utilization: %" — a percent with nothing
    // in front of it — for a profile that had not been read yet. Asserting the
    // ABSENCE of a digitless '%' is the point; asserting that some number is
    // present would be satisfied by any other figure on the page.
    expect(text(fixture)).not.toMatch(BARE_PERCENT);
    expect(text(fixture)).not.toContain('Availability (Next 6 Months)');
  });

  it('shows the utilization figure and no skeleton once the profile has resolved', async () => {
    // MIRROR of the case above: a fix that pinned the skeleton on forever, or
    // that deleted the utilization card, passes the first half and fails here.
    const { fixture } = await render();
    expect(fixture.nativeElement.querySelector('.command-skeleton')).toBeNull();
    expect(text(fixture)).toMatch(/(?<!\d)50%/);
    expect(text(fixture)).toContain('Availability (Next 6 Months)');
  });

  it('says the account is not linked to a resource record instead of rendering a blank page', async () => {
    const { fixture } = await render({ hasResourceIdentity: false });
    expect(text(fixture)).toMatch(/not linked/);
    expect(fixture.nativeElement.querySelector('.command-skeleton')).toBeNull();
    expect(text(fixture)).not.toContain("Couldn't load your profile");
  });

  it('does NOT claim the account is unlinked when a real profile resolved', async () => {
    // MIRROR: a permanently-rendered notice would pass the case above.
    const { fixture } = await render();
    expect(text(fixture)).not.toMatch(/not linked/);
  });

  it('renders an error panel with Retry, and raises no exception, when the profile read fails', async () => {
    configure({ api: { getMyProfile: vi.fn(() => throwError(() => new Error('boom'))) } });
    const fixture = TestBed.createComponent(MyProfileComponent);

    // The assertion is the ABSENCE of a thrown error, not the presence of a
    // class name: dataRes.value() throws ResourceValueError while erroring, and
    // the ungated utilization binding sat ABOVE the error branch, so the whole
    // change-detection pass aborted and the panel below was unreachable code.
    let raised: unknown = null;
    try {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeNull();

    expect(text(fixture)).toContain("Couldn't load your profile");
    const retry = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find(b => ((b as HTMLElement).textContent ?? '').match(/retry/i));
    expect(retry).toBeDefined();
    // And a failed read must not be dressed up as an unlinked identity.
    expect(text(fixture)).not.toMatch(/not linked/);
  });

  it('shows no error panel when the read succeeds', async () => {
    // MIRROR: an always-on error panel would pass the case above.
    const { fixture } = await render();
    expect(text(fixture)).not.toContain("Couldn't load your profile");
  });
});

describe('MyProfile touch actions', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps picture, skill and experience actions visible with 44px-square targets', async () => {
    const touchProfile = {
      ...profile,
      skills: [{ name: 'TypeScript', level: 3 }],
      externalExperience: [{
        projectName: 'Atlas', company: 'Deloitte', role: 'Tech Lead',
        startDate: '2022-01-01', endDate: '2023-01-01',
      }],
    } as Resource;
    const { fixture } = await render({
      api: { getMyProfile: vi.fn(() => of(touchProfile)) },
    });
    const h = fixture.nativeElement as HTMLElement;
    const controls = [
      h.querySelector<HTMLElement>('label[aria-label="Upload profile picture"]'),
      h.querySelector<HTMLElement>('button[aria-label="Remove TypeScript"]'),
      h.querySelector<HTMLElement>('button[aria-label="Remove Atlas at Deloitte"]'),
    ];

    expect(controls.every(Boolean)).toBe(true);
    for (const control of controls) {
      const tokens = control!.className.split(/\s+/);
      expect(tokens).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
      expect(tokens.some(token => token.includes('opacity-0') || token.includes('group-hover'))).toBe(false);
    }

    const experienceCard = controls[2]!.parentElement!;
    expect(experienceCard.className.split(/\s+/)).toContain('pr-16');
  });
});

describe('MyProfile whole-array write serialization', () => {
  afterEach(() => TestBed.resetTestingModule());

  const JAVA = { name: 'Java', level: 3 };
  const PYTHON = { name: 'Python', level: 2 };
  const GO = { name: 'Go', level: 1 };

  /**
   * Steps Angular's scheduler on without waiting for stability.
   *
   * `fixture.whenStable()` cannot be used where a read is deliberately left
   * pending: ResourceImpl holds a PendingTask for the whole duration of a load,
   * so whenStable() would never resolve — and holding the RELOAD open is the
   * entire point of the fixture below.
   */
  async function step(fixture: ComponentFixture<MyProfileComponent>) {
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('refuses a second array write derived from the pre-reload array, and allows one after the reload lands', async () => {
    // THE DEFECT. Every handler rebuilds a WHOLE array from profile(), and
    // profile() only changes when the reload lands. Removing Java then Python
    // ~250 ms apart sent PUT #2 computed from the stale [Java, Python, Go], so
    // the server ended up with Python gone and JAVA BACK.
    const reloads: Subject<Resource>[] = [];
    const puts: Subject<Resource>[] = [];
    const { api } = configure({
      api: {
        getMyProfile: vi.fn(() => {
          const s = new Subject<Resource>();
          reloads.push(s);
          return s;
        }),
        updateMyProfile: vi.fn<UpdateMyProfile>(() => {
          const s = new Subject<Resource>();
          puts.push(s);
          return s;
        }),
      },
    });
    const fixture = TestBed.createComponent(MyProfileComponent);
    const component = fixture.componentInstance;
    await step(fixture);

    // Initial load resolves with three skills.
    expect(reloads).toHaveLength(1);
    reloads[0].next({ ...profile, skills: [JAVA, PYTHON, GO] } as Resource);
    reloads[0].complete();
    await step(fixture);

    component.removeSkill('Java');
    expect(api.updateMyProfile).toHaveBeenCalledTimes(1);
    expect(api.updateMyProfile.mock.calls[0][0]).toStrictEqual({ skills: [PYTHON, GO] });

    // PUT #1 answers; the reload it asks for has NOT landed yet.
    puts[0].next({ ...profile, skills: [PYTHON, GO] } as Resource);
    puts[0].complete();

    component.removeSkill('Python');
    // RED before the fix: called twice, the second with { skills: [Java, Go] } —
    // Python gone and JAVA BACK. Verified by running this fixture against the
    // unguarded handler.
    expect(api.updateMyProfile).toHaveBeenCalledTimes(1);

    // ASSERTION OF ABSENCE: the lock must not be a permanent latch. Once the
    // reload settles, a further removal has to go out — and it has to be
    // computed from the FRESH array, so Java is not resurrected here either.
    await step(fixture);
    expect(reloads).toHaveLength(2);
    reloads[1].next({ ...profile, skills: [PYTHON, GO] } as Resource);
    reloads[1].complete();
    await step(fixture);

    component.removeSkill('Go');
    expect(api.updateMyProfile).toHaveBeenCalledTimes(2);
    expect(api.updateMyProfile.mock.calls[1][0]).toStrictEqual({ skills: [PYTHON] });
  });

  it('releases the write lock when the PUT fails, so the controls come back', async () => {
    // ASSERTION OF ABSENCE #2: a guard that always refuses satisfies every
    // "the second write did not fire" check. A rejected write leaves the
    // server's arrays on screen, so the user must be able to try again.
    const puts: Subject<Resource>[] = [];
    const { api } = configure({
      api: {
        getMyProfile: vi.fn(() => of({ ...profile, skills: [JAVA, PYTHON] } as Resource)),
        updateMyProfile: vi.fn<UpdateMyProfile>(() => {
          const s = new Subject<Resource>();
          puts.push(s);
          return s;
        }),
      },
    });
    const fixture = TestBed.createComponent(MyProfileComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.removeSkill('Java');
    expect(api.updateMyProfile).toHaveBeenCalledTimes(1);
    puts[0].error(new Error('403'));
    await fixture.whenStable();

    component.removeSkill('Python');
    expect(api.updateMyProfile).toHaveBeenCalledTimes(2);
    expect(api.updateMyProfile.mock.calls[1][0]).toStrictEqual({ skills: [JAVA] });
  });

  it('disables the skill remove buttons while a write is outstanding', async () => {
    const puts: Subject<Resource>[] = [];
    configure({
      api: {
        getMyProfile: vi.fn(() => of({ ...profile, skills: [JAVA, PYTHON] } as Resource)),
        updateMyProfile: vi.fn<UpdateMyProfile>(() => {
          const s = new Subject<Resource>();
          puts.push(s);
          return s;
        }),
      },
    });
    const fixture = TestBed.createComponent(MyProfileComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const chipButtons = () =>
      Array.from(
        fixture.nativeElement.querySelectorAll('button[aria-label^="Remove Java"], button[aria-label^="Remove Python"]'),
      ) as HTMLButtonElement[];

    // Enabled before the write — the "must still be allowed" half, without
    // which a permanently disabled button would pass.
    expect(chipButtons()).toHaveLength(2);
    expect(chipButtons().map(b => b.disabled)).toStrictEqual([false, false]);

    component.removeSkill('Java');
    fixture.detectChanges();
    expect(chipButtons().map(b => b.disabled)).toStrictEqual([true, true]);
  });
});

describe('MyProfile resume removal', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not delete the resume on the first click; only the dialog confirm writes', async () => {
    const { fixture, component, api } = await render();
    const trigger = fixture.nativeElement.querySelector('button[aria-label="Remove resume"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    trigger.click();
    fixture.detectChanges();
    // ASSERTION OF ABSENCE: the first click used to send the wipe outright.
    expect(api.updateMyProfile).not.toHaveBeenCalled();

    // The dialog has to name the object AND state the consequence, so a bare
    // "Are you sure?" cannot pass.
    const dialog = fixture.nativeElement.querySelector('[appModal]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent ?? '').toMatch(/resume/i);
    expect(dialog.textContent ?? '').toMatch(/only stored copy/i);
    expect(dialog.textContent ?? '').toMatch(/cannot be undone/i);

    component.confirmRemoveResume();
    expect(api.updateMyProfile).toHaveBeenCalledTimes(1);
    expect(api.updateMyProfile.mock.calls[0][0]).toStrictEqual({ resume: '' });
  });

  it('cancelling closes the dialog and writes nothing', async () => {
    const { fixture, component, api } = await render();
    component.removeResume();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[appModal]')).not.toBeNull();

    component.cancelRemoveResume();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[appModal]')).toBeNull();
    expect(api.updateMyProfile).not.toHaveBeenCalled();
  });

  it('does not arm the dialog when there is no resume to remove', async () => {
    const { fixture, component } = await render({
      api: { getMyProfile: vi.fn(() => of({ ...profile, resume: '' } as Resource)) },
    });
    component.removeResume();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[appModal]')).toBeNull();
  });
});

describe('MyProfile availability strip', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  /** Only `Date` is faked: Angular's own scheduling must keep running. */
  function pinClock(date: Date) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(date);
  }

  /** The same formatter the component uses, so the expectation is not tied to
   *  the CI locale (an it-IT runner yields 'ago 2026', not 'Aug 2026'). */
  const monthName = (year: number, month: number) =>
    new Date(year, month, 1).toLocaleString('default', { month: 'short', year: 'numeric' });

  it('lists six CONSECUTIVE months when the clock is on a 31st (the month-end date is the whole fixture)', async () => {
    // 31 August 2026 local. The old code mutated one Date with setMonth(8),
    // i.e. "31 September", which JS normalises to 1 October: September vanished
    // and the strip silently spanned seven months (Aug, Oct, Nov, Dec, Jan, Feb).
    pinClock(new Date(2026, 7, 31, 9, 0));
    const { component } = await render();

    // Primary, locale-independent red: the SHAPE of the sequence.
    expect(component.nextSixMonths).toHaveLength(6);
    expect(component.nextSixMonths.map(m => m.index)).toStrictEqual([7, 8, 9, 10, 11, 0]);

    // Labels derived through the same formatter, so this cannot fail on locale.
    expect(component.nextSixMonths.map(m => m.name)).toStrictEqual([
      monthName(2026, 7), monthName(2026, 8), monthName(2026, 9),
      monthName(2026, 10), monthName(2026, 11), monthName(2027, 0),
    ]);
  });

  it('skips no month on 31 January either (the 28/29-day February case)', async () => {
    pinClock(new Date(2026, 0, 31, 9, 0));
    const { component } = await render();
    expect(component.nextSixMonths.map(m => m.index)).toStrictEqual([0, 1, 2, 3, 4, 5]);
  });

  it('still lists the ordinary mid-month sequence', async () => {
    // The case that must KEEP working. It also documents why the fixtures above
    // are pinned to a 31st: this same assertion passed with the bug in place.
    pinClock(new Date(2026, 7, 15, 9, 0));
    const { component } = await render();
    expect(component.nextSixMonths.map(m => m.index)).toStrictEqual([7, 8, 9, 10, 11, 0]);
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
    return render({ api: { getMyProfile: vi.fn(() => of(withDupes)) } });
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
