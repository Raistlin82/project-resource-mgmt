import { describe, it, expect } from 'vitest';
import { pickRateCard, conflictingCardMessage, RATE_BASE_CURRENCY } from './rate-card.util';
import type { OrgNode } from './org-scope.util';
import type { RateCard } from './api.service';

// Tree: CAP (Engineering, capability) > PRA (Platform, practice) > COM (Backend, competence).
// Mirrors the seed's own shape (src/db/seed.ts) exactly, so a reader can map
// every test straight onto the real org tree without translating names.
const NODES: OrgNode[] = [
  { id: 'CAP', name: 'Engineering', level: 'capability' },
  { id: 'PRA', name: 'Platform', level: 'practice', parentId: 'CAP' },
  { id: 'COM', name: 'Backend', level: 'competence', parentId: 'PRA' },
];

function card(id: string, organization: string | undefined, costRate: number, billRate: number, currency = 'EUR'): RateCard {
  return { id, role: 'Developer', organization, currency, costRate, billRate };
}

describe('pickRateCard — precedence, one gradient per test', () => {
  it('falls back to the generic card when no ancestor has one — byte-identical to before this block', () => {
    const cards = [card('GEN', undefined, 600, 1120)];
    expect(pickRateCard(cards, 'Developer', 'Backend', NODES)).toEqual(cards[0]);
  });

  it('falls through to the nearest ancestor when the own node has no card', () => {
    const cards = [card('GEN', undefined, 600, 1120), card('ENG', 'Engineering', 640, 1200)];
    expect(pickRateCard(cards, 'Developer', 'Platform', NODES)).toEqual(cards[1]);
  });

  it('prefers the nearer ancestor (Platform) over the farther one (Engineering)', () => {
    const cards = [card('GEN', undefined, 600, 1120), card('ENG', 'Engineering', 640, 1200), card('PRA', 'Platform', 660, 1250)];
    expect(pickRateCard(cards, 'Developer', 'Backend', NODES)).toEqual(cards[2]);
  });

  it('a descendant with its own card is unaffected by an ancestor card', () => {
    const cards = [card('ENG', 'Engineering', 640, 1200), card('BACK', 'Backend', 700, 1300)];
    expect(pickRateCard(cards, 'Developer', 'Backend', NODES)).toEqual(cards[1]);
  });

  it('an organization that resolves to no real node behaves exactly like today (no tree walk possible)', () => {
    const cards = [card('GEN', undefined, 600, 1120), card('ENG', 'Engineering', 640, 1200)];
    expect(pickRateCard(cards, 'Developer', 'Ghost Org', NODES)).toEqual(cards[0]);
  });

  it('returns undefined with no role', () => {
    expect(pickRateCard([card('GEN', undefined, 600, 1120)], undefined, 'Backend', NODES)).toBeUndefined();
  });

  it('ignores a card in a non-base currency even when it sits on the nearest ancestor', () => {
    const cards = [card('GEN', undefined, 600, 1120), card('PRA', 'Platform', 660, 1250, 'USD')];
    expect(pickRateCard(cards, 'Developer', 'Backend', NODES)).toEqual(cards[0]);
  });
});

/** A reference re-implementation of TODAY's resolution (exact match, then
 *  generic) — no tree, no ancestor. Used only by the property test below to
 *  prove the strong no-regression property, never by application code. */
