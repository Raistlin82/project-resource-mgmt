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

/** Keep notifications useful without allowing a failure loop to cover the UI. */
const MAX_VISIBLE_NOTIFICATIONS = 5;

interface NotificationTimer {
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

/** Lightweight global toast/notification store backed by a signal. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _items = signal<AppNotification[]>([]);
  readonly items = this._items.asReadonly();
  private seq = 0;
  private readonly timers = new Map<number, NotificationTimer>();

  show(message: string, type: NotificationType = 'info'): void {
    // Interceptors and feature components can observe the same failure. Showing
    // an identical toast twice adds noise without giving the user new action.
    if (this._items().some(item => item.message === message && item.type === type)) return;

    const id = ++this.seq;
    // Cap the visible stack: a request loop that fails once per retry must not
    // paper over the app. The oldest toast is dropped; its pending dismiss timer
    // is harmless because `dismiss` filters by id.
    const previous = this._items();
    const next = [...previous, { id, message, type }].slice(-MAX_VISIBLE_NOTIFICATIONS);
    const retainedIds = new Set(next.map(item => item.id));
    for (const item of previous) if (!retainedIds.has(item.id)) this.clearTimer(item.id);
    this._items.set(next);
    // Browser-only: no SSR timers (there is no DOM/timer clock to auto-dismiss into
    // during SSR, and a timer scheduled there would just leak). Errors remain
    // until explicitly dismissed: an operational failure may require copying or
    // acting on details, and an arbitrary timeout is not a safe ownership model.
    if (this.isBrowser && type !== 'error') this.schedule(id, AUTO_DISMISS_MS);
  }

  error(message: string): void {
    this.show(message, 'error');
  }

  success(message: string): void {
    this.show(message, 'success');
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this._items.update(list => list.filter(n => n.id !== id));
  }

  /** Pause a transient toast while a pointer or keyboard user is reading it. */
  pause(id: number): void {
    const timer = this.timers.get(id);
    if (!timer || timer.handle === null) return;
    clearTimeout(timer.handle);
    timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
    timer.handle = null;
  }

  /** Resume a paused transient toast with only its unread time remaining. */
  resume(id: number): void {
    const timer = this.timers.get(id);
    if (!timer || timer.handle !== null || !this._items().some(item => item.id === id)) return;
    this.schedule(id, timer.remainingMs);
  }

  private schedule(id: number, remainingMs: number): void {
    const timer: NotificationTimer = {
      handle: null,
      remainingMs,
      startedAt: Date.now(),
    };
    timer.handle = setTimeout(() => {
      this.timers.delete(id);
      this._items.update(list => list.filter(item => item.id !== id));
    }, remainingMs);
    this.timers.set(id, timer);
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer?.handle !== null && timer?.handle !== undefined) clearTimeout(timer.handle);
    this.timers.delete(id);
  }
}
