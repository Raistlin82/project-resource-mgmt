import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type NotificationType = 'error' | 'success' | 'info';

export interface AppNotification {
  id: number;
  message: string;
  type: NotificationType;
}

/** How long non-error toasts stay on screen before auto-dismissing (ms).
 *  Errors are sticky so backend/auth failures do not disappear before they are read. */
const AUTO_DISMISS_MS = 5000;

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
    // Browser-only: no SSR timers. Errors are intentionally sticky.
    if (this.isBrowser && type !== 'error') {
      setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
    }
  }

  error(message: string): void {
    this.show(message, 'error');
  }

  dismiss(id: number): void {
    this._items.update(list => list.filter(n => n.id !== id));
  }
}
