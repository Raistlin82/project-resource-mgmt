import { describe, it, expect } from 'vitest';
import { sellRateFor, DEFAULT_HOURS_PER_DAY, hoursPerDayOrDefault, type NegotiatedRate, type SellRateContract, type SellRateProject } from './sell-rate.util';

// UNITS ARE PART OF THIS FIXTURE, DELIBERATELY. Every `billRate` on a
// NegotiatedRate below is EUR per DAY (what the column stores); every
// `referenceBillRate` is EUR per HOUR (what `Resource.billRate` already is,
// after withEffectiveRates' division). The suite therefore asserts CONVERTED
// figures — an assertion that reads `toBe(1000)` for a 1000 €/day rate is the
// bug this fixture exists to catch.
const HOURS_PER_DAY = 8;
/** The Developer rate card, 1120 €/day, as the caller receives it: €/HOUR. */
const REFERENCE_PER_HOUR = 1120 / HOURS_PER_DAY;   // 140
const perHour = (dayRate: number) => dayRate / HOURS_PER_DAY;

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
  projectId: 'P1', role: 'Developer', date: '2026-03-01', referenceBillRate: REFERENCE_PER_HOUR,
  hoursPerDay: HOURS_PER_DAY, rates: RATES, projects: PROJECTS, contracts: CONTRACTS, ...o,
});

describe('sellRateFor — precedence', () => {
  it('uses the contract rate inside the contract period', () => {
    expect(call()).toBe(perHour(1000));
  });

  it('lets a project override beat the contract rate', () => {
    expect(call({ projectId: 'P2' })).toBe(perHour(1100));
  });

  it('falls back to the reference rate outside the contract period', () => {
    // C1 ends 2026-12-31; these hours are dated after it.
    expect(call({ date: '2027-02-01' })).toBe(REFERENCE_PER_HOUR);
  });

  it('honours an open-ended contract with no endDate', () => {
    expect(call({ projectId: 'P3', date: '2030-01-01', rates: [
      { id: 'N5', contractId: 'C2', role: 'Developer', currency: 'EUR', billRate: 950 },
    ] })).toBe(perHour(950));
  });

  it('does not apply a contract rate to hours before the contract started', () => {
    expect(call({ date: '2025-12-31' })).toBe(REFERENCE_PER_HOUR);
  });

  it('applies a project override with no date limit when the project has no contract', () => {
    expect(call({ projectId: 'P9', date: '2099-01-01' })).toBe(perHour(1300));
  });

  it('does not let a project override survive its own contract expiring', () => {
    // P2's contract is C1, which ends 2026-12-31. The project override (N2)
    // must not outlive it: an expired contract may bill nothing on this
    // project, override or not, so this falls all the way to the reference.
    expect(call({ projectId: 'P2', date: '2027-02-01' })).toBe(REFERENCE_PER_HOUR);
  });

  it('ignores a rate in a non-base currency', () => {
    expect(call({ role: 'Designer' })).toBe(REFERENCE_PER_HOUR);   // N3 is USD
  });

  it('falls back for a role nobody negotiated', () => {
    expect(call({ role: 'QA Engineer' })).toBe(REFERENCE_PER_HOUR);
  });

  it('returns the reference rate when the table is empty — the no-regression guarantee', () => {
    expect(call({ rates: [] })).toBe(REFERENCE_PER_HOUR);
  });

  it('returns undefined when there is no rate anywhere and no reference', () => {
    expect(call({ rates: [], referenceBillRate: undefined })).toBeUndefined();
  });

  it('DOES NOT let a higher personal reference beat the negotiated price', () => {
    // The case that would only surface at month end, on a wrong invoice: the
    // customer signed 1000/day, so 1000/day is billed even though this person's
    // own reference rate is the equivalent of 1500/day.
    expect(call({ referenceBillRate: perHour(1500) })).toBe(perHour(1000));
  });

  it('tolerates an unknown project and an absent projectId', () => {
    expect(call({ projectId: 'NOPE' })).toBe(REFERENCE_PER_HOUR);
    expect(call({ projectId: undefined })).toBe(REFERENCE_PER_HOUR);
  });

  it('tolerates an absent role', () => {
    expect(call({ role: undefined })).toBe(REFERENCE_PER_HOUR);
  });
});

// A function with several return paths needs a test that fixes that they all
// return the SAME unit. Precedence tests cannot do it: each of them exercises
// one path in isolation, so a per-path unit error stays invisible. These
// compare the paths AGAINST EACH OTHER out of one fixture.
describe('sellRateFor — units (EUR/hour on every return path)', () => {
  it('returns the negotiated day rate and the hourly reference in the SAME unit, at the expected ratio', () => {
    // ONE fixture, two paths: contract rate 1000 €/DAY (level 2) vs the
    // Developer card's 1120 €/day already resolved to 140 €/HOUR (level 3).
    const negotiated = call();                 // level 2 wins
    const reference = call({ rates: [] });     // level 3 wins
    expect(negotiated).toBe(125);              // 1000/day ÷ 8 — NOT 1000
    expect(reference).toBe(140);               // unchanged: already hourly

    // Same unit on both paths <=> the ratio of the two RESULTS equals the ratio
    // of the two DAY prices. Under the shipped €/day-vs-€/hour mismatch this
    // ratio was 1000/140 = 7.14, i.e. off by exactly hoursPerDay.
    expect(negotiated! / reference!).toBeCloseTo(1000 / 1120, 12);

    // And the consequence the consumer actually pays out: 8 hours priced at a
    // 1000 €/day rate must cost ONE day, not eight.
    expect(8 * negotiated!).toBe(1000);
    expect(8 * reference!).toBe(1120);
  });

  it('converts a project override with the same divisor as a contract rate', () => {
    // Both negotiated levels must convert — fixing only one leaves the override
    // path (the higher-precedence one) 8x wrong.
    expect(call({ projectId: 'P2' })).toBe(1100 / 8);
    expect(call({ projectId: 'P9', date: '2099-01-01' })).toBe(1300 / 8);
  });

  it('scales with the configured hours/day rather than a hardcoded 8', () => {
    // A 4h working day doubles the hourly sell price of the same day rate; the
    // reference path, already hourly, is untouched by the setting.
    expect(call({ hoursPerDay: 4 })).toBe(250);
    expect(call({ hoursPerDay: 4, rates: [] })).toBe(140);
  });

  it('falls back to DEFAULT_HOURS_PER_DAY for an unusable divisor instead of dividing by zero', () => {
    expect(DEFAULT_HOURS_PER_DAY).toBe(8);
    expect(call({ hoursPerDay: 0 })).toBe(125);
    expect(call({ hoursPerDay: Number.NaN })).toBe(125);
    expect(call({ hoursPerDay: -8 })).toBe(125);
    expect(hoursPerDayOrDefault(undefined)).toBe(8);
    expect(hoursPerDayOrDefault(6)).toBe(6);
  });
});
