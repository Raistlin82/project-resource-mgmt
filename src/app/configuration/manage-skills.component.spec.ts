import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, type Observable } from 'rxjs';
import { ManageSkillsComponent } from './manage-skills.component';
import { ApiService, Skill, SkillCatalog, ProficiencySet } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * TWO skills, deliberately. The defect this file pins is a cross-row one — an
 * armed id that outlives its only warning, so a later click on a DIFFERENT row's
 * trash icon destroys the wrong object — and a single-row fixture cannot express
 * it at all.
 */
const SKILLS: Skill[] = [
  { id: 'S1', conceptUri: 'esco/kubernetes', name: 'Kubernetes', description: '', catalogs: [], restricted: false },
  { id: 'S2', conceptUri: 'esco/terraform', name: 'Terraform', description: '', catalogs: [], restricted: false },
];

/** Two catalogs, so an orphan catalog id can be told apart from a known one. */
const CATALOGS: SkillCatalog[] = [
  { id: 'C1', name: 'ESCO Core', description: '', skills: [] },
  { id: 'C2', name: 'Cloud', description: '', skills: [] },
];

function setup(skills: Skill[] = SKILLS, catalogs: SkillCatalog[] = CATALOGS) {
  const getSkills = vi.fn(() => of(skills));
  const getSkillCatalogs = vi.fn(() => of(catalogs));
  const getProficiencySets = vi.fn(() => of([] as ProficiencySet[]));
  const createSkill = vi.fn<(skill: Partial<Skill>) => Observable<Skill>>(() => of({} as Skill));
  const updateSkill = vi.fn<(id: string, skill: Partial<Skill>) => Observable<Skill>>(() => of({} as Skill));
  const deleteSkill = vi.fn(() => of(undefined));
  const apiStub = {
    getSkills, getSkillCatalogs, getProficiencySets, createSkill, updateSkill, deleteSkill,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageSkillsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageSkillsComponent);
  return { fixture, createSkill, updateSkill, deleteSkill, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** The `<tr>` whose Name cell holds this skill. */
function rowFor(fixture: { nativeElement: HTMLElement }, name: string): HTMLTableRowElement {
  const row = Array.from(fixture.nativeElement.querySelectorAll<HTMLTableRowElement>('tbody tr'))
    .find(tr => tr.textContent?.includes(name));
  expect(row, `no row rendered for ${name}`).toBeTruthy();
  return row!;
}

/**
 * Accessible name of a control, the way a screen reader resolves it: an explicit
 * aria-label wins, otherwise the text content. Used to find controls WITHIN a row
 * — never document-wide, or the toast container could satisfy the query.
 */
function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

function controlIn(row: HTMLElement, pattern: RegExp): HTMLButtonElement | null {
  return Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => pattern.test(accessibleName(b))) ?? null;
}

describe('ManageSkillsComponent delete confirmation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('arms the row on the first click and does NOT delete', async () => {
    // THE DEFECT: the old shape armed an invisible `pendingDeleteId` and announced
    // it only in a toast that auto-dismisses after 5s. Nothing on the row showed it
    // was armed, and the armed id never expired.
    const { fixture, deleteSkill } = setup();
    await flush(fixture);

    const row = rowFor(fixture, 'Kubernetes');
    controlIn(row, /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();

    expect(deleteSkill).not.toHaveBeenCalled();
  });

  it('renders the armed state INSIDE the row — a Confirm control and the skill name', async () => {
    // Scoped to the row element, NOT the document: the pre-fix implementation
    // already put the word "confirm" in a toast, so a document-wide query would
    // have passed against the defect.
    const { fixture } = setup();
    await flush(fixture);

    const row = rowFor(fixture, 'Kubernetes');
    controlIn(row, /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();

    const armedRow = rowFor(fixture, 'Kubernetes');
    expect(controlIn(armedRow, /confirm/i)).not.toBeNull();
    expect(armedRow.textContent).toContain('Delete Kubernetes?');
    // ABSENCE HALF: while armed, the row must not still offer the plain trash
    // control — an armed state hiding behind an unchanged icon is the defect.
    expect(controlIn(armedRow, /^Delete Kubernetes$/)).toBeNull();
  });

  it('deletes only when the row-scoped Confirm control is clicked', async () => {
    // The case that must still be ALLOWED: a guard that always refuses would pass
    // every negative test in this file.
    const { fixture, deleteSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)!.click();
    fixture.detectChanges();

    expect(deleteSkill).toHaveBeenCalledTimes(1);
    expect(deleteSkill).toHaveBeenCalledWith('S1');
  });

  it('never lets an armed row destroy a DIFFERENT row that is clicked next', async () => {
    // The recorded failure, exactly: arm Kubernetes, walk away, then click another
    // row's trash icon. Under the old two-step that second click deleted whatever
    // matched the stale armed id; here it can only re-arm.
    const { fixture, deleteSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Terraform'), /^Delete Terraform$/)!.click();
    fixture.detectChanges();

    expect(deleteSkill).not.toHaveBeenCalled();
    // Arming moved with the click: only one row is ever armed, and it is the one
    // just clicked — so the armed object is always the object on screen.
    expect(controlIn(rowFor(fixture, 'Terraform'), /confirm/i)).not.toBeNull();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)).toBeNull();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)).not.toBeNull();
  });

  it('disarms on Cancel, and a fresh arm + Confirm still deletes', async () => {
    const { fixture, deleteSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /^cancel$/i)!.click();
    fixture.detectChanges();

    expect(deleteSkill).not.toHaveBeenCalled();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)).toBeNull();

    // ABSENCE TWIN for "Cancel disarms": the screen must not be left permanently
    // unable to delete either.
    controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(deleteSkill).toHaveBeenCalledTimes(1);
  });

  it('names the skill and the catalog consequence in the arming toast', async () => {
    // The old copy — "Click delete again to confirm removing this skill" — named
    // neither the object nor what breaks (resource profiles keep a skill name that
    // is no longer in the catalog, and validation then blocks re-saving them).
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();

    const message = (notifyStub.show as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)![0];
    expect(message).toContain('Kubernetes');
    expect(message).toMatch(/catalog/i);
    // The instruction that made the toast load-bearing is gone: the row carries the
    // affordance now, so the copy must not tell the admin to click the icon again.
    expect(message).not.toMatch(/again/i);
  });
});

