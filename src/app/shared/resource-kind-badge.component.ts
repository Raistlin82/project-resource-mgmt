import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { isMultiFteEligible, kindOf, RESOURCE_KIND_LABELS, type ResourceKind } from '../services/resource-kind.util';

/**
 * Kind badge (C1) — an amber pill next to a resource's name marking it as a
 * placeholder awaiting hire (`dummy`) or an external collaborator (`subco`).
 *
 * An `internal` resource renders NOTHING. The badge exists to stop someone
 * picking a placeholder by mistake believing it is a person; a pill on every
 * row would carry no signal, and the exception is what the eye should catch.
 * The `internal` case is the overwhelming majority everywhere this is used
 * (the resources list, the staffing picker, the allocation calendar header),
 * so suppressing it here fixes all call sites at once — none of them should
 * have to know which kinds are worth announcing. The split is
 * `isMultiFteEligible()`, the same one the domain layer already uses to keep
 * these two out of the internal capacity KPIs.
 *
 * `:host { display: contents }` matters: every call site puts this inside a
 * flex row with a `gap`, and a host element that renders nothing would still
 * be a flex item, leaving a phantom gap after every internal resource's name.
 *
 * Deliberately just this: a tiny presentational wrapper around the shared
 * `.command-status` pill, not a general-purpose badge library. It exists
 * because the same badge is needed in several places and one small component
 * beats copies of the same markup drifting apart.
 */
@Component({
  selector: 'app-resource-kind-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `:host { display: contents; }`,
  template: `
    @if (visible()) {
      <span class="command-status amber">{{ label() }}</span>
    }
  `,
})
export class ResourceKindBadgeComponent {
  /** Raw stored kind value (may be absent/legacy) — resolved defensively via `kindOf()`. */
  readonly kind = input<string | undefined>(undefined);

  protected readonly resolvedKind = computed<ResourceKind>(() => kindOf({ kind: this.kind() }));
  /** Renders only for the kinds worth flagging — `internal` shows nothing at all. */
  protected readonly visible = computed(() => isMultiFteEligible(this.resolvedKind()));
  protected readonly label = computed(() => RESOURCE_KIND_LABELS[this.resolvedKind()]);
}
