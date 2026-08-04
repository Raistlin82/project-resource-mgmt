import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type NotificationType = 'error' | 'success' | 'info';

export interface AppNotification {
  id: number;
  message: string;
  type: NotificationType;
}

/** How long a non-error toast stays on screen before auto-dismissing (ms). */
const AUTO_DISMISS_MS = 5000;

/** How long an error toast stays on screen before auto-dismissing (ms).
 *  Every toast now disappears on its own; an error just gets more time to be
 *  read than a success does, since a success only needs a glimpse. */
const ERROR_AUTO_DISMISS_MS = 12000;

/** Keep notifications useful without allowing a failure loop to cover the UI. */
const MAX_VISIBLE_NOTIFICATIONS = 5;

/** Lightweight global toast/notification store backed by a signal. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _items = signal<AppNotification[]>([]);
  readonly items = this._items.asReadonly();
  private seq = 0;

  show(message: string, type: NotificationType = 'info'): void {
    // Interceptors and feature components can observe the same failure. Showing
    // an identical toast twice adds noise without giving the user new action.
    if (this._items().some(item => item.message === message && item.type === type)) return;

    const id = ++this.seq;
    // Cap the visible stack: a request loop that fails once per retry must not
    // paper over the app. The oldest toast is dropped; its pending dismiss timer
    // is harmless because `dismiss` filters by id.
    this._items.update(list =>
      [...list, { id, message, type }].slice(-MAX_VISIBLE_NOTIFICATIONS),
    );
    // Browser-only: no SSR timers (there is no DOM/timer clock to auto-dismiss into
    // during SSR, and a timer scheduled there would just leak). Every toast
    // auto-dismisses; errors get a longer timeout because they must be read, not
    // just glimpsed.
    if (this.isBrowser) {
      const delay = type === 'error' ? ERROR_AUTO_DISMISS_MS : AUTO_DISMISS_MS;
      setTimeout(() => this.dismiss(id), delay);
    }
  }

  error(message: string): void {
    this.show(message, 'error');
  }

  success(message: string): void {
    this.show(message, 'success');
  }

  dismiss(id: number): void {
    this._items.update(list => list.filter(n => n.id !== id));
  }
}
