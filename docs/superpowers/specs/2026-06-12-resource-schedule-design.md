# Design — Resource Schedule (date-level booking, Gantt timeline, conflict detection)

**Date:** 2026-06-12 · **Status:** approved (design) · **Closes:** Competitive-analysis gap #4
**Approach:** B (bookable assignments with explicit dates + allocation; read-only timeline). Drag-drop (approach C) is deferred.

## Problem
`Assignment` carries only `assignedHours` — no dates, no allocation. The only over-allocation signal is a portfolio-level `utilization > 110%` flag, not date-aware. Market leaders (Runn, Float, Forecast, Dayshape) sell a resource timeline with date-level conflict detection. We hold the inputs (`ResourceRequest` already has `startDate`/`endDate`, `Resource` has weekly `capacity`) but never schedule against time.

## Scope (YAGNI)
Read-only resource timeline + conflict detection. Weekly granularity, fixed visible horizon (~12 weeks) with prev/next range nav. NOT in scope: drag-drop editing, auto-leveling/resource-resolution, sub-weekly granularity.

## 1. Data model — extend `Assignment`
Add to `src/app/services/api.service.ts` `Assignment` and Drizzle `assignments` (`src/db/schema.ts`):
- `startDate?: string` (ISO) — booking start; defaults to the linked request's `startDate` on create.
- `endDate?: string` (ISO) — booking end; defaults to the request's `endDate`.
- `allocationPct?: number` — % of the resource's weekly `capacity` this booking consumes (default `100`).

Drizzle: add `start_date text`, `end_date text`, `allocation_pct double precision` + a forward migration in `drizzle/`. In-memory repository + `/api/assignments` create/update (`pick` allow-list + validation: dates ISO-parseable, `allocationPct` in 0–100, end ≥ start) carry the new fields. Backward-compatible: fields optional; the schedule util falls back to request dates when an assignment's own dates are absent.

## 2. Conflict detection — `src/app/services/schedule.util.ts` (pure, tested)
A sweep-line per resource over its booking intervals. At any instant where the summed `allocationPct` of concurrent active bookings **> 100%**, those bookings are flagged conflicting; record peak over-allocation % and the offending window. Output:
- `lanes`: per resource → ordered bookings (each with `conflict: boolean`, resolved start/end/allocation, project/request label).
- `conflicts`: `{ resourceId, peakPct, windowStart, windowEnd, bookingIds }[]`.
Unit spec `schedule.util.spec.ts`: overlapping >100 flagged; non-overlapping not flagged; adjacent (end==next start) not a conflict; same-day edges; allocation summing; fallback to request dates.

## 3. Schedule view — `src/app/schedule/schedule.component.ts`, route `/schedule`
CSS-grid timeline (SSR-safe, pure geometry from data — no DOM measurement): rows = resources (name · role · capacity), columns = weeks across the horizon. Bars span their booking window, labelled with project + `allocation%`, coloured by project (series palette). Conflicting bars get a `--color-critical` outline/tint; the resource row shows an over-allocation badge (peak %). A summary strip: "N resources over-allocated". Range control (prev/next, default ~12 weeks from today). `ListStateComponent` for loading/empty/error. Read-only. Legend explains conflict styling.

## 4. Staffing assign-form
The assign action (`src/app/staffing/staffing.component.ts`) gains start/end (default = request dates) + allocation % (default 100), persisted on the created assignment via `/api/assignments`.

## 5. Demo data — adjust ALL seed assignments (`src/db/seed.ts`)
Every seeded assignment gets a realistic `startDate`/`endDate` (coherent with its request/project window) and an `allocationPct`. The set MUST include at least one deliberate **over-allocation** (a resource double-booked >100% in an overlapping window) so the conflict detection is visibly demonstrated, and a mix of full/partial allocations and non-overlapping bookings so the timeline reads realistically. Keep resource/profile data coherent with the bookings.

## 6. Roles, profiles & authorizations
- **Route**: `/schedule` gated with `roleGuard(a => a.hasAnyRole(['pm','resource-manager','delivery-executive','admin']))` (the resourcing roles that own staffing).
- **Nav**: the Schedule item appears in the **Resource Control** group only for those roles (role-gated in `navGroups`, mirroring how Commercial is capability-gated).
- **Server**: scheduling data flows through the existing `/api/assignments` endpoint — writes already gated to `pm/resource-manager/delivery-executive/admin`; ensure `/assignments` + `/requests` + `/resources` reads are permitted for those roles via `READ_RULES` (resources already are). No new endpoint, no new RBAC surface beyond the new fields.
- **Docs**: update `docs/roles-and-permissions.md` (route-access + capability tables) and `docs/functional/resource-management.md` (a Schedule SOP entry) to include the new view and who may access it.

## 7. Testing & verification
`schedule.util.spec.ts` (conflict math) + existing suites stay green; `npx ng build` clean; live verification — screenshot `/schedule` (as demo-admin) showing a real over-allocation conflict before finalising.

## Out of scope / deferred
Drag-drop editing (approach C), auto-leveling, sub-weekly granularity, capacity calendars (holidays/PTO beyond existing availability), cross-project booking optimization.