describe('ManageSkillsComponent CSV import availability', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not expose a file picker for an unsupported import flow', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('CSV import coming soon'))!;

    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('skillsImportStatus');
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector('#skillsImportStatus')?.textContent).toContain('preview, validation, and confirmation');
  });
});

/**
 * The restrict toggle used to PUT on a SINGLE click — no arming, no confirmation, no
 * undo — while the delete beside it on the SAME row had already been given the
 * row-rendered arm/Confirm shape. One control on the screen was guarded and its
 * sibling was not. Same shape as manage-project-roles.component.ts, which is the
 * landed reference.
 */
describe('ManageSkillsComponent restrict confirmation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('arms the row on the first click and does NOT write', async () => {
    const { fixture, updateSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();

    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('renders the armed state INSIDE the row — a Confirm control and the skill name', async () => {
    // Scoped to the row element, NOT the document: a toast carrying the word "confirm"
    // would satisfy a document-wide query while the row still looked untouched.
    const { fixture } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();

    const armedRow = rowFor(fixture, 'Kubernetes');
    expect(controlIn(armedRow, /confirm/i)).not.toBeNull();
    expect(armedRow.textContent).toContain('Restrict Kubernetes?');
    // ABSENCE HALF: while armed, the row must not still offer the plain toggle — an
    // armed state hiding behind an unchanged icon is the defect.
    expect(controlIn(armedRow, /^Restrict Kubernetes$/)).toBeNull();
  });

  it('writes only when the row-scoped Confirm control is clicked, and sends the flipped flag', async () => {
    // The case that must still be ALLOWED: a guard that always refuses would pass
    // every negative assertion in this block.
    const { fixture, updateSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)!.click();
    fixture.detectChanges();

    expect(updateSkill).toHaveBeenCalledTimes(1);
    expect(updateSkill).toHaveBeenCalledWith('S1', { restricted: true });
  });

  it('unrestricts in the other direction, with the row copy following the row', async () => {
    // Both directions matter: this one control restricts AND unrestricts, so a fix
    // that only guarded the restricting direction would leave half the write unarmed.
    const { fixture, updateSkill } = setup([
      { id: 'S1', conceptUri: 'esco/kubernetes', name: 'Kubernetes', description: '', catalogs: [], restricted: true },
    ]);
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Unrestrict Kubernetes$/)!.click();
    fixture.detectChanges();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(rowFor(fixture, 'Kubernetes').textContent).toContain('Unrestrict Kubernetes?');

    controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(updateSkill).toHaveBeenCalledWith('S1', { restricted: false });
  });

  it('never lets an armed row flip a DIFFERENT row that is clicked next', async () => {
    const { fixture, updateSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Terraform'), /^Restrict Terraform$/)!.click();
    fixture.detectChanges();

    expect(updateSkill).not.toHaveBeenCalled();
    // Arming moved with the click: only one row is ever armed, and it is the one just
    // clicked — so the armed object is always the object on screen.
    expect(controlIn(rowFor(fixture, 'Terraform'), /confirm/i)).not.toBeNull();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)).toBeNull();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)).not.toBeNull();
  });

  it('arming the restrict toggle does not arm the delete on the same row, and vice versa', async () => {
    // The two controls sit in one cell and must stay independent, or arming one would
    // silently offer to Confirm the other — the worst possible mis-click on this screen.
    const { fixture, updateSkill, deleteSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();
    let row = rowFor(fixture, 'Kubernetes');
    expect(row.textContent).toContain('Restrict Kubernetes?');
    expect(row.textContent).not.toContain('Delete Kubernetes?');
    expect(controlIn(row, /^Delete Kubernetes$/)).not.toBeNull();

    controlIn(row, /^Delete Kubernetes$/)!.click();
    fixture.detectChanges();
    row = rowFor(fixture, 'Kubernetes');
    expect(row.textContent).toContain('Delete Kubernetes?');
    expect(row.textContent).toContain('Restrict Kubernetes?'); // still armed, independently
    expect(updateSkill).not.toHaveBeenCalled();
    expect(deleteSkill).not.toHaveBeenCalled();
  });

  it('disarms on Cancel, and a fresh arm + Confirm still writes', async () => {
    const { fixture, updateSkill } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /^cancel$/i)!.click();
    fixture.detectChanges();

    expect(updateSkill).not.toHaveBeenCalled();
    expect(controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)).toBeNull();

    // ABSENCE TWIN for "Cancel disarms": the screen must not be left permanently
    // unable to restrict either.
    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Kubernetes'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(updateSkill).toHaveBeenCalledTimes(1);
  });

  it('names the skill and the direction in the arming toast, and promises no enforcement the app lacks', async () => {
    // NOTHING filters skills on `restricted`: my-profile, resource-requests and this
    // screen all list every skill, and the server builds its valid-name set from every
    // row (skillNames() in src/server.ts), so a restricted skill still validates on a
    // resource and on a request. The copy therefore must not claim the skill becomes
    // unusable — the same correction the vendors dialog was given.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Kubernetes'), /^Restrict Kubernetes$/)!.click();
    fixture.detectChanges();

    const message = (notifyStub.show as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)![0];
    expect(message).toContain('Kubernetes');
    expect(message).toMatch(/restricting/i);
    expect(message).toMatch(/marks the catalog entry only/i);
    // The affordance is in the row now, so the copy must not tell the admin to click
    // the icon again — and it must not promise an enforcement that does not exist.
    expect(message).not.toMatch(/again/i);
    expect(message).not.toMatch(/cannot be (staffed|used|selected|picked)/i);
  });
});

