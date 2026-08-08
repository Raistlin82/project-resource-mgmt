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

interface ModalDocumentState {
  readonly stack: HTMLElement[];
  readonly inertedElements: Map<HTMLElement, boolean>;
  readonly bodyOverflow: string;
  readonly bodyOverflowPriority: string;
}

/**
 * Dialogs can be opened from many lazy screens, and some flows replace or nest
 * one dialog with another. Keeping the state per Document makes scroll locking
 * and background isolation reference-counted without introducing an app-wide
 * service solely for DOM bookkeeping.
 */
const modalDocumentStates = new WeakMap<Document, ModalDocumentState>();

function restoreInertState(state: ModalDocumentState): void {
  for (const [element, wasInert] of state.inertedElements) {
    if (wasInert) {
      element.setAttribute('inert', '');
    } else {
      element.removeAttribute('inert');
    }
  }
  state.inertedElements.clear();
}

/**
 * Inert every branch outside the top-most modal. Inerting body/app-root would
 * also inert a dialog rendered inside a routed component, so isolation is
 * applied to siblings at every ancestor level instead. This also keeps a nested
 * dialog operable while making the parent dialog's remaining controls inert.
 */
function isolateTopModal(state: ModalDocumentState): void {
  restoreInertState(state);
  let branch: HTMLElement | null = state.stack.at(-1) ?? null;

  while (branch?.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      state.inertedElements.set(sibling, sibling.hasAttribute('inert'));
      sibling.setAttribute('inert', '');
    }
    branch = parent;
  }
}

function registerModal(document: Document, host: HTMLElement): void {
  let state = modalDocumentStates.get(document);
  if (!state) {
    const bodyStyle = document.body.style;
    state = {
      stack: [],
      inertedElements: new Map(),
      bodyOverflow: bodyStyle.getPropertyValue('overflow'),
      bodyOverflowPriority: bodyStyle.getPropertyPriority('overflow'),
    };
    modalDocumentStates.set(document, state);
    bodyStyle.setProperty('overflow', 'hidden');
  }

  state.stack.push(host);
  isolateTopModal(state);
}

function unregisterModal(
  document: Document,
  host: HTMLElement,
): { wasTop: boolean; nextTop: HTMLElement | null } {
  const state = modalDocumentStates.get(document);
  if (!state) return { wasTop: false, nextTop: null };

  const index = state.stack.lastIndexOf(host);
  const wasTop = index === state.stack.length - 1;
  if (index >= 0) state.stack.splice(index, 1);

  if (state.stack.length) {
    isolateTopModal(state);
    return { wasTop, nextTop: state.stack.at(-1) ?? null };
  }

  restoreInertState(state);
  if (state.bodyOverflow) {
    document.body.style.setProperty('overflow', state.bodyOverflow, state.bodyOverflowPriority);
  } else {
    document.body.style.removeProperty('overflow');
  }
  modalDocumentStates.delete(document);
  return { wasTop, nextTop: null };
}

function isTopModal(document: Document, host: HTMLElement): boolean {
  return modalDocumentStates.get(document)?.stack.at(-1) === host;
}

function canReceiveRestoredFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  return !element.matches(':disabled');
}

function focusIfAvailable(element: HTMLElement | null): boolean {
  if (!canReceiveRestoredFocus(element)) return false;
  element.focus({ preventScroll: true });
  return element.ownerDocument.activeElement === element;
}

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
 *  - body scroll locked and every DOM branch outside the top-most dialog made
 *    inert, with stack-aware restoration for nested dialogs;
 *  - focus moved to the first focusable control (or the dialog root as a safe
 *    fallback) and restored without targeting removed/disabled controls;
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
    // Backdrop-to-dismiss lives HERE, not in five identical template handlers.
    //
    // Why the directive and not the template: a bare `div` carrying `(click)` is
    // neither focusable nor keyboard-operable, which the a11y lint rules
    // correctly refuse — and the obvious silencer, `tabindex="0"` on a backdrop,
    // would put a phantom tab stop on a decorative surface and make the problem
    // worse. On the host the handler sits on an element that already declares
    // `role="dialog"` and `tabindex="-1"`, and the keyboard equivalent is the
    // Escape binding directly above.
    '(click)': 'onBackdropClick($event)',
  },
})
export class ModalDialogDirective implements AfterViewInit, OnDestroy {
  /** id of the element labelling the dialog (wired to aria-labelledby). */
  readonly ariaLabelledby = input<string | undefined>(undefined);

  /**
   * Emitted when the user asks to close: Escape, or a click on the backdrop
   * itself. The host decides what that MEANS — every consumer wires this to its
   * own `closeForm()`, which is where the dirty-state confirm and the
   * "refuse while saving" guard already live. The directive deliberately knows
   * nothing about either.
   */
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
    const host = this.host.nativeElement;
    const focusTrap = this.focusTrapFactory.create(host);
    this.focusTrap = focusTrap;
    registerModal(this.document, host);
    // Move focus into the dialog once its first focusable control is ready.
    void focusTrap.focusFirstTabbableElementWhenReady().then(focused => {
      // The async readiness check can settle after a nested dialog opened or
      // after this one closed. Only the current top-most live trap may focus.
      if (!focused && this.focusTrap === focusTrap && isTopModal(this.document, host)) {
        focusIfAvailable(host);
      }
    });
  }

  /**
   * A click on the BACKDROP dismisses; a click anywhere inside the panel does
   * not. The test is `target === host`: the panel is a descendant, so its clicks
   * arrive with a different target and are left alone. Without that check, every
   * click inside the form would close it.
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target !== this.host.nativeElement) return;
    if (this.platform.isBrowser && !isTopModal(this.document, this.host.nativeElement)) return;
    this.dismiss.emit();
  }

  onEscape(event: Event): void {
    if (this.platform.isBrowser && !isTopModal(this.document, this.host.nativeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    this.dismiss.emit();
  }

  ngOnDestroy(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    if (!this.platform.isBrowser) return;

    const { wasTop, nextTop } = unregisterModal(this.document, this.host.nativeElement);
    if (wasTop) {
      // Prefer the actual trigger. If it disappeared or became disabled as part
      // of the completed action, keep focus in a surviving parent modal, then
      // fall back to the application's main landmark.
      if (!focusIfAvailable(this.previouslyFocused) && !focusIfAvailable(nextTop)) {
        focusIfAvailable(this.document.getElementById('main-content'));
      }
    }
    this.previouslyFocused = null;
  }
}
