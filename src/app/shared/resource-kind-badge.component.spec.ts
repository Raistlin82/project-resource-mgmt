import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ResourceKindBadgeComponent } from './resource-kind-badge.component';

@Component({
  imports: [ResourceKindBadgeComponent],
  template: `<app-resource-kind-badge [kind]="kind" />`,
})
class HostComponent {
  kind: string | undefined = undefined;
}

describe('ResourceKindBadgeComponent', () => {
  function setup(kind: string | undefined) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.kind = kind;
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing for an internal resource', () => {
    // The badge marks the EXCEPTION. A pill on every row carries no signal, and
    // the point of it is to stop someone picking a placeholder by mistake.
    const fixture = setup('internal');
    expect(fixture.nativeElement.querySelector('span')).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('labels a dummy as a placeholder, amber-toned', () => {
    const fixture = setup('dummy');
    const span = fixture.nativeElement.querySelector('span');
    expect(span.textContent.trim()).toBe('Dummy (placeholder)');
    expect(span.classList.contains('amber')).toBe(true);
  });

  it('labels a subco as Subcontractor, amber-toned', () => {
    const fixture = setup('subco');
    const span = fixture.nativeElement.querySelector('span');
    expect(span.textContent.trim()).toBe('Subcontractor');
    expect(span.classList.contains('amber')).toBe(true);
  });

  it('treats an absent/unknown kind as internal, so it renders nothing (defensive kindOf)', () => {
    expect(setup(undefined).nativeElement.querySelector('span')).toBeNull();
    expect(setup('contractor').nativeElement.querySelector('span')).toBeNull();
  });

  it('does not leave a phantom flex item behind when it renders nothing', () => {
    // Every call site puts the badge in a flex row with a gap; a host element
    // that renders nothing would still be a flex item and leave a stray gap
    // after the name. `display: contents` is what prevents that.
    const fixture = setup('internal');
    const host = fixture.nativeElement.querySelector('app-resource-kind-badge') as HTMLElement;
    expect(host).not.toBeNull();
    expect(getComputedStyle(host).display).toBe('contents');
  });
});
