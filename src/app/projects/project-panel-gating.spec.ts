import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ProjectPartners } from './project-partners/project-partners';
import { FinancialPlans } from './financial-plans/financial-plans';
import { ProjectIssues } from './project-issues/project-issues';
import { ProjectCostCenters } from './project-cost-centers/project-cost-centers';
import { ProjectPlans } from './project-plans/project-plans';
import { ProjectDocuments } from './project-documents/project-documents';
import { ProjectTasks } from './project-tasks/project-tasks';

// =============================================================================
// P2-18 — "disabled with the reason beside it", proved as ONE convention.
//
// Seven project panels each had a create control whose only possible outcome,
// with no project in scope, was a toast telling you so AFTER the click. All
// seven now disable the control and state the reason next to it.
//
// This is deliberately ONE table-driven file rather than seven describes spread
// across seven specs, because uniformity IS the requirement: three screens
// disabling and four still toasting would be worse than the seven-way toast it
// replaced. A single table makes a reverted screen — or an eighth screen added
// with the old pattern — fail here, in one place.
//
// The source scan at the bottom is this file's absence assertion at the level of
// the CONVENTION, not of a single screen: without it, deleting a row from the
// table below would silently shrink coverage while every remaining test stayed
// green.
// =============================================================================

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Microtask ticks, not whenStable(): whenStable HANGS while an rxResource
 *  stream is open. Same idiom as the sibling panel specs. */
async function tick(fixture: { detectChanges: () => void }, microtasks = 6): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

/**
 * Every `getX()` any of the seven panels reaches for, answered with an empty
 * list. The panels are mounted for their HEADER only — the gate and its reason
 * live above the data — so empty collections are not a shortcut here: they are
 * the standalone-no-project state under test.
 *
 * A Proxy rather than seven hand-written stubs: the assertion is about a control
 * in a header, and enumerating each panel's data calls would couple this file to
 * changes that have nothing to do with the gate.
 */
function permissiveApi(): ApiService {
  return new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (prop === 'then') return undefined; // never mistaken for a thenable
      target[prop] ??= vi.fn(() => of([]));
      return target[prop];
    },
  }) as unknown as ApiService;
}

/**
 * A fully-permitted principal. `authReady()` must be true or every
 * authGatedResource stays on its empty default; every `can…()` predicate must be
 * true or a panel that gates its own body — financial-plans on
 * `canApproveFinancials`, project-cost-centers on `canReadCommercial` — renders
 * nothing and the control under test is simply absent.
 *
 * Granting everything is what makes this file test the GATE rather than the
 * permission: the `expect(b).not.toBeNull()` in both cases below is the guard
 * that a permission-hidden panel can never pass as a passing assertion.
 */
function permissiveAuth(): AuthService {
  const fixed: Record<string, unknown> = {
    authReady: () => true,
    role: () => 'admin',
    userId: () => '1',
  };
  return new Proxy(fixed, {
    get: (target, prop: string) => {
      if (prop === 'then') return undefined;
      target[prop] ??= () => true;
      return target[prop];
    },
  }) as unknown as AuthService;
}

interface PanelCase {
  readonly label: string;
  readonly component: Type<{ selectedProjectId: { set(v: string): void } }>;
  /** `data-test` of each control gated by the same precondition. */
  readonly controls: readonly string[];
  /** `data-test` of the shared reason, and the id it publishes. */
  readonly hint: string;
  readonly hintId: string;
}

// project-plans is the one screen with TWO gated controls, and they share ONE
// reason: two <p> elements reading "Select a project first." would make a screen
// reader announce the same sentence once per button.
const PANELS: readonly PanelCase[] = [
  { label: 'project-partners',     component: ProjectPartners,    controls: ['invite-partner'],                    hint: 'invite-partner-hint',        hintId: 'invitePartnerHint' },
  { label: 'financial-plans',      component: FinancialPlans,     controls: ['create-financial-plan'],             hint: 'create-financial-plan-hint', hintId: 'createFinancialPlanHint' },
  { label: 'project-issues',       component: ProjectIssues,      controls: ['create-issue'],                      hint: 'create-issue-hint',          hintId: 'createIssueHint' },
  { label: 'project-cost-centers', component: ProjectCostCenters, controls: ['add-cost-center'],                   hint: 'add-cost-center-hint',       hintId: 'addCostCenterHint' },
  { label: 'project-plans',        component: ProjectPlans,       controls: ['add-milestone', 'add-work-package'], hint: 'project-plans-hint',         hintId: 'projectPlansHint' },
  { label: 'project-documents',    component: ProjectDocuments,   controls: ['add-document'],                      hint: 'add-document-hint',          hintId: 'addDocumentHint' },
  { label: 'project-tasks',        component: ProjectTasks,       controls: ['create-task'],                       hint: 'create-task-hint',           hintId: 'createTaskHint' },
];

