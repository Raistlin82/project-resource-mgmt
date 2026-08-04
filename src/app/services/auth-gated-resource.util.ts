import { inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Observable, of } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * A principal-gated `rxResource` for a collection read that needs nothing from
 * the route or the form — only a settled principal.
 *
 * WHY THIS EXISTS (do not inline the ungated form again).
 *
 * The server's GET policy is deny-by-default (`authorizeRead()` in
 * `src/server/authz-policy.util.ts`): apart from the two public bootstrap paths,
 * every `/api` read needs a trusted principal or it answers **401**. A resource
 * declared with a `stream` and a `defaultValue` but no `params` fires once at
 * field-init — during SSR and during hydration, before the OIDC bootstrap has
 * settled, with no bearer token — and, having no `params`, it has nothing to
 * re-fire on when `authReady` flips true. The 401 latches for the life of the
 * component: `value()` throws `ResourceValueError` from then on, so the screen
 * renders empty (or aborts) until a full page reload, which reproduces it. That
 * is invisible under `AUTH_TRUST_HEADERS=true`, because the pre-`authReady` demo
 * header is itself a trusted principal.
 *
 * This helper is the repo rule from CLAUDE.md ("components key their
 * `rxResource` params on `auth.authReady()` and return an empty default until it
 * flips true") in one place, so no call site can express half of it: the gate and
 * the empty default are the same expression.
 *
 * Use the explicit `rxResource` form instead when the read is keyed on anything
 * more than readiness (a route id, a capability, a selected filter) — then fold
 * `auth.authReady()` into that `params` expression, as `projects.ts` does for
 * `/contracts`.
 *
 * Must be called from an injection context (a field initializer is one).
 *
 * @param stream Called only once a principal is available.
 * @param defaultValue Also the pre-readiness value, so `value()` never throws
 *   and never shows a figure derived from an unauthorized envelope.
 */
export function authGatedResource<T>(stream: () => Observable<T>, defaultValue: T) {
  const auth = inject(AuthService);
  return rxResource<T, boolean>({
    params: () => auth.authReady(),
    stream: ({ params: ready }) => (ready ? stream() : of(defaultValue)),
    defaultValue,
  });
}
