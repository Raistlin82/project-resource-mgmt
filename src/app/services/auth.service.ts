import { Injectable, signal, computed } from '@angular/core';
import { UserRole } from './api.service';

/**
 * Single source of truth for the current user's identity.
 *
 * MOCK ONLY: identity is currently selectable in-memory/localStorage. This
 * intentionally centralizes the previously-scattered
 * `currentUserId = '1'` / `currentManagerId = '1'` literals (audit B18) so that
 * wiring a real authentication provider later is a single-file change. Do NOT
 * reintroduce hardcoded ids in components — inject this service instead.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _userId = signal(this.load('demoUserId', '1'));
  private readonly _role = signal<UserRole>(this.load('demoUserRole', 'delivery-executive') as UserRole);

  readonly userId = this._userId.asReadonly();
  readonly role = this._role.asReadonly();
  readonly isManager = computed(() => ['resource-manager', 'delivery-executive', 'admin'].includes(this._role()));
  readonly canManageCommercial = computed(() => ['sales', 'finance', 'delivery-executive', 'admin'].includes(this._role()));
  readonly canApproveFinancials = computed(() => ['finance', 'delivery-executive', 'admin'].includes(this._role()));
  readonly canApproveDelivery = computed(() => ['pm', 'delivery-executive', 'admin'].includes(this._role()));

  /** Replace with real sign-in wiring when an auth provider is added. */
  setUser(id: string, role: UserRole = 'employee'): void {
    this._userId.set(id);
    this._role.set(role);
    this.store('demoUserId', id);
    this.store('demoUserRole', role);
  }

  hasAnyRole(roles: UserRole[]): boolean {
    return roles.includes(this._role());
  }

  private load(key: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    try {
      return window.localStorage?.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  private store(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      // Storage can be unavailable in SSR/tests; identity still works in memory.
    }
  }
}
