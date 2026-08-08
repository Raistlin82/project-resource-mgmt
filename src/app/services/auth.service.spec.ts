import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OAuthService } from 'angular-oauth2-oidc';
import { EMPTY } from 'rxjs';
import { AuthService } from './auth.service';

describe('AuthService identity boundaries', () => {
  function setup(): AuthService {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: OAuthService,
          useValue: {
            events: EMPTY,
            initCodeFlow: vi.fn(),
            logOut: vi.fn(),
          },
        },
      ],
    });
    return TestBed.inject(AuthService);
  }

  afterEach(() => TestBed.resetTestingModule());

  it('gives an anonymous principal no role and no employee capability', () => {
    const auth = setup();

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.roles()).toEqual([]);
    expect(auth.role() as string).toBe('');
    expect(auth.hasAnyRole(['employee'])).toBe(false);
    expect(auth.canSubmitOwnTime()).toBe(false);
    expect(auth.canReadStaffing()).toBe(false);
    expect(auth.canManageCommercial()).toBe(false);
  });

  it('grants employee behavior only when employee is an explicit authenticated role', () => {
    const auth = setup();
    auth.setUser('1', 'employee');

    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.roles()).toEqual(['employee']);
    expect(auth.role()).toBe('employee');
    expect(auth.hasResourceIdentity()).toBe(true);
    expect(auth.canSubmitOwnTime()).toBe(true);
  });

  it('keeps an authenticated but unmapped employee from resource-scoped actions', () => {
    const auth = setup();
    auth.setUser('unmapped-account', 'employee');

    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.roles()).toEqual(['employee']);
    expect(auth.hasResourceIdentity()).toBe(false);
    expect(auth.canSubmitOwnTime()).toBe(false);
  });
});
