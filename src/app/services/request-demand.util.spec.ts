import { describe, expect, it } from 'vitest';
import { isWorkableUncoveredRequest, residualStaffingEffort } from './request-demand.util';

function request(
  status: string,
  requiredEffort: number,
  staffedEffort?: number,
) {
  return { status, requiredEffort, staffedEffort };
}

describe('request demand definition', () => {
  it.each(['Open', 'Published', ' open ', 'PUBLISHED'])(
    'treats %s with residual confirmed effort as workable uncovered demand',
    status => {
      expect(isWorkableUncoveredRequest(request(status, 15, 8))).toBe(true);
      expect(residualStaffingEffort(request(status, 15, 8))).toBe(7);
    },
  );

  it.each(['Fulfilled', 'Withdrawn', 'Not Published', 'Closed'])(
    'does not expose %s as workable demand even when effort remains',
    status => expect(isWorkableUncoveredRequest(request(status, 15, 0))).toBe(false),
  );

  it('excludes exact and over-staffing for both workable statuses', () => {
    expect(isWorkableUncoveredRequest(request('Open', 15, 15))).toBe(false);
    expect(isWorkableUncoveredRequest(request('Published', 15, 20))).toBe(false);
    expect(residualStaffingEffort(request('Published', 15, 20))).toBe(0);
  });

  it('normalizes missing or negative effort without manufacturing a gap', () => {
    expect(residualStaffingEffort(request('Open', -10, undefined))).toBe(0);
    expect(isWorkableUncoveredRequest(request('Open', -10, undefined))).toBe(false);
    expect(residualStaffingEffort(request('Open', 10, -5))).toBe(10);
  });
});
