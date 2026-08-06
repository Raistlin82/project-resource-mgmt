import { UserRole } from './api.service';

/**
 * Where a /search result row navigates, and who is allowed to follow it.
 *
 * TWO separate questions live here, and conflating them is the defect this file
 * exists to prevent:
 *
 *  1. WHERE does this entity live? Only `projects` and `contracts` have a detail
 *     route (`/projects/:id`, `/contracts/:id`). The other four have no detail
 *     page at all, so their "respective page" is their LIST, reached with the
 *     item's name pre-seeded into the filter the list already owns — landing on
 *     an unfiltered list of 200 orders would discard the very item clicked.
 *
 *  2. CAN this identity reach it? Every one of the six sections is pre-filtered
 *     in /search on a DIFFERENT predicate than the one guarding its target
 *     route — all six, verified against `app.routes.ts`:
 *
 *       section    target route      route guard                      /search pre-filter
 *       resources  /resources        hasAnyRole([rm, de, admin])      canReadStaffing
 *       requests   /requests         canManageStaffing                canReadStaffing
 *       projects   /projects/:id     canReadStaffing                  (none — open)
 *       customers  /customers        canManageCommercial              canReadCommercial
 *       contracts  /contracts/:id    canManageCommercial              canReadCommercial
 *       orders     /orders           canManageCommercial              canReadCommercial
 *
 *     So a row being VISIBLE never implies its target is REACHABLE. `projects`
 *     is the sharpest case: its section is open to any authenticated principal
 *     while `/projects/:id` demands staffing read, so an unconditional link
 *     would advertise a route the guard refuses — the exact defect already
 *     corrected once on the project cards. A row whose target is unreachable
 *     stays inert text, as every row was before this change.
 *
 * Kept as a pure module so the whole mapping is exhaustively testable without a
 * TestBed, and so the six-way switch cannot quietly lose a case.
 */

export const SEARCH_SECTION_KEYS = ['resources', 'requests', 'projects', 'customers', 'contracts', 'orders'] as const;
export type SearchSectionKey = (typeof SEARCH_SECTION_KEYS)[number];

/** The capability flags this module needs, named exactly as `AuthService` exposes them. */
export interface SearchTargetCapabilities {
  readonly canReadStaffing: boolean;
  readonly canManageStaffing: boolean;
  readonly canManageCommercial: boolean;
  readonly roles: readonly UserRole[];
}

/** A resolved router target: `link` feeds `[routerLink]`, `queryParams` feeds `[queryParams]`. */
export interface SearchTarget {
  readonly link: readonly string[];
  readonly queryParams?: Readonly<Record<string, string>>;
}

/**
 * The query-param name the four list pages read to seed their own text filter.
 * ONE constant, consumed by both the producer here and every list that honours
 * it, so a rename cannot leave half the app looking for the old key.
 */
export const SEARCH_FOCUS_PARAM = 'q';

/**
 * Mirrors the target route's `canMatch` guard — NOT the section's /search
 * pre-filter. When the two disagree (they do, for all six) the ROUTE wins:
 * being shown a row must never promise a navigation that ends in a refusal.
 *
 * `/resources` guards on an explicit role list rather than a capability, so this
 * is the one case that reads roles directly; it is transcribed from
 * `app.routes.ts` and must be updated with it.
 */
export function canReachSearchTarget(section: SearchSectionKey, caps: SearchTargetCapabilities): boolean {
  switch (section) {
    case 'resources':
      return caps.roles.some(r => r === 'resource-manager' || r === 'delivery-executive' || r === 'admin');
    // `requests` has NO usable destination, so no identity can reach one — see
    // NO_DESTINATION_SECTIONS below. Returning false here rather than at the
    // target step keeps "is it a link?" a single question.
    case 'requests':
      return false;
    case 'projects':
      return caps.canReadStaffing;
    case 'customers':
    case 'contracts':
    case 'orders':
      return caps.canManageCommercial;
  }
}

/**
 * Sections deliberately left inert because no page can show the clicked item.
 *
 * `requests`: `/requests` has no detail route, its text field filters RESOURCES
 * by availability rather than requests, and its list is `myRequests` —
 * `requesterId === currentUserId`. So a request raised by somebody else cannot
 * appear on that page under any filter, and a link there would land the user on
 * a screen that structurally cannot contain what they clicked. Inert text is
 * honest; a link would not be.
 *
 * The fix is to give `/requests` a real request filter (or a detail route), at
 * which point this entry goes away and `canReachSearchTarget` gates on
 * `canManageStaffing` — the guard `/requests` already carries.
 */
export const NO_DESTINATION_SECTIONS = ['requests'] as const;

/**
 * The target for one row, or `null` when this identity cannot reach it.
 *
 * `id` is used only for the two detail routes; `name` only for the four list
 * routes, where it seeds the filter. A row with no usable name falls back to the
 * bare list rather than to `?q=` with an empty value, which would look like a
 * filter the user had cleared.
 */
export function searchTargetFor(
  section: SearchSectionKey,
  item: { readonly id: string; readonly name?: string },
  caps: SearchTargetCapabilities,
): SearchTarget | null {
  if (!canReachSearchTarget(section, caps)) return null;

  switch (section) {
    case 'projects':
      return { link: ['/projects', item.id] };
    case 'contracts':
      return { link: ['/contracts', item.id] };
    // `requests` is unreachable above, so this branch is never taken for it; it
    // stays in the switch only to keep the union exhaustive, so adding a seventh
    // section is a compile error rather than a silent fallthrough.
    case 'requests':
    case 'resources':
    case 'customers':
    case 'orders': {
      const focus = item.name?.trim();
      return focus
        ? { link: [`/${section}`], queryParams: { [SEARCH_FOCUS_PARAM]: focus } }
        : { link: [`/${section}`] };
    }
  }
}

/**
 * The label each section filters on, which is also the label /search renders —
 * they MUST be the same string or the seeded filter finds nothing and the link
 * dead-ends on an empty list.
 *
 * Verified against each list's own predicate:
 *   resources  filters name/role/organization/location  -> `name`
 *   customers  filters name                             -> `name`
 *   orders     filters `invoiceNumber ?? id`            -> `invoiceNumber ?? id`
 *
 * Orders is the one that would have broken silently: its rows are labelled by
 * invoice number, not by a `name` field it does not have.
 */
export function searchFocusLabel(
  section: SearchSectionKey,
  item: { readonly id: string; readonly name?: string; readonly invoiceNumber?: string },
): string | undefined {
  return section === 'orders' ? (item.invoiceNumber ?? item.id) : item.name;
}

/** True iff this section navigates to a real detail page rather than a filtered list. */
export function hasDetailRoute(section: SearchSectionKey): boolean {
  return section === 'projects' || section === 'contracts';
}
