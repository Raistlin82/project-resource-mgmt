import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/**
 * Cross-field guard: an end date may not precede its start date (P2-35).
 *
 * The server has always refused the inverted pair (`validateDateFields` with a
 * `{ from, to }` order rule, src/server.ts), which is exactly what the issue was
 * complaining about: the form let you fill it in, enable Save, and only find out
 * from a 400. This is the client half — one validator on the GROUP, because a
 * per-control validator cannot see the other control.
 *
 * Errors are attached to BOTH the group and the `end` control: the group key lets
 * the form disable Save, and the control key lets the field render its own inline
 * message and `aria-invalid` next to the input the user has to change.
 *
 * A blank or unparseable date is NOT this validator's business (`Validators.required`
 * and the input's own type own that), so it returns null rather than competing.
 * Comparison is a plain string compare — ISO 'YYYY-MM-DD' is lexicographically
 * ordered, so it needs no Date parsing and no timezone.
 */
export function endNotBeforeStart(startKey: string, endKey: string): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const start = group.get(startKey);
    const end = group.get(endKey);
    if (!start || !end) return null;

    const startValue = typeof start.value === 'string' ? start.value : '';
    const endValue = typeof end.value === 'string' ? end.value : '';
    const bothPresent = /^\d{4}-\d{2}-\d{2}$/.test(startValue) && /^\d{4}-\d{2}-\d{2}$/.test(endValue);

    // Clear only OUR key: another validator's error on the same control must
    // survive (setErrors(null) would wipe it).
    const withoutOurs = (errors: ValidationErrors | null): ValidationErrors | null => {
      if (!errors) return null;
      const rest = { ...errors };
      delete rest['endBeforeStart'];
      return Object.keys(rest).length ? rest : null;
    };

    if (!bothPresent || endValue >= startValue) {
      end.setErrors(withoutOurs(end.errors));
      return null;
    }

    end.setErrors({ ...(end.errors ?? {}), endBeforeStart: true });
    return { endBeforeStart: true };
  };
}