async function render(c: PanelCase): Promise<ComponentFixture<{ selectedProjectId: { set(v: string): void } }>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [c.component],
    providers: [
      { provide: ApiService, useValue: permissiveApi() },
      { provide: AuthService, useValue: permissiveAuth() },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(c.component);
  // NO `projectId` input: this is the standalone route, where the selector is
  // the only way a project enters scope. Setting it would pin the enabled branch
  // and make the disabled half of every assertion below unreachable.
  await tick(fixture);
  return fixture;
}

const btn = (f: { nativeElement: unknown }, test: string) =>
  host(f).querySelector<HTMLButtonElement>(`[data-test="${test}"]`);

describe.each(PANELS)('P2-18 $label — the create control is gated, not toasted', (c) => {
  it('with NO project in scope: the control is disabled and the reason is present and wired to it', async () => {
    const fixture = await render(c);

    const hint = host(fixture).querySelector(`[data-test="${c.hint}"]`);
    expect(hint, 'the reason must be rendered while the control is unusable').not.toBeNull();
    expect(hint!.id, 'the reason must publish the id the control points at').toBe(c.hintId);
    expect(hint!.textContent?.trim()).toBe('Select a project first.');

    for (const test of c.controls) {
      const b = btn(fixture, test);
      expect(b, `[data-test="${test}"] must exist`).not.toBeNull();
      expect(b!.disabled, `${test} must be disabled with no project`).toBe(true);
      expect(b!.getAttribute('aria-describedby'),
        `${test} must name the reason so a screen reader reaches it`).toBe(c.hintId);
    }
  });

  // THE ABSENCE HALF. Without it, a control disabled unconditionally — and a
  // reason rendered permanently — passes the test above. This is the assertion
  // the earlier, abandoned attempt at this change did not have.
  it('with a project in scope: the control is NOT disabled and the reason is ABSENT from the DOM', async () => {
    const fixture = await render(c);
    fixture.componentInstance.selectedProjectId.set('P1');
    await tick(fixture);

    expect(host(fixture).querySelector(`[data-test="${c.hint}"]`),
      'the reason must not linger once a project is in scope').toBeNull();
    expect(host(fixture).querySelector(`#${c.hintId}`),
      'nothing may keep publishing the reason id once the reason is gone').toBeNull();

    for (const test of c.controls) {
      const b = btn(fixture, test);
      expect(b, `[data-test="${test}"] must still exist`).not.toBeNull();
      expect(b!.disabled, `${test} must be usable once a project is in scope`).toBe(false);
      // Dangling aria-describedby is worse than none: it names an element that
      // no longer exists, so the description silently resolves to nothing.
      expect(b!.hasAttribute('aria-describedby'),
        `${test} must drop aria-describedby, not point at a removed element`).toBe(false);
    }
  });
});

// =============================================================================
// The convention, scanned at the source. Two failure modes no per-screen test
// can see: a screen quietly reverted to the toast, and an eighth screen born
// with the old pattern while all seven rows above stay green.
// =============================================================================
describe('P2-18 — the convention holds across every project panel (source scan)', () => {
  const PANEL_DIR = resolve(__dirname);

  /** The panels that own a project-scoped create control, by folder/file stem. */
  const STEMS = [
    'project-partners/project-partners', 'financial-plans/financial-plans',
    'project-issues/project-issues', 'project-cost-centers/project-cost-centers',
    'project-plans/project-plans', 'project-documents/project-documents',
    'project-tasks/project-tasks',
  ] as const;

  const sourceOf = (stem: string) => readFileSync(resolve(PANEL_DIR, `${stem}.ts`), 'utf8');

  it('covers every panel that has one — the table above is not a subset', () => {
    expect(PANELS.map(p => p.label).sort())
      .toStrictEqual(STEMS.map(s => s.split('/')[1]).sort());
  });

  it('no panel still tells you to select a project AFTER the click', () => {
    const offenders = STEMS.filter(s => sourceOf(s).includes('Please select a project first'));
    expect(offenders, 'these panels still toast the precondition instead of gating it').toStrictEqual([]);
  });

  it('every panel derives the scope once, instead of re-deriving it inline', () => {
    for (const s of STEMS) {
      const src = sourceOf(s);
      expect(src, `${s} must own an activeProjectId computed`)
        .toContain('activeProjectId = computed(() => this.projectId() || this.selectedProjectId())');
      // The inline compound is what let the disabled state and the empty state
      // drift apart; the bare `projectId()` (routed vs embedded) is a DIFFERENT
      // question and legitimately survives.
      expect(src.includes('this.projectId() || this.selectedProjectId()') &&
             src.split('this.projectId() || this.selectedProjectId()').length > 2,
        `${s} still re-derives the scope inline somewhere`).toBe(false);
    }
  });
});
