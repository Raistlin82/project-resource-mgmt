/**
 * Rate-card resolution (design spec §2). PURE: no I/O, no clock, no Angular.
 *
 * PRECEDENCE, first match wins: the node's OWN card, then each ANCESTOR
 * nearest-first (`ancestorChain` already returns exactly that order — see
 * org-scope.util.ts), then the GENERIC (no-organization) card.
 *
 * THIS IS A STRICT GENERALIZATION OF TODAY'S BEHAVIOUR. With no card on any
 * ancestor of `organization`, the result is byte-identical to the two-step
 * resolution that shipped before this file existed (exact match, then
 * generic) — the ancestor loop below simply finds nothing and falls through.
 * Do not "simplify" this back to two steps: that is exactly the defect this
 * file exists to fix (a card on a capability silently stops applying to the
 * practices/competences under it).
 */
import { nodeByName, ancestorChain, descendantOrgIds, type OrgNode } from './org-scope.util';
import type { RateCard } from './api.service';

export const RATE_BASE_CURRENCY = 'EUR';

export function pickRateCard(
  cards: readonly RateCard[],
  role: string | undefined,
  organization: string | undefined,
  nodes: readonly OrgNode[],
): RateCard | undefined {
  if (!role) return undefined;
  const forRole = cards.filter(c => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  // Exact match — unchanged from before this file existed, and the ONLY step
  // that runs even when `organization` resolves to no real node (legacy data).
  const own = forRole.find(c => c.organization && c.organization === organization);
  if (own) return own;
  const node = nodeByName(organization, nodes);
  if (node) {
    // .slice(1): the node itself was already tried above as the exact match;
    // this walks ONLY the true ancestors, nearest first.
    for (const ancestor of ancestorChain(node.id, nodes).slice(1)) {
      const hit = forRole.find(c => c.organization === ancestor.name);
      if (hit) return hit;
    }
  }
  return forRole.find(c => !c.organization);
}

/**
 * Design spec §7b. Null when saving `saved` introduces no potential conflict
 * with an ancestor or descendant card for the same (role, currency); the
 * message text otherwise, DIRECTION-AGNOSTIC by construction: whichever node
 * `other.organization` names, "this new card covers only {saved.organization}
 * and its descendants without a card of their own" stays true — if the other
 * card is on a descendant with its OWN card, that descendant is by
 * construction excluded from "descendants without a card of their own"
 * (its own card wins by nearness), so the sentence promises nothing that
 * will not hold.
 *
 * Mirrors pickRateCard's OWN currency filter, not a new one: two cards
 * outside the base currency never collide in resolution regardless of tree
 * position (pickRateCard's `forRole` filter excludes them unconditionally),
 * so warning about them would be a false alarm.
 */
export function conflictingCardMessage(
  saved: { organization?: string; role: string; currency: string },
  otherCards: readonly RateCard[],
  nodes: readonly OrgNode[],
): string | null {
  if (!saved.organization || saved.currency !== RATE_BASE_CURRENCY) return null;
  const node = nodeByName(saved.organization, nodes);
  if (!node) return null;
  const ancestorNames = new Set(ancestorChain(node.id, nodes).slice(1).map(a => a.name));
  const descendantIds = descendantOrgIds(node.id, nodes);
  const other = otherCards.find(c => {
    if (c.role !== saved.role || c.currency !== RATE_BASE_CURRENCY || !c.organization) return false;
    if (ancestorNames.has(c.organization)) return true;
    const otherNode = nodeByName(c.organization, nodes);
    return otherNode !== undefined && otherNode.id !== node.id && descendantIds.has(otherNode.id);
  });
  return other
    ? `This role already has a card on ${other.organization}: this new card covers only ${saved.organization} and its descendants without a card of their own.`
    : null;
}
