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
