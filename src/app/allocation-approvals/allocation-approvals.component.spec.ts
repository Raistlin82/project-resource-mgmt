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
      resourceId: 'r1', resourceName: 'Ada', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 88 },
      items: [{ assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 88 }],
    },
    {
      resourceId: 'r2', resourceName: 'Bob', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 176 },
      items: [{ assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 176 }],
    },
  ],
};

function setup(ready: boolean) {
  const getAllocationApprovals = vi.fn(() => of(FEED));
  const apiStub = { getAllocationApprovals } as unknown as ApiService;
  const authStub = { authReady: signal(ready), isAuthenticated: signal(ready) } as unknown as AuthService;

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
});
