import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ResourceRequestsComponent } from './resource-requests.component';
import { ApiService, Assignment, ResourceRequest, Skill } from '../services/api.service';
import { AuthService } from '../services/auth.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Microtask ticks, not whenStable(): whenStable HANGS while an rxResource stream is
 *  open. Same idiom as project-issues.spec.ts / project-rates.spec.ts. */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const ACTOR = 'U-actor';

/** Withdrawn, so the row exposes Edit / Publish / Delete — and a Withdrawn request
 *  has usually been staffed already, which is the whole reason its delete is
 *  dangerous. */
const WITHDRAWN: ResourceRequest = {
  id: 'R-7', name: 'Backend engineer', requiredRole: 'Developer', requiredEffort: 80,
  staffedEffort: 40, status: 'Withdrawn', skills: ['Java'], requesterId: ACTOR,
};

const ASSIGNMENT: Assignment = {
  id: 'A-3', requestId: 'R-7', resourceId: 'R1', assignedHours: 40, status: 'Allocated',
} as Assignment;

const SKILLS: Skill[] = [
  { id: 'S1', name: 'Java' } as Skill,
  { id: 'S2', name: 'JavaScript' } as Skill,
];

type ApiOverrides = Partial<Record<string, unknown>>;

function makeApiStub(overrides: ApiOverrides = {}) {
  const base: Record<string, (...args: never[]) => unknown> = {
    getRequests: () => of([WITHDRAWN]),
    getAssignments: () => of([ASSIGNMENT]),
    getResources: () => of([]),
    getProjectRoles: () => of([]),
    getSkills: () => of(SKILLS),
    createRequest: () => of(WITHDRAWN),
    updateRequest: () => of(WITHDRAWN),
    deleteRequest: () => of(undefined),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService & Record<string, ReturnType<typeof vi.fn>>;
}

async function render(overrides: ApiOverrides = {}) {
  const api = makeApiStub(overrides);
  TestBed.configureTestingModule({
    imports: [ResourceRequestsComponent],
    providers: [
      { provide: ApiService, useValue: api },
      // authReady() true AND userId() equal to the fixture's requesterId: myRequests()
      // filters on requesterId === auth.userId(), so a fixture whose identity is wrong
      // renders an empty table and every row assertion below would pass vacuously.
      { provide: AuthService, useValue: { authReady: () => true, userId: () => ACTOR } },
    ],
  });
  const fixture: ComponentFixture<ResourceRequestsComponent> = TestBed.createComponent(ResourceRequestsComponent);
  await tick(fixture);
  return { fixture, api };
}

function deleteButton(fixture: ComponentFixture<ResourceRequestsComponent>): HTMLButtonElement {
  const btn = host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="Delete request ${WITHDRAWN.name}"]`);
  expect(btn, 'the row delete button must be rendered — check the fixture identity if it is not').toBeTruthy();
  return btn!;
}

function confirmRegion(fixture: ComponentFixture<ResourceRequestsComponent>): HTMLElement | null {
  return host(fixture).querySelector<HTMLElement>('[data-test="request-delete-confirm"]');
}

describe('ResourceRequestsComponent — deleting a request is confirmed and names what is staffed against it', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the FIRST click issues no deleteRequest and names the request, its effort and the assignments left behind', async () => {
    // THE DEFECT: the trash icon fired DELETE on a single click. The only comment in
    // the handler read "In a real app, use a custom modal here instead of
    // window.confirm" — and there was no window.confirm either. Delete is offered for
    // 'Not Published' and 'Withdrawn' requests, and a Withdrawn request is normally
    // already staffed, so the assignments hanging off it are the consequence.
    const { fixture, api } = await render();

    expect(confirmRegion(fixture), 'nothing may be armed before the first click').toBeNull();

    deleteButton(fixture).click();
    await tick(fixture);

    expect(api.deleteRequest).not.toHaveBeenCalled();

    const dialog = confirmRegion(fixture);
    expect(dialog, 'the confirm dialog must be armed').toBeTruthy();
    const text = dialog!.textContent ?? '';
    expect(text).toContain('Backend engineer');
    expect(text).toContain('Developer');
    expect(text).toContain('80h');
    expect(text).toMatch(/cannot be undone/i);
    // The staffed branch, matched on its OWN element rather than on the dialog text:
    // the unstaffed sentence would also satisfy a loose /staffed/ match.
    const staffed = dialog!.querySelector<HTMLElement>('[data-test="request-delete-staffed"]');
    expect(staffed, 'the staffed-consequence sentence must render for a request with assignments').toBeTruthy();
    expect(staffed!.textContent).toContain('1 assignment(s)');
    expect(dialog!.querySelector('[data-test="request-delete-unstaffed"]')).toBeNull();
  });

  it('MUST say nothing is staffed when the request has no assignments — the branch that keeps the count honest', async () => {
    // The assertion of ABSENCE for the count. Without it, a hard-coded warning
    // sentence (or a count read off the wrong collection) passes the case above.
    const { fixture } = await render({ getAssignments: () => of([] as Assignment[]) });

    deleteButton(fixture).click();
    await tick(fixture);

    const dialog = confirmRegion(fixture)!;
    expect(dialog.querySelector('[data-test="request-delete-unstaffed"]')).toBeTruthy();
    expect(dialog.querySelector('[data-test="request-delete-staffed"]')).toBeNull();
  });

  it('only the confirm control issues the DELETE, and a double-click issues exactly one', async () => {
    const { fixture, api } = await render();
    deleteButton(fixture).click();
    await tick(fixture);

    const confirm = confirmRegion(fixture)!.querySelector<HTMLButtonElement>('[data-test="request-delete-confirm-action"]')!;
    confirm.click();
    confirm.click();
    await tick(fixture);

    expect(api.deleteRequest).toHaveBeenCalledTimes(1);
    expect(api.deleteRequest).toHaveBeenCalledWith('R-7');
  });

  it('MUST STILL let Cancel abandon the delete', async () => {
    const { fixture, api } = await render();
    deleteButton(fixture).click();
    await tick(fixture);

    const cancel = Array.from(confirmRegion(fixture)!.querySelectorAll<HTMLButtonElement>('button'))
      .find(b => b.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await tick(fixture);

    expect(api.deleteRequest).not.toHaveBeenCalled();
    expect(confirmRegion(fixture)).toBeNull();
  });
});

describe('ResourceRequestsComponent — the view segmented control exposes its own state', () => {
  afterEach(() => TestBed.resetTestingModule());

  function pressedPair(fixture: ComponentFixture<ResourceRequestsComponent>): (string | null)[] {
    const h = host(fixture);
    return [
      h.querySelector('[data-test="view-requests"]')!.getAttribute('aria-pressed'),
      h.querySelector('[data-test="view-availability"]')!.getAttribute('aria-pressed'),
    ];
  }

  it('reports the active view as the PAIR ["true","false"], and flips it on selection', async () => {
    // THE DEFECT: which view was active was carried by background and text colour
    // only, so a screen reader announced two identical plain buttons.
    //
    // Asserted as the PAIR, deliberately. `getAttribute('aria-pressed')` is truthy
    // even when it is the string 'false', so a presence-only check ("the attribute is
    // there") is satisfied by an attribute that never changes — and an attribute set
    // on the active button ALONE is indistinguishable from a control that is never
    // pressed. Only the pair pins the state.
    const { fixture } = await render();
    expect(pressedPair(fixture)).toStrictEqual(['true', 'false']);

    host(fixture).querySelector<HTMLButtonElement>('[data-test="view-availability"]')!.click();
    await tick(fixture);

    expect(pressedPair(fixture)).toStrictEqual(['false', 'true']);
  });
});

describe('ResourceRequestsComponent — required skills without Ctrl/Cmd, and without losing orphan values', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders NO multiple-selection list box anywhere on the screen', async () => {
    // THE NEGATIVE ASSERTION THAT CANNOT DRIFT. Chips rendered alongside a surviving
    // <select multiple> would satisfy any positive-only check, so the load-bearing
    // claim is the absence of the control that required Ctrl/Cmd — impossible on
    // touch, where picking a second skill silently replaced the first.
    const { fixture } = await render();
    fixture.componentInstance.openCreateForm();
    await tick(fixture);

    expect(host(fixture).querySelector('select[multiple]')).toBeNull();
  });

  it('MUST STILL offer the catalog and add a chosen skill to the model — the positive twin', async () => {
    // Without this, deleting the control outright would pass the assertion above.
    const { fixture } = await render();
    const component = fixture.componentInstance;
    component.openCreateForm();
    await tick(fixture);

    const picker = host(fixture).querySelector<HTMLSelectElement>('#skills')!;
    expect(Array.from(picker.options).map(o => o.value)).toStrictEqual(['', 'Java', 'JavaScript']);

    picker.value = 'JavaScript';
    picker.dispatchEvent(new Event('change'));
    await tick(fixture);
    host(fixture).querySelector<HTMLButtonElement>('[data-test="add-skill"]')!.click();
    await tick(fixture);

    expect(component.requestForm.controls.skills.value).toStrictEqual(['JavaScript']);
    expect(Array.from(host(fixture).querySelectorAll('[data-test="selected-skill-label"]')).map(c => c.textContent?.trim()))
      .toStrictEqual(['JavaScript']);
    // The just-added entry stops being offered a second time — that filters the
    // OPTIONS, never the model.
    const after = host(fixture).querySelector<HTMLSelectElement>('#skills')!;
    expect(Array.from(after.options).map(o => o.value)).toStrictEqual(['', 'Java']);
  });

  it('keeps an ORPHAN skill in the model: editing a request with a skill absent from the catalog leaves exactly the orphan behind', async () => {
    // THE DATA RISK. The model is the raw string[]; intersecting it with the option
    // list would silently drop a stored skill the catalog no longer carries, and
    // requiredSkills feed match-scoring, so the loss is invisible until staffing
    // misses. Control ['Java','LegacySkill'] against options ['Java','JavaScript']:
    // removing 'Java' must leave EXACTLY ['LegacySkill'].
    const { fixture } = await render();
    const component = fixture.componentInstance;

    component.openEditForm({ ...WITHDRAWN, skills: ['Java', 'LegacySkill'] });
    await tick(fixture);

    expect(component.selectedSkills()).toStrictEqual(['Java', 'LegacySkill']);
    // The orphan is rendered as a chip like any other — selectable state is the model,
    // not the catalog — and it is flagged so the user knows why it is unusual.
    const chips = Array.from(host(fixture).querySelectorAll<HTMLElement>('[data-test="selected-skill-label"]'))
      .map(c => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips).toStrictEqual(['Java', 'LegacySkill (not in catalog)']);

    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Remove Java"]')!.click();
    await tick(fixture);

    expect(component.requestForm.controls.skills.value).toStrictEqual(['LegacySkill']);
  });

  it('saves the raw array, orphan included', async () => {
    // The end-to-end half: the orphan has to reach the PUT body, not merely render.
    const { fixture, api } = await render();
    const component = fixture.componentInstance;

    component.openEditForm({ ...WITHDRAWN, skills: ['Java', 'LegacySkill'] });
    await tick(fixture);
    component.saveRequest();
    await tick(fixture);

    expect(api.updateRequest).toHaveBeenCalledWith('R-7', expect.objectContaining({
      skills: ['Java', 'LegacySkill'],
    }));
  });
});

describe('ResourceRequestsComponent — form and lifecycle guardrails', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('announces the revealed editor and focuses its heading', async () => {
    const { fixture } = await render();

    const trigger = host(fixture).querySelector<HTMLButtonElement>('[aria-controls="requestEditor"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click();
    await tick(fixture);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(host(fixture).querySelector('#requestEditorTitle'));
  });

  it('keeps submit operable, explains invalid fields inline, and focuses the first error', async () => {
    const { fixture, api } = await render();
    fixture.componentInstance.openCreateForm();
    await tick(fixture);

    const save = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Save Request')!;
    expect(save.disabled).toBe(false);
    save.click();
    await tick(fixture);

    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Project name is required.');
    expect(text).toContain('Select a required role.');
    expect(text).toContain('Required effort must be at least 1 hour.');
    expect(document.activeElement).toBe(host(fixture).querySelector('#name'));
    expect(api.createRequest).not.toHaveBeenCalled();
  });

  it('asks before discarding a dirty request draft', async () => {
    const { fixture } = await render();
    const component = fixture.componentInstance;
    component.openCreateForm();
    await tick(fixture);
    component.requestForm.controls.name.setValue('Unsaved request');
    component.requestForm.controls.name.markAsDirty();

    component.closeForm();
    await tick(fixture);
    expect(component.showForm()).toBe(true);
    expect(host(fixture).textContent).toContain('Discard unsaved request changes?');

    component.closeForm(true);
    await tick(fixture);
    expect(component.showForm()).toBe(false);
  });

  it('publishes only after a named confirmation and guards duplicate confirmation', async () => {
    const { fixture, api } = await render();
    host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="Publish request ${WITHDRAWN.name} (${WITHDRAWN.id})"]`)!.click();
    await tick(fixture);

    expect(api.updateRequest).not.toHaveBeenCalled();
    const dialog = host(fixture).querySelector<HTMLElement>('[data-test="request-transition-confirm"]')!;
    expect(dialog.textContent).toContain(WITHDRAWN.name);
    expect(dialog.textContent).toContain(WITHDRAWN.id);
    expect(dialog.textContent).toContain('40h remaining');

    const confirm = dialog.querySelector<HTMLButtonElement>('[data-test="request-transition-confirm-action"]')!;
    confirm.click();
    confirm.click();
    await tick(fixture);
    expect(api.updateRequest).toHaveBeenCalledTimes(1);
    expect(api.updateRequest).toHaveBeenCalledWith(WITHDRAWN.id, { status: 'Published' });
  });

  it('states the consequence of withdrawing a fulfilled request with linked assignments', async () => {
    const fulfilled = { ...WITHDRAWN, status: 'Fulfilled' };
    const { fixture, api } = await render({ getRequests: () => of([fulfilled]) });
    host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="Withdraw request ${fulfilled.name} (${fulfilled.id})"]`)!.click();
    await tick(fixture);

    const dialog = host(fixture).querySelector<HTMLElement>('[data-test="request-transition-confirm"]')!;
    expect(dialog.querySelector('[data-test="withdraw-consequence"]')?.textContent).toContain('1 existing assignment(s)');
    expect(dialog.textContent).toContain('This request is fulfilled');
    expect(api.updateRequest).not.toHaveBeenCalled();
  });

  it('shows a retryable read error instead of an empty requests table', async () => {
    const { fixture, api } = await render({ getRequests: () => throwError(() => new Error('offline')) });
    const element = host(fixture);

    expect(element.textContent).toContain("Couldn't load resource requests");
    expect(element.textContent).not.toContain('No resource requests found.');
    element.querySelector<HTMLButtonElement>('.command-card.border-critical\\! button')!.click();
    await tick(fixture);
    expect(api.getRequests).toHaveBeenCalledTimes(2);
  });
});
