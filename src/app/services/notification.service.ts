import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type NotificationType = 'error' | 'success' | 'info';

export interface AppNotification {
  id: number;
  message: string;
  type: NotificationType;
}

/** How long toasts stay on screen before auto-dismissing (ms). Errors linger a
 *  little longer so a failure is readable, but nothing stays on screen forever. */
const AUTO_DISMISS_MS = 5000;
const ERROR_DISMISS_MS = 8000;

/** Lightweight global toast/notification store backed by a signal. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _items = signal<AppNotification[]>([]);
  readonly items = this._items.asReadonly();
  private seq = 0;

  show(message: string, type: NotificationType = 'info'): void {
    const id = ++this.seq;
    this._items.update(list => [...list, { id, message, type }]);
    // All toasts auto-dismiss so nothing lingers on screen; errors get a slightly
    // longer window so a failure stays readable. Browser-only: no SSR timers.
    if (this.isBrowser) {
      setTimeout(() => this.dismiss(id), type === 'error' ? ERROR_DISMISS_MS : AUTO_DISMISS_MS);
    }
  }

  error(message: string): void {
    this.show(message, 'error');
  }

  dismiss(id: number): void {
    this._items.update(list => list.filter(n => n.id !== id));
  }
}
