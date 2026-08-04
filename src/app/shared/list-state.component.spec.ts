import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ListStateComponent } from './list-state.component';

/** Host that drives the three inputs and projects sentinel content. */
@Component({
  imports: [ListStateComponent],
  template: `
    <app-list-state [loading]="loading()" [error]="error()" label="customers" (retry)="retried = retried + 1">
      <ng-template>
        <div data-test="content">projected content</div>
      </ng-template>
    </app-list-state>
  `,
})
class HostComponent {
  loading = signal(false);
  error = signal(false);
  retried = 0;
}

/**
 * Models the real rxResource failure mode: reading value() while the resource is
 * in its error state throws. The list-state wrapper must not instantiate this
 * content until the resource has resolved successfully.
 */
@Component({
  imports: [ListStateComponent],
  template: `
    <app-list-state [error]="true" label="customers">
      <ng-template>
        <span data-test="dangerous">{{ failedResourceValue() }}</span>
      </ng-template>
    </app-list-state>
  `,
})
class FailedResourceHostComponent {
  failedResourceValue(): never {
    throw new Error('projected resource value evaluated');
  }
}

/**
 * A consumer that FORGOT the <ng-template> wrapper. The contract's own failure
 * mode: nothing renders (a visible blank), rather than the binding crashing the
 * view. Pins the contract so re-adding an <ng-content/> alongside the outlet —
 * which would resurrect the eager-evaluation bug for these consumers — is caught.
 */
@Component({
  imports: [ListStateComponent],
  template: `
    <app-list-state [loading]="false" [error]="false" label="customers">
      <div data-test="bare">bare projected content</div>
    </app-list-state>
  `,
})
class BareContentHostComponent {}

describe('ListStateComponent', () => {
  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  const html = (fixture: { nativeElement: HTMLElement }) =>
    (fixture.nativeElement as HTMLElement).innerHTML;

  it('projects content (and never an error/skeleton) once resolved', () => {
    const fixture = setup();
    expect(html(fixture)).toContain('projected content');
    expect(html(fixture)).not.toContain('command-skeleton');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows skeletons and hides projected content while loading', () => {
    const fixture = setup();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.command-skeleton')).not.toBeNull();
    // The misleading "empty / add your first" content must not flash during load.
    expect(html(fixture)).not.toContain('projected content');
  });

  it('announces the loading state to assistive technology', () => {
    const fixture = setup();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement | null;
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('Loading customers');
  });

  it('shows an error panel with Retry and hides content on error (no contradictory empty state)', () => {
    const fixture = setup();
    fixture.componentInstance.error.set(true);
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('customers');
    expect(html(fixture)).not.toContain('projected content');
  });

  it('emits retry when the Retry button is clicked', () => {
    const fixture = setup();
    fixture.componentInstance.error.set(true);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[role="alert"] button') as HTMLButtonElement;
    button.click();
    expect(fixture.componentInstance.retried).toBe(1);
  });

  it('prefers the loading state over the error state when both are set', () => {
    const fixture = setup();
    fixture.componentInstance.loading.set(true);
    fixture.componentInstance.error.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.command-skeleton')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  /**
   * MUTATION COVERAGE, stated so this is not re-flagged as a test that cannot
   * fail. It DOES fail against the bug it is for: render the content outlet in
   * the error branch as well (the P1-02 regression) and all three assertions go
   * red — verified by mutation.
   *
   * It does NOT fail against a revert to plain `<ng-content />`, because an
   * <ng-template> child is projected-but-never-instantiated there, so nothing
   * throws. The test that catches THAT revert is 'projects content (and never an
   * error/skeleton) once resolved' above: under <ng-content /> a template-wrapped
   * child renders nothing at all.
   */
  it('does not evaluate resource-backed content while showing an error', () => {
    const fixture = TestBed.createComponent(FailedResourceHostComponent);

    expect(() => fixture.detectChanges()).not.toThrow();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="dangerous"]')).toBeNull();
  });

  it('renders nothing for a consumer that forgot the <ng-template> wrapper', () => {
    const fixture = TestBed.createComponent(BareContentHostComponent);
    fixture.detectChanges();

    // The contract is template-only: bare projected content has no outlet. Add an
    // <ng-content /> back alongside the outlet and this fails — which is the
    // point, because that is what reintroduces eager binding evaluation.
    expect(fixture.nativeElement.querySelector('[data-test="bare"]')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('bare projected content');
  });
});
