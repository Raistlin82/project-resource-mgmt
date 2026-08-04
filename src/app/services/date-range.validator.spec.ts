import { FormControl, FormGroup, Validators } from '@angular/forms';
import { endNotBeforeStart } from './date-range.validator';

/**
 * P2-35. Every case here fails against the state the branch actually shipped —
 * `Validators.required` alone on both date controls — because that form is VALID
 * with end < start.
 */
describe('endNotBeforeStart', () => {
  function group(start: string, end: string, required = true) {
    return new FormGroup({
      startDate: new FormControl(start, required ? Validators.required : []),
      endDate: new FormControl(end, required ? Validators.required : []),
    }, { validators: endNotBeforeStart('startDate', 'endDate') });
  }

  it('invalidates the form and the end control when end precedes start', () => {
    const form = group('2026-06-30', '2026-06-01');
    expect(form.valid).toBe(false);
    expect(form.hasError('endBeforeStart')).toBe(true);
    // The error is on the control too, so the field can render its own message
    // and aria-invalid next to the input the user has to change.
    expect(form.controls.endDate.hasError('endBeforeStart')).toBe(true);
  });

  it('accepts an equal pair — a one-day window is a window', () => {
    const form = group('2026-06-01', '2026-06-01');
    expect(form.valid).toBe(true);
    expect(form.controls.endDate.hasError('endBeforeStart')).toBe(false);
  });

  it('accepts a normal window', () => {
    expect(group('2026-06-01', '2026-06-30').valid).toBe(true);
  });

  it('clears its own error when the user fixes the end date', () => {
    const form = group('2026-06-30', '2026-06-01');
    expect(form.controls.endDate.hasError('endBeforeStart')).toBe(true);
    form.controls.endDate.setValue('2026-07-01');
    expect(form.valid).toBe(true);
    expect(form.controls.endDate.errors).toBeNull();
  });

  it('does not compete with required: a blank or partial pair is not ITS error', () => {
    // required still fails the form, but not with endBeforeStart — otherwise an
    // empty form would show "end cannot be before start" before anything is typed.
    const blank = group('', '');
    expect(blank.hasError('endBeforeStart')).toBe(false);
    expect(blank.controls.endDate.hasError('required')).toBe(true);
    expect(group('2026-06-01', '').hasError('endBeforeStart')).toBe(false);
    expect(group('', '2026-06-01').hasError('endBeforeStart')).toBe(false);
    // Optional dates (resource requests): a blank pair is simply valid.
    expect(group('', '', false).valid).toBe(true);
  });

  it('leaves another validator\'s error on the end control intact', () => {
    // setErrors(null) would wipe `required`, disabling the form's own messaging.
    const form = group('2026-06-30', '2026-06-01');
    form.controls.endDate.setValue('');
    expect(form.controls.endDate.hasError('required')).toBe(true);
    expect(form.controls.endDate.hasError('endBeforeStart')).toBe(false);
  });

  it('ignores an unparseable value rather than guessing', () => {
    expect(group('30/06/2026', '01/06/2026').hasError('endBeforeStart')).toBe(false);
  });

  it('is a no-op when a named control is absent', () => {
    const form = new FormGroup(
      { startDate: new FormControl('2026-06-30') },
      { validators: endNotBeforeStart('startDate', 'endDate') },
    );
    expect(form.valid).toBe(true);
  });
});
