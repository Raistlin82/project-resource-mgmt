import { Injectable, PLATFORM_ID, afterNextRender, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'dc-theme';

/**
 * Light-first theme service. Dark is opt-in:
 *  - default (no stored pref) leaves `document.documentElement.dataset.theme`
 *    unset, which the foundation treats as light.
 *  - 'dark' sets `data-theme="dark"`, which the foundation's
 *    `:root[data-theme="dark"]` block uses to override the semantic tokens.
 *
 * SSR-safe: the DOM/localStorage is only ever touched inside `afterNextRender`
 * (browser-only, post first render) or behind `isPlatformBrowser`, so nothing
 * runs during server render where `document`/`localStorage` don't exist.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  /** Current theme; mirrors the applied `data-theme`. Starts light for SSR parity. */
  readonly theme = signal<Theme>('light');

  constructor() {
    // afterNextRender never runs on the server, so reading localStorage and
    // touching documentElement here is safe and avoids hydration mismatches.
    afterNextRender(() => {
      const stored = this.readStored();
      if (stored === 'dark') {
        this.apply('dark');
      } else {
        // Default = light: do nothing (leave dataset.theme unset).
        this.theme.set('light');
      }
    });
  }

  /** Flip between light and dark, persist the choice, and re-apply to the DOM. */
  toggle(): void {
    if (!this.isBrowser) return;
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage can throw (private mode / disabled) — theme still applies.
    }
  }

  private apply(theme: Theme): void {
    this.theme.set(theme);
    if (!this.isBrowser) return;
    const root = document.documentElement;
    if (theme === 'dark') {
      root.dataset['theme'] = 'dark';
    } else {
      delete root.dataset['theme'];
    }
  }

  private readStored(): Theme | null {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch {
      return null;
    }
  }
}