/**
 * UX register P2-19 — the Catalogs field was a `<select multiple>`, so holding a
 * second catalog required a Ctrl/Cmd-click that does not exist on touch: picking a
 * second one silently replaced the first.
 */
describe('ManageSkillsComponent catalogs field — no Ctrl/Cmd, no dropped ids', () => {
  afterEach(() => TestBed.resetTestingModule());

  function chipsPicker(fixture: { nativeElement: HTMLElement }): HTMLSelectElement {
    return fixture.nativeElement.querySelector<HTMLSelectElement>('[data-test="chips-picker"]')!;
  }

  function chipLabels(fixture: { nativeElement: HTMLElement }): string[] {
    return Array.from(fixture.nativeElement.querySelectorAll<HTMLElement>('[data-test="chip-label"]'))
      .map(c => c.textContent!.replace(/\s+/g, ' ').trim());
  }

  function addCatalog(fixture: { nativeElement: HTMLElement; detectChanges: () => void }, id: string): void {
    const picker = chipsPicker(fixture);
    picker.value = id;
    picker.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-test="chips-add"]')!.click();
    fixture.detectChanges();
  }

  it('renders NO multiple-selection list box on the screen', async () => {
    // THE NEGATIVE ASSERTION THAT CANNOT DRIFT: chips rendered alongside a surviving
    // <select multiple> pass any positive-only check.
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openCreateForm();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('select[multiple]')).toBeNull();
  });

  it('MUST STILL offer the catalogs and add two of them without replacing the first', async () => {
    // The positive twin — without it, deleting the field outright passes the assertion
    // above — and the touch failure verbatim: the second pick used to replace the first.
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openCreateForm();
    fixture.detectChanges();

    expect(Array.from(chipsPicker(fixture).options).map(o => o.value)).toStrictEqual(['', 'C1', 'C2']);

    addCatalog(fixture, 'C1');
    addCatalog(fixture, 'C2');

    expect(fixture.componentInstance.skillForm.get('catalogs')!.value).toStrictEqual(['C1', 'C2']);
    expect(chipLabels(fixture)).toStrictEqual(['ESCO Core', 'Cloud']);
  });

  it('keeps the label pointing at a real control', async () => {
    // The field's <label for="skillCatalogs"> stayed on the screen; the id has to land
    // on the focusable element inside the chips control or the label names nothing.
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openCreateForm();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('label[for="skillCatalogs"]')).not.toBeNull();
    expect(chipsPicker(fixture).id).toBe('skillCatalogs');
  });

  it('sends the raw catalog ids on create', async () => {
    const { fixture, createSkill } = setup();
    await flush(fixture);
    fixture.componentInstance.openCreateForm();
    fixture.detectChanges();
    fixture.componentInstance.skillForm.patchValue({ name: 'Kafka' });
    addCatalog(fixture, 'C2');

    fixture.componentInstance.onSubmit();

    expect(createSkill).toHaveBeenCalledTimes(1);
    expect(createSkill.mock.calls[0][0].catalogs).toStrictEqual(['C2']);
  });
});