function oldPickRateCard(cards: readonly RateCard[], role: string | undefined, organization: string | undefined): RateCard | undefined {
  if (!role) return undefined;
  const forRole = cards.filter(c => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  return forRole.find(c => c.organization && c.organization === organization) ?? forRole.find(c => !c.organization);
}

describe('pickRateCard — the no-regression property', () => {
  it('matches the old resolution for every node, on ANY synthetic tree, WHEN NO CARD SITS ON A NODE WITH CHILDREN', () => {
    // NOTE ON WHAT THIS TEST DOES NOT PROVE: under this precondition the
    // ancestor walk never finds anything, so this property would pass even if
    // the whole tree-walk block were deleted — it is a NO-REGRESSION check,
    // not evidence the walk itself works. The explicit precedence tests above
    // are what pin the walk; this one only pins that the walk stays inert
    // when nobody has put a card on a non-leaf node. Treating this test alone
    // as sufficient is exactly the "green check no data exercises" trap this
    // project keeps finding — see spec §9/§13.
    const leaves: OrgNode[] = [
      { id: 'A', name: 'A', level: 'capability' },
      { id: 'B', name: 'B', level: 'practice', parentId: 'A' },
      { id: 'C', name: 'C', level: 'competence', parentId: 'B' },
      { id: 'D', name: 'D', level: 'capability' },
    ];
    // Cards only ever sit on 'C' and 'D' — both childless (leaves) in this tree.
    const cards = [card('C1', 'C', 700, 1300), card('D1', 'D', 610, 1130), card('GEN', undefined, 600, 1120)];
    for (const org of ['A', 'B', 'C', 'D', 'Ghost', undefined]) {
      expect(pickRateCard(cards, 'Developer', org, leaves)).toEqual(oldPickRateCard(cards, 'Developer', org));
    }
  });
});

describe('conflictingCardMessage', () => {
  it('warns when the saved card conflicts with an ancestor', () => {
    const others = [card('ENG', 'Engineering', 640, 1200)];
    const msg = conflictingCardMessage({ organization: 'Platform', role: 'Developer', currency: 'EUR' }, others, NODES);
    expect(msg).toBe('This role already has a card on Engineering: this new card covers only Platform and its descendants without a card of their own.');
  });

  it('warns when the saved card conflicts with a descendant that has its own card', () => {
    const others = [card('BACK', 'Backend', 700, 1300)];
    const msg = conflictingCardMessage({ organization: 'Engineering', role: 'Developer', currency: 'EUR' }, others, NODES);
    expect(msg).toBe('This role already has a card on Backend: this new card covers only Engineering and its descendants without a card of their own.');
  });

  it('is silent for a generic card (no organization to scope the message to)', () => {
    const others = [card('ENG', 'Engineering', 640, 1200)];
    expect(conflictingCardMessage({ organization: undefined, role: 'Developer', currency: 'EUR' }, others, NODES)).toBeNull();
  });

  it('is silent when the saved card is not in the base currency', () => {
    const others = [card('ENG', 'Engineering', 640, 1200)];
    expect(conflictingCardMessage({ organization: 'Platform', role: 'Developer', currency: 'USD' }, others, NODES)).toBeNull();
  });

  it('is silent when there is no conflict at all', () => {
    expect(conflictingCardMessage({ organization: 'Platform', role: 'Developer', currency: 'EUR' }, [], NODES)).toBeNull();
  });

  it('does not warn against another non-base-currency card even if it sits on an ancestor', () => {
    const others = [card('ENG', 'Engineering', 640, 1200, 'USD')];
    expect(conflictingCardMessage({ organization: 'Platform', role: 'Developer', currency: 'EUR' }, others, NODES)).toBeNull();
  });

  it('is silent when the only other card shares the same organization literal (spec §13)', () => {
    // Not an ancestor, not a descendant -- the SAME node as the card being
    // saved. The server's own uniqueness rule (role+organization+currency)
    // would refuse this as a duplicate before conflictingCardMessage is ever
    // called in the real save flow; this test pins that the function itself
    // is also correct in isolation, since neither ancestorNames (built from
    // .slice(1), which excludes the node itself) nor descendantIds' own-id
    // exclusion (`otherNode.id !== node.id`) ever match the node's own name.
    const others = [card('PRA', 'Platform', 660, 1250)];
    expect(conflictingCardMessage({ organization: 'Platform', role: 'Developer', currency: 'EUR' }, others, NODES)).toBeNull();
  });
});
