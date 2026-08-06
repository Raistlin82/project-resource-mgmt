import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ManageSkillCatalogsComponent } from './manage-skill-catalogs.component';
import { ApiService, SkillCatalog } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * TWO catalogs, deliberately. The defect this file pins is a cross-row one — an
 * armed id that outlives its only warning, so a later click destroys the wrong
 * object — and a single-row fixture cannot express it at all. Same reasoning as
 * manage-skills.component.spec.ts, the landed sibling.
 */
const CATALOGS: SkillCatalog[] = [
  { id: 'C1', name: 'ESCO Core', description: 'Baseline taxonomy', skills: ['1', '2'] },
  { id: 'C2', name: 'Cloud Platforms', description: 'Hyperscaler skills', skills: ['3'] },
];

function setup(catalogs: SkillCatalog[] = CATALOGS) {
  const getSkillCatalogs = vi.fn(() => of(catalogs));
  const createSkillCatalog = vi.fn(() => of({} as SkillCatalog));
  const deleteSkillCatalog = vi.fn(() => of(undefined as unknown as void));
  const apiStub = { getSkillCatalogs, createSkillCatalog, deleteSkillCatalog } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageSkillCatalogsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageSkillCatalogsComponent);
  return { fixture, deleteSkillCatalog, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** The `<tr>` whose Name cell holds this catalog. */
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

const lastToast = (notifyStub: NotificationService) =>
  (notifyStub.show as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)![0];

describe('ManageSkillCatalogsComponent delete confirmation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('arms the row on the first click and does NOT delete', async () => {
    // THE DEFECT: the old shape armed an invisible `pendingDeleteId` and announced
    // it only in a toast that auto-dismisses after 5s. Nothing on the row showed it
    // was armed, and the armed id never expired — so a stale click deleted an entire
    // skill catalog with no dialog and no undo.
    const { fixture, deleteSkillCatalog } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();

    expect(deleteSkillCatalog).not.toHaveBeenCalled();
  });

  it('renders the armed state INSIDE the row — a Confirm control and the catalog name', async () => {
    // Scoped to the row element, NOT the document: the pre-fix implementation already
    // put the word "confirm" in a toast, so a document-wide query would have passed
    // against the defect.
    const { fixture } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();

    const armedRow = rowFor(fixture, 'ESCO Core');
    expect(controlIn(armedRow, /confirm/i)).not.toBeNull();
    expect(armedRow.textContent).toContain('Delete ESCO Core?');
    // ABSENCE HALF: while armed, the row must not still offer the plain trash
    // control — an armed state hiding behind an unchanged icon is the defect.
    expect(controlIn(armedRow, /^Delete catalog ESCO Core$/)).toBeNull();
  });

  it('deletes only when the row-scoped Confirm control is clicked', async () => {
    // The case that must still be ALLOWED: a guard that always refuses would pass
    // every negative test in this file.
    const { fixture, deleteSkillCatalog } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'ESCO Core'), /confirm/i)!.click();
    fixture.detectChanges();

    expect(deleteSkillCatalog).toHaveBeenCalledTimes(1);
    expect(deleteSkillCatalog).toHaveBeenCalledWith('C1');
  });

  it('never lets an armed row destroy a DIFFERENT row that is clicked next', async () => {
    // The recorded failure, exactly: arm ESCO Core, walk away, then click another
    // row's trash icon. Under the old two-step nothing on screen said which row was
    // armed, so the next click wrote blind against a stale id.
    const { fixture, deleteSkillCatalog } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Cloud Platforms'), /^Delete catalog Cloud Platforms$/)!.click();
    fixture.detectChanges();

    expect(deleteSkillCatalog).not.toHaveBeenCalled();
    // Arming moved with the click: only one row is ever armed, and it is the one
    // just clicked — so the armed object is always the object on screen.
    expect(controlIn(rowFor(fixture, 'Cloud Platforms'), /confirm/i)).not.toBeNull();
    expect(controlIn(rowFor(fixture, 'ESCO Core'), /confirm/i)).toBeNull();
    expect(controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)).not.toBeNull();
  });

  it('disarms on Cancel, and a fresh arm + Confirm still deletes', async () => {
    const { fixture, deleteSkillCatalog } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'ESCO Core'), /^cancel$/i)!.click();
    fixture.detectChanges();

    expect(deleteSkillCatalog).not.toHaveBeenCalled();
    expect(controlIn(rowFor(fixture, 'ESCO Core'), /confirm/i)).toBeNull();

    // ABSENCE TWIN for "Cancel disarms": the screen must not be left permanently
    // unable to delete either.
    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'ESCO Core'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(deleteSkillCatalog).toHaveBeenCalledTimes(1);
  });

  it('names the catalog and the dead-reference consequence in the arming toast', async () => {
    // The old copy — "Click delete again to confirm removing this catalog" — named
    // neither the object nor what breaks. DELETE /skill-catalogs/:id has no
    // referential guard (src/server.ts:4346) and a skill stores its catalogs as an
    // array of ids, so every skill grouped under the catalog keeps a dead id and
    // renders "Unknown" on /config/skills.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'ESCO Core'), /^Delete catalog ESCO Core$/)!.click();
    fixture.detectChanges();

    const message = lastToast(notifyStub);
    expect(message).toContain('ESCO Core');
    expect(message).toMatch(/skills/i);
    // The instruction that made the toast load-bearing is gone: the row carries the
    // affordance now, so the copy must not tell the admin to click the icon again.
    expect(message).not.toMatch(/again/i);
  });

  it('names the SECOND catalog when the second row is armed — the copy interpolates', async () => {
    // ABSENCE TWIN for the toast: a message that hard-coded "ESCO Core" would pass
    // the case above. It must not name the catalog that is NOT being deleted.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Cloud Platforms'), /^Delete catalog Cloud Platforms$/)!.click();
    fixture.detectChanges();

    const message = lastToast(notifyStub);
    expect(message).toContain('Cloud Platforms');
    expect(message).not.toContain('ESCO Core');
  });
});
