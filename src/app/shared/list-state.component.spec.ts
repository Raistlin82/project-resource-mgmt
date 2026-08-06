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

/**
 * What every one of the 38 retry sites actually does: `resource.reload()` flips
 * `isLoading()` true synchronously, so the error branch unmounts and the loading
 * branch takes its place in the same pass — destroying the very Retry button the
 * user activated. The sibling button exists so a "focus went somewhere sensible"
 * assertion cannot be satisfied by an unrelated control.
 */
@Component({
  imports: [ListStateComponent],
  template: `
    <app-list-state [loading]="loading()" [error]="error()" label="resources" (retry)="onRetry()">
      <ng-template>
        <div data-test="content">projected content</div>
      </ng-template>
    </app-list-state>
    <button type="button" data-test="outside">unrelated control</button>
  `,
})
class RetryFocusHostComponent {
  loading = signal(false);
  error = signal(true);
  onRetry(): void {
    this.error.set(false);
    this.loading.set(true);
  }
}

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

describe('ListStateComponent — keyboard focus survives Retry', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function setupRetryFocus() {
    const fixture = TestBed.createComponent(RetryFocusHostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const q = <T extends Element>(fixture: { nativeElement: unknown }, sel: string): T => {
    const found = (fixture.nativeElement as HTMLElement).querySelector<T>(sel);
    expect(found, `expected to find ${sel}`).not.toBeNull();
    return found!;
  };

  /**
   * The pre-click `toBe(button)` is what makes this non-vacuous: without it the
   * test would also pass in a jsdom run where the button was never focusable at
   * all — the exact shape of the blind gate the sibling 'emits retry when the
   * Retry button is clicked' test above already has (it calls `button.click()`
   * and never touches focus).
   */
  it('moves focus to the loading region instead of dropping it to <body>', async () => {
    const fixture = await setupRetryFocus();
    const button = q<HTMLButtonElement>(fixture, '[role="alert"] button');

    button.focus();
    expect(document.activeElement).toBe(button);

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    const region = q<HTMLElement>(fixture, '[role="status"]');
    // <body> is stated as its own assertion because it is the specific wrong
    // answer: the next Tab restarts at the skip link and walks the whole sidebar.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(region);
    // …and not merely "some other control on the page".
    expect(document.activeElement).not.toBe(q(fixture, '[data-test="outside"]'));
  });

  it('does not add a second accessible name to the region it focuses', async () => {
    const fixture = await setupRetryFocus();
    q<HTMLButtonElement>(fixture, '[role="alert"] button')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    // The region is aria-live="polite" and already carries the sr-only text.
    // Naming it as well would announce those same words twice — once as the
    // live-region update and once as the name of the newly focused element.
    const region = q<HTMLElement>(fixture, '[role="status"]');
    expect(region.getAttribute('tabindex')).toBe('-1');
    expect(region.hasAttribute('aria-label')).toBe(false);
    expect(region.hasAttribute('aria-labelledby')).toBe(false);
    expect(region.textContent).toContain('Loading resources');
  });

  /**
   * The case that must still be ALLOWED, and the reason a focus move cannot be
   * unconditional: a component that focuses the loading region on every render
   * passes the test above and would then steal focus on the initial page load
   * and on every background refresh, yanking the caret out of whatever the user
   * was typing. Only a user-initiated Retry may move it.
   */
  it('leaves focus alone when the loading state was not triggered by Retry', async () => {
    const fixture = TestBed.createComponent(RetryFocusHostComponent);
    fixture.componentInstance.error.set(false);
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    const outside = q<HTMLButtonElement>(fixture, '[data-test="outside"]');
    outside.focus();
    expect(document.activeElement).toBe(outside);

    // A background reload settling and starting again — the loading region is
    // destroyed and re-created, which is the same viewChild transition Retry
    // causes, so only the retry flag can distinguish the two.
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    q<HTMLElement>(fixture, '[role="status"]');
    expect(document.activeElement).toBe(outside);
  });

  it('still emits retry to the host — the focus move must not replace the reload', async () => {
    // The guard-that-always-refuses check: swallowing the click would satisfy
    // every focus assertion above while never reloading anything.
    const fixture = await setupRetryFocus();
    const spy = vi.spyOn(fixture.componentInstance, 'onRetry');
    q<HTMLButtonElement>(fixture, '[role="alert"] button')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.loading()).toBe(true);
  });
});
