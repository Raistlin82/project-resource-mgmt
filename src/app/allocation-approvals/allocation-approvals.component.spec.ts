import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AllocationApprovalsComponent } from './allocation-approvals.component';
import { AllocationApprovalFeed, ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';

/** Two resources over one month: Ada has a pending month, Bob only approved work. */
const FEED: AllocationApprovalFeed = {
  months: ['2026-09'],
  rows: [
    {
      resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 88 },
      items: [{ assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 88, approvalId: 'AR1' }],
    },
    {
      resourceId: 'r2', resourceName: 'Bob', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 176 },
      items: [{ assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 176 }],
    },
  ],
};

function setup(ready: boolean) {
  const getAllocationApprovals = vi.fn(() => of(FEED));
  const apiStub = { getAllocationApprovals } as unknown as ApiService;
  // `role`/`userId` are read by the embedded ApprovalModalComponent's
  // decidability check; an admin can decide any step, so the modal cases below
  // exercise the modal itself rather than the gate.
  const authStub = {
    authReady: signal(ready), isAuthenticated: signal(ready),
    role: signal('admin'), userId: signal('m1'),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [AllocationApprovalsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });
  const fixture = TestBed.createComponent(AllocationApprovalsComponent);
  return { fixture, getAllocationApprovals };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AllocationApprovalsComponent', () => {
  it('renders one row per resource once auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const rows = host.querySelectorAll('[data-test="approval-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Ada');
    expect(rows[0].textContent).toContain('88');
    expect(getAllocationApprovals).toHaveBeenCalled();
  });

  it('seeds the From/To selects to the loaded window in the actual DOM, not just the signal', async () => {
    // Regression for the reported bug: the <select>'s live DOM `.value` must
    // match the seeded from/to signal (the loaded window), not just the signal
    // itself — a mismatch here means the browser silently fell back to the
    // first padded option because [value] was applied before the @for's
    // <option> elements existed.
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const fromEl = host.querySelector('select[aria-label="Range start month"]') as HTMLSelectElement;
    const toEl = host.querySelector('select[aria-label="Range end month"]') as HTMLSelectElement;
    expect(fromEl).not.toBeNull();
    expect(toEl).not.toBeNull();

    expect(fixture.componentInstance['from']()).toBe('2026-09');
    expect(fixture.componentInstance['to']()).toBe('2026-09');
    // The assertion that actually catches the bug: the live DOM value.
    expect(fromEl.value).toBe('2026-09');
    expect(toEl.value).toBe('2026-09');
  });

  it('does not call the API before auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(false);
    await flush(fixture);
    expect(getAllocationApprovals).not.toHaveBeenCalled();
  });

  it('toggles a resource into the selection', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const checkbox = host.querySelector('[data-test="select-resource"]') as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedResourceIds().has('r1')).toBe(true);
  });

  it('enables multi-approve only with more than one resource selected', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
    fixture.detectChanges();
    expect((host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the modal in multi mode with a section per selected resource', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('[data-test="multi-approve"]')!.click();
    fixture.detectChanges();

    expect(host.querySelector('[data-test="approve-continue"]')).not.toBeNull();
    const sections = host.querySelectorAll('[data-test="resource-section"]');
    expect(sections.length).toBe(2);
    const names = Array.from(sections).map(s => s.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Ada', 'Bob']));
  });
});
