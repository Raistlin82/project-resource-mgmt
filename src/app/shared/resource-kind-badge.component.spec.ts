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

  it('labels an internal resource plainly (no amber tone)', () => {
    const fixture = setup('internal');
    const span = fixture.nativeElement.querySelector('span');
    expect(span.textContent.trim()).toBe('Internal');
    expect(span.classList.contains('amber')).toBe(false);
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

  it('defaults an absent/unknown kind to internal (defensive kindOf)', () => {
    const fixture = setup(undefined);
    const span = fixture.nativeElement.querySelector('span');
    expect(span.textContent.trim()).toBe('Internal');
  });
});
