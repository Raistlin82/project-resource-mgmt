/**
 * Hiring / subcontractor demand seam — "ServiceNowRequesterPortal" (row 29).
 *
 * THE FLOW RPT DESCRIBES. A planner books a DUMMY — unfilled demand, a shape of
 * a person nobody has hired yet. From that dummy they open a requisition on the
 * ServiceNow Requester Portal, and when the portal answers with a **RES number**
 * the dummy stops being generic:
 *
 *   before   ZZ - Dummy - SAP - Associate PMO
 *   after    RES0005555 - ZZ - Dummy - SAP - Associate PMO
 *
 * That rewrite is the whole point. The plan does not change — the same hours on
 * the same commessa — but the row now names a real requisition somebody is
 * accountable for, and two dummies for the same practice and role stop being
 * indistinguishable.
 *
 * WHAT IS AND IS NOT HERE. `buildDemand` produces the payload the portal WOULD
 * receive; nothing is transmitted (`connected: false`, no network, no
 * credentials). `applyResCode` computes the new code; it does not write it —
 * the caller owns persistence, which keeps this module pure and lets the same
 * rule be tested without a repository.
 *
 * Both functions are pure in the strict sense used across this folder: no
 * clocks (`raisedAt` is passed in), no id generation, no mutation of the input.
 */

import type {
  DemandAdapter,
  DemandFulfilment,
  DemandRequest,
  DemandSubject,
  IntegrationDescriptor,
} from './types';

export type {
  DemandAdapter,
  DemandFulfilment,
  DemandRequest,
  DemandSubject,
} from './types';

/** The shape a RES requisition number must have: `RES` + 7 digits. */
export const RES_CODE_PATTERN = /^RES\d{7}$/;

/** What separates the RES number from the placeholder description it prefixes. */
export const RES_PREFIX_SEPARATOR = ' - ';

/**
 * Is this code already RES-prefixed?
 *
 * Exported because it is the question a UI asks to decide whether to offer the
 * "raise a demand" action at all — and the question `applyResCode` asks to
 * refuse a second, contradictory requisition on the same row.
 */
export function hasResCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  const [head] = code.split(RES_PREFIX_SEPARATOR);
  return RES_CODE_PATTERN.test(head);
}

/** The RES number carried by a code, or undefined when it carries none. */
export function resCodeOf(code: string | undefined): string | undefined {
  if (!hasResCode(code)) return undefined;
  return code!.split(RES_PREFIX_SEPARATOR)[0];
}

/**
 * The single concrete demand adapter: builds the requisition, and applies the
 * requisition number that comes back.
 */
export class ServiceNowRequesterPortalAdapter implements DemandAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'demand',
      key: 'servicenow-requester-portal',
      name: 'ServiceNowRequesterPortal',
      description:
        'Builds the hiring or subcontractor requisition a demand portal would receive for a ' +
        'dummy, and applies the RES number that comes back — which turns a generic placeholder ' +
        'into a specific one by prefixing its code. Local artifact only: nothing is transmitted, ' +
        'and the new code is returned rather than written.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  buildDemand(subject: DemandSubject, raisedAt: string): DemandRequest {
    // A demand is meaningless for a real person: they are already hired, and
    // raising a requisition against them would ask HR to hire someone twice.
    if (subject.kind !== 'dummy' && subject.kind !== 'subco') {
      throw new Error(
        `a demand can only be raised for a placeholder; '${subject.name}' is ${subject.kind ?? 'internal'}`,
      );
    }
    if (hasResCode(subject.code)) {
      throw new Error(
        `'${subject.name}' already carries requisition ${resCodeOf(subject.code)}; ` +
          'raising a second one would leave two requisitions for one seat',
      );
    }
    return {
      // Traceable back to the row without leaking our internal id shape into a
      // third party's ticket: their reference is ours prefixed and nothing else.
      externalRef: `DEM-${subject.id}`,
      subjectId: subject.id,
      placeholderCode: subject.code ?? '',
      role: subject.role ?? '',
      practice: subject.organization ?? '',
      // The channel follows the KIND, because they are different processes:
      // a dummy goes to recruiting, a subco row goes to procurement.
      channel: subject.kind === 'subco' ? 'subcontract' : 'hiring',
      raisedAt,
      status: 'Prepared',
    };
  }

  applyResCode(subject: DemandSubject, resCode: string): DemandFulfilment {
    const trimmed = resCode.trim().toUpperCase();
    if (!RES_CODE_PATTERN.test(trimmed)) {
      throw new Error(`'${resCode}' is not a RES requisition number (expected RES followed by 7 digits)`);
    }
    if (hasResCode(subject.code)) {
      // Idempotence is NOT the right answer here. Re-applying the SAME number
      // is harmless, but applying a DIFFERENT one silently would leave the row
      // naming a requisition nobody raised for it.
      const existing = resCodeOf(subject.code);
      if (existing !== trimmed) {
        throw new Error(
          `'${subject.name}' already carries requisition ${existing}; ` +
            `applying ${trimmed} would rewrite it to a requisition it was not raised under`,
        );
      }
      return { resCode: trimmed, specificCode: subject.code! };
    }
    const description = subject.code ?? '';
    return {
      resCode: trimmed,
      // Prefix, never replace: the description is what tells a human WHAT the
      // seat is, and RPT keeps both halves for exactly that reason.
      specificCode: description === '' ? trimmed : `${trimmed}${RES_PREFIX_SEPARATOR}${description}`,
    };
  }
}
