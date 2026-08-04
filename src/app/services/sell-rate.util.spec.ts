import { describe, it, expect } from 'vitest';
import { sellRateFor, type NegotiatedRate, type SellRateContract, type SellRateProject } from './sell-rate.util';

const CONTRACTS: SellRateContract[] = [
  { id: 'C1', startDate: '2026-01-01', endDate: '2026-12-31' },
  { id: 'C2', startDate: '2026-06-01' },                       // open-ended
];
const PROJECTS: SellRateProject[] = [
  { id: 'P1', contractId: 'C1' },
  { id: 'P2', contractId: 'C1' },
  { id: 'P3', contractId: 'C2' },
  { id: 'P9' },                                                 // no contract
];
const RATES: NegotiatedRate[] = [
  { id: 'N1', contractId: 'C1', role: 'Developer', currency: 'EUR', billRate: 1000 },
  { id: 'N2', projectId: 'P2', role: 'Developer', currency: 'EUR', billRate: 1100 },
  { id: 'N3', contractId: 'C1', role: 'Designer', currency: 'USD', billRate: 900 },
  { id: 'N4', projectId: 'P9', role: 'Developer', currency: 'EUR', billRate: 1300 },
];

const call = (o: Partial<Parameters<typeof sellRateFor>[0]> = {}) => sellRateFor({
  projectId: 'P1', role: 'Developer', date: '2026-03-01', referenceBillRate: 1200,
  rates: RATES, projects: PROJECTS, contracts: CONTRACTS, ...o,
});

describe('sellRateFor — precedence', () => {
  it('uses the contract rate inside the contract period', () => {
    expect(call()).toBe(1000);
  });

  it('lets a project override beat the contract rate', () => {
    expect(call({ projectId: 'P2' })).toBe(1100);
  });

  it('falls back to the reference rate outside the contract period', () => {
    // C1 ends 2026-12-31; these hours are dated after it.
    expect(call({ date: '2027-02-01' })).toBe(1200);
  });

  it('honours an open-ended contract with no endDate', () => {
    expect(call({ projectId: 'P3', date: '2030-01-01', rates: [
      { id: 'N5', contractId: 'C2', role: 'Developer', currency: 'EUR', billRate: 950 },
    ] })).toBe(950);
  });

  it('does not apply a contract rate to hours before the contract started', () => {
    expect(call({ date: '2025-12-31' })).toBe(1200);
  });

  it('applies a project override with no date limit when the project has no contract', () => {
    expect(call({ projectId: 'P9', date: '2099-01-01' })).toBe(1300);
  });

  it('ignores a rate in a non-base currency', () => {
    expect(call({ role: 'Designer' })).toBe(1200);   // N3 is USD
  });

  it('falls back for a role nobody negotiated', () => {
    expect(call({ role: 'QA Engineer' })).toBe(1200);
  });

  it('returns the reference rate when the table is empty — the no-regression guarantee', () => {
    expect(call({ rates: [] })).toBe(1200);
  });

  it('returns undefined when there is no rate anywhere and no reference', () => {
    expect(call({ rates: [], referenceBillRate: undefined })).toBeUndefined();
  });

  it('DOES NOT let a higher personal reference beat the negotiated price', () => {
    // The case that would only surface at month end, on a wrong invoice: the
    // customer signed 1000, so 1000 is billed even though this person's own
    // reference rate is 1500.
    expect(call({ referenceBillRate: 1500 })).toBe(1000);
  });

  it('tolerates an unknown project and an absent projectId', () => {
    expect(call({ projectId: 'NOPE' })).toBe(1200);
    expect(call({ projectId: undefined })).toBe(1200);
  });

  it('tolerates an absent role', () => {
    expect(call({ role: undefined })).toBe(1200);
  });
});
