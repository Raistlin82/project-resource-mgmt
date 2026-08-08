import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalDialogDirective } from './modal-dialog.directive';

@Component({
  imports: [ModalDialogDirective],
  template: `
    <main id="main-content" tabindex="-1">
      <button type="button" data-test="trigger">Trigger</button>
      <p data-test="background">Background content</p>
      @if (open()) {
        <div appModal ariaLabelledby="dlgTitle" (dismiss)="dismissed = dismissed + 1">
          <h2 id="dlgTitle">Title</h2>
          <button type="button" data-test="first">First</button>
          <button type="button" (click)="open.set(false)">Close</button>
        </div>
      }
    </main>
  `,
})
class HostComponent {
  open = signal(false);
  dismissed = 0;
}

@Component({
  imports: [ModalDialogDirective],
  template: `
    <main id="main-content" tabindex="-1">
      <button type="button" data-test="outer-trigger">Open parent</button>
      @if (parentOpen()) {
        <div appModal ariaLabelledby="parentTitle" (dismiss)="parentDismissed = parentDismissed + 1">
          <h2 id="parentTitle">Parent</h2>
          <button type="button" data-test="nested-trigger" (click)="nestedOpen.set(true)">Open nested</button>
          @if (nestedOpen()) {
            <div appModal ariaLabelledby="nestedTitle" (dismiss)="closeNestedFromEscape()">
              <h2 id="nestedTitle">Nested</h2>
              <button type="button" data-test="nested-control">Nested action</button>
            </div>
          }
        </div>
      }
    </main>
  `,
})
class NestedHostComponent {
  parentOpen = signal(false);
  nestedOpen = signal(false);
  parentDismissed = 0;
  nestedDismissed = 0;

  closeNestedFromEscape(): void {
    this.nestedDismissed += 1;
    this.nestedOpen.set(false);
  }
}

describe('ModalDialogDirective', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.style.removeProperty('overflow');
  });

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

  it('moves focus inside the dialog when it opens', async () => {
    const fixture = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    // CDK's visibility checker cannot classify jsdom buttons as tabbable because
    // there is no layout box. The directive therefore exercises its intentional
    // safe fallback to the labelled dialog root in this environment; a browser
    // takes the first-tabbable branch.
    expect(dialogEl(fixture)!.contains(document.activeElement)).toBe(true);
  });

  it('locks body scrolling and inerts only the background, preserving prior inert state', () => {
    const fixture = setup();
    const trigger = fixture.nativeElement.querySelector('[data-test="trigger"]') as HTMLButtonElement;
    const preInert = fixture.nativeElement.querySelector('[data-test="background"]') as HTMLElement;
    preInert.setAttribute('inert', '');
    document.body.style.setProperty('overflow', 'clip', 'important');

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    expect(document.body.style.overflow).toBe('hidden');
    expect(trigger.hasAttribute('inert')).toBe(true);
    expect(dialogEl(fixture)!.hasAttribute('inert')).toBe(false);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(document.body.style.getPropertyValue('overflow')).toBe('clip');
    expect(trigger.hasAttribute('inert')).toBe(false);
    expect(preInert.hasAttribute('inert')).toBe(true);
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

  it('falls back to the main landmark when the original trigger can no longer receive focus', () => {
    const fixture = setup();
    const trigger = fixture.nativeElement.querySelector('[data-test="trigger"]') as HTMLButtonElement;
    const main = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    trigger.focus();

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    trigger.disabled = true;
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(document.activeElement).toBe(main);
  });

  it('keeps scroll lock and parent isolation intact while a nested dialog is active', async () => {
    const fixture = TestBed.createComponent(NestedHostComponent);
    fixture.detectChanges();
    const outerTrigger = fixture.nativeElement.querySelector('[data-test="outer-trigger"]') as HTMLButtonElement;
    outerTrigger.focus();

    fixture.componentInstance.parentOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const nestedTrigger = fixture.nativeElement.querySelector('[data-test="nested-trigger"]') as HTMLButtonElement;
    nestedTrigger.focus();
    nestedTrigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const dialogs = fixture.nativeElement.querySelectorAll('[appModal]') as NodeListOf<HTMLElement>;
    expect(dialogs).toHaveLength(2);
    expect(document.body.style.overflow).toBe('hidden');
    expect(outerTrigger.hasAttribute('inert')).toBe(true);
    expect(nestedTrigger.hasAttribute('inert')).toBe(true);
    expect(dialogs[1].hasAttribute('inert')).toBe(false);

    dialogs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.nestedDismissed).toBe(1);
    expect(fixture.componentInstance.parentDismissed).toBe(0);
    expect(document.body.style.overflow).toBe('hidden');
    expect(outerTrigger.hasAttribute('inert')).toBe(true);
    expect(nestedTrigger.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(nestedTrigger);

    fixture.componentInstance.parentOpen.set(false);
    fixture.detectChanges();
    expect(document.body.style.overflow).toBe('');
    expect(outerTrigger.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(outerTrigger);
  });
});
