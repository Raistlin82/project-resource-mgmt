import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalDialogDirective } from './modal-dialog.directive';

@Component({
  imports: [ModalDialogDirective],
  template: `
    @if (open()) {
      <div appModal ariaLabelledby="dlgTitle" (dismiss)="dismissed = dismissed + 1">
        <h2 id="dlgTitle">Title</h2>
        <button type="button" data-test="first">First</button>
        <button type="button" (click)="open.set(false)">Close</button>
      </div>
    }
    <button type="button" data-test="trigger">Trigger</button>
  `,
})
class HostComponent {
  open = signal(false);
  dismissed = 0;
}

describe('ModalDialogDirective', () => {
  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  const dialogEl = (fixture: { nativeElement: HTMLElement }) =>
    fixture.nativeElement.querySelector('[appModal]') as HTMLElement | null;

  it('marks the overlay as a labelled modal dialog so screen readers announce it', () => {
    const fixture = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const el = dialogEl(fixture)!;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute('aria-labelledby')).toBe('dlgTitle');
  });

  it('emits dismiss when Escape is pressed inside the dialog', () => {
    const fixture = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const el = dialogEl(fixture)!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.dismissed).toBe(1);
  });

  it('restores focus to the previously focused trigger when the dialog closes', () => {
    const fixture = setup();
    const trigger = fixture.nativeElement.querySelector('[data-test="trigger"]') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    // Closing destroys the directive (via @if), which should restore focus.
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(document.activeElement).toBe(trigger);
  });
});
