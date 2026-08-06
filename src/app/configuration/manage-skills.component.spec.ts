import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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

function setup(skills: Skill[] = SKILLS) {
  const getSkills = vi.fn(() => of(skills));
  const getSkillCatalogs = vi.fn(() => of([] as SkillCatalog[]));
  const getProficiencySets = vi.fn(() => of([] as ProficiencySet[]));
  const createSkill = vi.fn(() => of({} as Skill));
  const updateSkill = vi.fn(() => of({} as Skill));
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
  return { fixture, deleteSkill, notifyStub };
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
