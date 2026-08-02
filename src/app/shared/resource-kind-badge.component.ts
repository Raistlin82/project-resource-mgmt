import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { isMultiFteEligible, kindOf, type ResourceKind } from '../services/resource-kind.util';

/**
 * Human-readable label per {@link ResourceKind} (C1). Single source of truth
 * for the copy shown in the kind `<select>`, the kind filter, and this badge —
 * reused as-is by `resources.component.ts` for its two selects so the three
 * spellings never drift apart.
 */
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  internal: 'Internal',
  dummy: 'Dummy (placeholder)',
  subco: 'Subcontractor',
};

/**
 * Kind badge (C1) — a pill next to a resource's name showing whether it's a
 * real employee, a placeholder awaiting hire (`dummy`), or an external
 * collaborator (`subco`). `internal` renders neutral; `dummy`/`subco` render
 * amber, mirroring `isMultiFteEligible()` — the same split the domain layer
 * already uses to keep them out of the internal capacity KPIs.
 *
 * Deliberately just this: a tiny presentational wrapper around the shared
 * `.command-status` pill, not a general-purpose badge library. It exists
 * because the same badge is needed in two places (this screen's resource list
 * today; the staffing resource picker next) and one small component beats two
 * copies of the same markup drifting apart.
 */
@Component({
  selector: 'app-resource-kind-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="command-status" [class.amber]="amber()">{{ label() }}</span>
  `,
})
export class ResourceKindBadgeComponent {
  /** Raw stored kind value (may be absent/legacy) — resolved defensively via `kindOf()`. */
  readonly kind = input<string | undefined>(undefined);

  protected readonly resolvedKind = computed<ResourceKind>(() => kindOf({ kind: this.kind() }));
  protected readonly amber = computed(() => isMultiFteEligible(this.resolvedKind()));
  protected readonly label = computed(() => RESOURCE_KIND_LABELS[this.resolvedKind()]);
}
