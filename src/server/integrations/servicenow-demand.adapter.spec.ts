import {
  RES_CODE_PATTERN,
  ServiceNowRequesterPortalAdapter,
  hasResCode,
  resCodeOf,
} from './servicenow-demand.adapter';
import type { DemandSubject } from './types';

const adapter = new ServiceNowRequesterPortalAdapter();

const DUMMY: DemandSubject = {
  id: '4',
  name: 'Dummy — Associate PMO',
  code: 'ZZ - Dummy - SAP - Associate PMO',
  role: 'Associate PMO',
  organization: 'SAP',
  kind: 'dummy',
};

const SUBCO: DemandSubject = {
  id: '6',
  name: 'Subco — Mediolanum Senior Developer',
  code: 'ZZ - Subco - Engineering - Developer',
  role: 'Developer',
  organization: 'Engineering',
  kind: 'subco',
};

describe('ServiceNowRequesterPortalAdapter — self-description', () => {
  it('is a demand adapter that is NOT connected', () => {
    const d = adapter.describe();
    expect(d.kind).toBe('demand');
    expect(d.key).toBe('servicenow-requester-portal');
    expect(d.connected).toBe(false);
    expect(d.mode).toBe('local-artifact');
  });
});

describe('buildDemand — the requisition a portal WOULD receive', () => {
  it('carries the placeholder, its role and its practice', () => {
    const demand = adapter.buildDemand(DUMMY, '2026-08-08T09:00:00.000Z');
    expect(demand).toStrictEqual({
      externalRef: 'DEM-4',
      subjectId: '4',
      placeholderCode: 'ZZ - Dummy - SAP - Associate PMO',
      role: 'Associate PMO',
      practice: 'SAP',
      channel: 'hiring',
      raisedAt: '2026-08-08T09:00:00.000Z',
      status: 'Prepared',
    });
  });

  it('routes a SUBCO row to procurement, not to recruiting', () => {
    // Different kinds are different processes: you hire a person and you
    // contract a supplier. One channel for both would send half the demands to
    // the wrong queue.
    expect(adapter.buildDemand(SUBCO, '2026-08-08T09:00:00.000Z').channel).toBe('subcontract');
    expect(adapter.buildDemand(DUMMY, '2026-08-08T09:00:00.000Z').channel).toBe('hiring');
  });

  it('never reads a clock — the timestamp comes from the caller', () => {
    const a = adapter.buildDemand(DUMMY, '2020-01-01T00:00:00.000Z');
    const b = adapter.buildDemand(DUMMY, '2020-01-01T00:00:00.000Z');
    expect(a).toStrictEqual(b);
  });

  it('REFUSES a demand for a real person', () => {
    // Raising a requisition against someone already employed asks HR to hire
    // them a second time.
    const person: DemandSubject = { id: '1', name: 'Julie Armstrong', code: 'ARMJUL000001', kind: 'internal' };
    expect(() => adapter.buildDemand(person, '2026-08-08T09:00:00.000Z'))
      .toThrow(/only be raised for a placeholder/);
  });

  it('treats an absent kind as a real person, not as a placeholder', () => {
    // The safe direction: refusing a demand is recoverable, raising a spurious
    // requisition against an employee is not.
    const unknown: DemandSubject = { id: '9', name: 'Someone' };
    expect(() => adapter.buildDemand(unknown, '2026-08-08T09:00:00.000Z')).toThrow(/placeholder/);
  });

  it('REFUSES a second demand for a seat that already has a requisition', () => {
    const already: DemandSubject = { ...DUMMY, code: 'RES0005555 - ZZ - Dummy - SAP - Associate PMO' };
    expect(() => adapter.buildDemand(already, '2026-08-08T09:00:00.000Z'))
      .toThrow(/already carries requisition RES0005555/);
  });
});

describe('applyResCode — the rewrite that makes a dummy SPECIFIC', () => {
  it('prefixes the RES number onto the description, keeping both halves', () => {
    // RPT's own worked example. The description says WHAT the seat is; the RES
    // says which requisition it belongs to. Replacing one with the other would
    // lose the half a human reads.
    const { specificCode, resCode } = adapter.applyResCode(DUMMY, 'RES0005555');
    expect(resCode).toBe('RES0005555');
    expect(specificCode).toBe('RES0005555 - ZZ - Dummy - SAP - Associate PMO');
  });

  it('normalises a RES number typed in lower case or with spaces', () => {
    expect(adapter.applyResCode(DUMMY, '  res0005555 ').specificCode)
      .toBe('RES0005555 - ZZ - Dummy - SAP - Associate PMO');
  });

  it('REFUSES anything that is not a RES number', () => {
    // The pair of the test above: a normaliser that upper-cases everything
    // would happily accept 'BANANA' without this.
    for (const bad of ['RES123', 'RES00055555', 'REQ0005555', '0005555', '', 'RESABCDEFG']) {
      expect(() => adapter.applyResCode(DUMMY, bad), bad).toThrow(/not a RES requisition number/);
    }
  });

  it('accepts re-applying the SAME requisition, and returns the code unchanged', () => {
    // Idempotent on a retry — the honest reading of "the portal answered twice".
    const already: DemandSubject = { ...DUMMY, code: 'RES0005555 - ZZ - Dummy - SAP - Associate PMO' };
    expect(adapter.applyResCode(already, 'RES0005555').specificCode).toBe(already.code);
  });

  it('REFUSES a DIFFERENT requisition on a seat that already has one', () => {
    // The case idempotence must not swallow: silently rewriting would leave the
    // row naming a requisition it was never raised under.
    const already: DemandSubject = { ...DUMMY, code: 'RES0005555 - ZZ - Dummy - SAP - Associate PMO' };
    expect(() => adapter.applyResCode(already, 'RES0009999'))
      .toThrow(/already carries requisition RES0005555/);
  });

  it('handles a placeholder with no code at all', () => {
    const codeless: DemandSubject = { ...DUMMY, code: undefined };
    expect(adapter.applyResCode(codeless, 'RES0005555').specificCode).toBe('RES0005555');
  });

  it('never mutates the subject it was given', () => {
    const subject = { ...DUMMY };
    const snapshot = JSON.stringify(subject);
    adapter.applyResCode(subject, 'RES0005555');
    expect(JSON.stringify(subject)).toBe(snapshot);
  });
});

describe('hasResCode / resCodeOf — the questions a UI asks', () => {
  it('recognises a RES-prefixed code and only that', () => {
    expect(hasResCode('RES0005555 - ZZ - Dummy - SAP - Associate PMO')).toBe(true);
    expect(hasResCode('ZZ - Dummy - SAP - Associate PMO')).toBe(false);
    expect(hasResCode('ARMJUL000001')).toBe(false);
    expect(hasResCode(undefined)).toBe(false);
    // A RES-looking word INSIDE the description is not a prefix.
    expect(hasResCode('ZZ - Dummy - RES0005555')).toBe(false);
  });

  it('extracts the requisition number, and nothing when there is none', () => {
    expect(resCodeOf('RES0005555 - ZZ - Dummy - SAP - Associate PMO')).toBe('RES0005555');
    expect(resCodeOf('ZZ - Dummy - SAP - Associate PMO')).toBeUndefined();
  });

  it('pins the pattern, so the shape cannot loosen unnoticed', () => {
    expect(RES_CODE_PATTERN.test('RES0005555')).toBe(true);
    expect(RES_CODE_PATTERN.test('RES005555')).toBe(false);
  });
});
