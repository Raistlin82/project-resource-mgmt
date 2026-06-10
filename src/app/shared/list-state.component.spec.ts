import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ListStateComponent } from './list-state.component';

/** Host that drives the three inputs and projects sentinel content. */
@Component({
  imports: [ListStateComponent],
  template: `
    <app-list-state [loading]="loading()" [error]="error()" label="customers" (retry)="retried = retried + 1">
      <div data-test="content">projected content</div>
    </app-list-state>
  `,
})
class HostComponent {
  loading = signal(false);
  error = signal(false);
  retried = 0;
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
});
