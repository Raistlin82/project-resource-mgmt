import {
  AfterViewInit,
  Directive,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
} from '@angular/core';
import { ConfigurableFocusTrap, ConfigurableFocusTrapFactory } from '@angular/cdk/a11y';
import { Platform } from '@angular/cdk/platform';
import { DOCUMENT } from '@angular/common';

/**
 * Shared modal/dialog behavior for overlay roots rendered with `@if`.
 *
 * Applied to the backdrop element of a modal it provides, consistently across
 * every dialog in the app:
 *  - `role="dialog"` + `aria-modal="true"` so screen readers announce it as a
 *    modal dialog and treat the background as inert (WCAG 4.1.2);
 *  - an optional `aria-labelledby` wired from the `ariaLabelledby` input;
 *  - a CDK focus trap so Tab/Shift+Tab cycle within the dialog and cannot reach
 *    the obscured page behind the backdrop (WCAG 2.1.2 / 2.4.3);
 *  - focus moved to the first focusable control on open and restored to the
 *    element that had focus before the dialog opened, on close;
 *  - Escape-to-dismiss via the `dismiss` output.
 *
 * Because the host overlay is created/destroyed by `@if`, the trap lifecycle
 * maps cleanly onto open/close: the trigger element is captured on init and
 * focus is returned to it on destroy.
 */
@Directive({
  selector: '[appModal]',
  host: {
    role: 'dialog',
    'aria-modal': 'true',
    '[attr.aria-labelledby]': 'ariaLabelledby() || null',
    tabindex: '-1',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class ModalDialogDirective implements AfterViewInit, OnDestroy {
  /** id of the element labelling the dialog (wired to aria-labelledby). */
  readonly ariaLabelledby = input<string | undefined>(undefined);

  /** Emitted when the user presses Escape; the host should close the dialog. */
  readonly dismiss = output<void>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly focusTrapFactory = inject(ConfigurableFocusTrapFactory);
  private readonly platform = inject(Platform);
  private readonly document = inject(DOCUMENT);

  private focusTrap: ConfigurableFocusTrap | null = null;
  private previouslyFocused: HTMLElement | null = null;

  ngAfterViewInit(): void {
    if (!this.platform.isBrowser) return;
    const active = this.document.activeElement;
    this.previouslyFocused = active instanceof HTMLElement ? active : null;
    this.focusTrap = this.focusTrapFactory.create(this.host.nativeElement);
    // Move focus into the dialog once its first focusable control is ready.
    void this.focusTrap.focusInitialElementWhenReady();
  }

  onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismiss.emit();
  }

  ngOnDestroy(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    // Restore focus to the trigger that opened the dialog.
    this.previouslyFocused?.focus();
    this.previouslyFocused = null;
  }
}
