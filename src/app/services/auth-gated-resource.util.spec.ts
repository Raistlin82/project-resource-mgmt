import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { authGatedResource } from './auth-gated-resource.util';
import { AuthService } from './auth.service';

/**
 * The unit-level half of the deny-by-default read regression (the runtime half
 * is scripts/smoke-noauth.mjs, which must run with AUTH_TRUST_HEADERS unset).
 *
 * Each test here fails against the bug it describes: delete the `params` gate
 * from the helper and the first test sees the stream called before a principal
 * exists; return `of(defaultValue)` unconditionally and the second sees it never
 * called at all; drop the `params` key entirely and the third never re-fires.
 */
describe('authGatedResource', () => {
  afterEach(() => TestBed.resetTestingModule());

  function harness(authReady: ReturnType<typeof signal<boolean>>) {
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { authReady } }],
    });
    const stream = vi.fn(() => of(['loaded']));
    const resource = TestBed.runInInjectionContext(() =>
      authGatedResource<string[]>(stream, []),
    );
    return { stream, resource };
  }

  /** Let the resource's stream subscription settle, then recompute signals. */
  async function settle() {
    TestBed.tick();
    await Promise.resolve();
    TestBed.tick();
  }

  it('does not call the stream while the principal is unsettled', async () => {
    const authReady = signal(false);
    const { stream, resource } = harness(authReady);
    await settle();
    expect(stream).not.toHaveBeenCalled();
    // The pre-readiness value is the empty default, so value() never throws and
    // no figure is ever derived from an unauthorized envelope.
    expect(resource.value()).toEqual([]);
    expect(resource.error()).toBeUndefined();
  });

  it('calls the stream once the principal has settled', async () => {
    const authReady = signal(true);
    const { stream, resource } = harness(authReady);
    await settle();
    expect(stream).toHaveBeenCalledOnce();
    expect(resource.value()).toEqual(['loaded']);
  });

  it('re-fires when authReady flips false -> true (the latch this prevents)', async () => {
    const authReady = signal(false);
    const { stream, resource } = harness(authReady);
    await settle();
    expect(stream).not.toHaveBeenCalled();

    authReady.set(true);
    await settle();
    expect(stream).toHaveBeenCalledOnce();
    expect(resource.value()).toEqual(['loaded']);
  });
});
