import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ProjectDocuments } from './project-documents';
import { ApiService, Project, ProjectDocument } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open; microtask ticks
 * are the established idiom in this repo (project-issues.spec.ts,
 * project-rates.spec.ts) for letting a synchronous `rxResource` read reach the DOM.
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

const DOC: ProjectDocument = {
  id: 'PD-1', projectId: 'P1', name: 'Signed change order.pdf', type: 'pdf',
  size: '1.0 MB', uploadedAt: '2026-03-02', author: 'Marco Bianchi', authorInitials: 'MB',
};

type ApiOverrides = Partial<Record<string, unknown>>;

function makeApiStub(overrides: ApiOverrides = {}) {
  const base: Record<string, (...args: never[]) => unknown> = {
    getProjects: () => of([PROJECT]),
    getProjectDocuments: () => of([DOC]),
    createProjectDocument: () => of(DOC),
    deleteProjectDocument: () => of(undefined),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService & Record<string, ReturnType<typeof vi.fn>>;
}

async function render(overrides: ApiOverrides = {}) {
  const api = makeApiStub(overrides);
  TestBed.configureTestingModule({
    imports: [ProjectDocuments],
    providers: [
      { provide: ApiService, useValue: api },
      // authReady() MUST be true: every authGatedResource here otherwise stays on
      // its empty default and no document card renders at all — a fixture that lies
      // about readiness certifies an inert feature.
      { provide: AuthService, useValue: { authReady: () => true, displayName: () => 'Julie Armstrong' } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture: ComponentFixture<ProjectDocuments> = TestBed.createComponent(ProjectDocuments);
  fixture.componentRef.setInput('projectId', 'P1');
  await tick(fixture);
  return { fixture, api };
}

function deleteButton(fixture: ComponentFixture<ProjectDocuments>): HTMLButtonElement {
  const btn = host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="Delete ${DOC.name}"]`);
  expect(btn, 'the row delete button must be rendered').toBeTruthy();
  return btn!;
}

function confirmRegion(fixture: ComponentFixture<ProjectDocuments>): HTMLElement | null {
  return host(fixture).querySelector<HTMLElement>('[data-test="document-delete-confirm"]');
}

/**
 * The predicate the dialog copy has to satisfy, kept as a function so the SAME
 * predicate can be pointed at a generic "Are you sure?" string below. A bare
 * confirmation is exactly what this fix is not allowed to be.
 */
function namesObjectAndConsequence(text: string): { namesDocument: boolean; namesAuthor: boolean; statesLoss: boolean; statesNoUndo: boolean } {
  return {
    namesDocument: text.includes(DOC.name),
    namesAuthor: text.includes(DOC.author),
    statesLoss: /not shown anywhere else/i.test(text),
    statesNoUndo: /cannot be undone/i.test(text),
  };
}

describe('ProjectDocuments — deleting a register entry is confirmed, and the confirm states the loss', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the FIRST click issues no deleteProjectDocument and arms a dialog naming the file and its author', async () => {
    // THE DEFECT: the trash icon is hover-revealed (sm:opacity-0 …
    // sm:group-hover:opacity-100) and sat directly on the DELETE. One mis-click
    // removed the only record of the document's name, size, filing date and author
    // attribution, with a green toast as the sole feedback and no undo anywhere.
    const { fixture, api } = await render();

    expect(confirmRegion(fixture), 'nothing may be armed before the first click').toBeNull();

    deleteButton(fixture).click();
    await tick(fixture);

    expect(api.deleteProjectDocument).not.toHaveBeenCalled();

    const dialog = confirmRegion(fixture);
    expect(dialog, 'the confirm dialog must be armed').toBeTruthy();
    expect(namesObjectAndConsequence(dialog!.textContent ?? '')).toStrictEqual({
      namesDocument: true,
      namesAuthor: true,
      statesLoss: true,
      statesNoUndo: true,
    });
  });

  it('rejects a bare "Are you sure?" — the negative control that keeps the copy predicate honest', async () => {
    // NON-VACUOUSNESS. Without this, the predicate above could be satisfied by any
    // dialog at all and the whole point of the finding (name the object, state the
    // consequence) would go unverified. The control is the generic copy this repo
    // has shipped elsewhere.
    expect(namesObjectAndConsequence('Are you sure? This action cannot be undone.')).toStrictEqual({
      namesDocument: false,
      namesAuthor: false,
      statesLoss: false,
      statesNoUndo: true,
    });
  });

  it('only the confirm control issues the DELETE, and exactly once', async () => {
    const { fixture, api } = await render();
    deleteButton(fixture).click();
    await tick(fixture);

    const confirm = confirmRegion(fixture)!.querySelector<HTMLButtonElement>('[data-test="document-delete-confirm-action"]')!;
    confirm.click();
    confirm.click(); // a double-click must not fire two DELETEs
    await tick(fixture);

    expect(api.deleteProjectDocument).toHaveBeenCalledTimes(1);
    expect(api.deleteProjectDocument).toHaveBeenCalledWith('PD-1');
  });

  it('MUST STILL let Cancel abandon the delete, leaving no request and no armed dialog', async () => {
    // The assertion of ABSENCE for the arming half: a confirm that can only ever be
    // accepted, or one that stays armed forever, fails here while passing the cases
    // above.
    const { fixture, api } = await render();
    deleteButton(fixture).click();
    await tick(fixture);

    const cancel = Array.from(confirmRegion(fixture)!.querySelectorAll<HTMLButtonElement>('button'))
      .find(b => b.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await tick(fixture);

    expect(api.deleteProjectDocument).not.toHaveBeenCalled();
    expect(confirmRegion(fixture)).toBeNull();
  });
});

describe('ProjectDocuments — the add dialog survives a refused POST', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the dialog open and the typed name when the POST is refused', async () => {
    // THE DEFECT: closeForm() ran unconditionally right after firing the POST, so
    // docForm.reset() wiped the typed name while the request was still in flight. A
    // 403 (a role outside the /project-documents write set) or a 400 left an error
    // toast over an empty screen.
    const { fixture } = await render({
      createProjectDocument: () => throwError(() => new HttpErrorResponse({ status: 403 })),
    });
    const component = fixture.componentInstance;

    component.openForm();
    component.docForm.setValue({ name: 'Requirements_Spec.docx', type: 'word' });
    component.saveDocument();
    await tick(fixture);

    expect(component.showForm()).toBe(true);
    expect(component.docForm.controls.name.value).toBe('Requirements_Spec.docx');
    expect(component.docForm.controls.type.value).toBe('word');
  });

  it('MUST STILL close and reset when the POST is accepted', async () => {
    // The assertion of ABSENCE: "never close the dialog" passes the case above and
    // fails here, so the two together pin the actual behaviour.
    const { fixture } = await render();
    const component = fixture.componentInstance;

    component.openForm();
    component.docForm.setValue({ name: 'Requirements_Spec.docx', type: 'word' });
    component.saveDocument();
    await tick(fixture);

    expect(component.showForm()).toBe(false);
    expect(component.docForm.controls.name.value).toBeNull();
    expect(component.docForm.controls.type.value).toBe('pdf');
  });
});

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /project-documents route
// and a tab panel inside project-details, which renders its own h1 (the project
// name). `headingLevel` is the one mechanism all eight embeddable panels use; the
// twin of these cases — that /projects/:id still has exactly ONE h1 with a panel
// open — lives in project-details.spec.ts.
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

describe('ProjectDocuments — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Documents';

  /** The /project-documents route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<ProjectDocuments> {
    TestBed.configureTestingModule({
      imports: [ProjectDocuments],
      providers: [
        { provide: ApiService, useValue: makeApiStub() },
        { provide: AuthService, useValue: { authReady: () => true, displayName: () => 'Julie Armstrong' } },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.createComponent(ProjectDocuments);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<ProjectDocuments> {
    const fixture = renderStandalone();
    fixture.componentRef.setInput('projectId', 'P1');
    fixture.componentRef.setInput('headingLevel', 2);
    return fixture;
  }

  it('standalone: EXACTLY ONE h1, and it carries the screen title', async () => {
    const fixture = renderStandalone();
    await tick(fixture);
    // RED before the fix: 0 — the title was an h2 and the route had no h1 at all.
    // COUNTED, not looked up: querySelector('h1') would also pass with two. The
    // count also rules out the document CARD titles being promoted: they are h3.
    const h1s = host(fixture).querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(TITLE);
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — the absence twin', async () => {
    const fixture = renderEmbedded();
    await tick(fixture);
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
    expect(headingFor(fixture, TITLE).tagName).not.toBe('H3');
    expect(host(fixture).querySelector('select[aria-label="Select project"]')).toBeNull();
    // The document card really is on screen, so this is not a count over an
    // empty panel — and the card title stays an h3 UNDER the h2 title.
    expect(headingFor(fixture, DOC.name).tagName).toBe('H3');
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
