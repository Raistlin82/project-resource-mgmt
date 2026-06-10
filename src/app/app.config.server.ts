import {ApplicationConfig, mergeApplicationConfig} from '@angular/core';
import {provideServerRendering, withRoutes} from '@angular/ssr';
import {appConfig} from './app.config';
import {serverRoutes} from './app.routes.server';
import {API_BASE_URL} from './services/api-config';

/**
 * Base URL the Angular SERVER uses for its own `/api` calls during SSR.
 *
 * SSR runs inside the same Node process that serves `/api/*` (see server.ts),
 * so it must call back into THIS server's origin. server.ts binds to
 * `process.env['PORT'] || 3000`, so the SSR base URL must track the SAME port —
 * a hardcoded `:3000` makes every server-side data fetch hit the wrong origin
 * whenever PORT differs (e.g. `PORT=4500`), the fetch fails, and parameterized
 * deep-links like `/projects/1` render their empty/"not found" shell even though
 * the HTTP status is 200. Resolution order:
 *   1. explicit `API_BASE_URL` (full override; keeps the .env / external-API case)
 *   2. derived from this server's own `PORT` (+ optional `HOST`) — the default
 */
const serverPort = process.env['PORT'] || '3000';
// Must match the host server.ts actually binds the listener to
// (`process.env['HOST'] || 'localhost'`). Defaulting to 127.0.0.1 instead would
// break the no-HOST case: Express binds the socket to the `localhost` resolution
// specifically, so a 127.0.0.1 SSR fetch can be refused even though both are loopback.
//
// Wildcard binds are NOT usable as fetch targets: `0.0.0.0` only works
// incidentally on Linux/macOS (and fails on Windows), and a bare IPv6 host
// (`::`, `::1`) produces a malformed URL unless bracketed. A wildcard bind
// always serves loopback, so map those to a host SSR can actually fetch.
function fetchableHost(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') return 'localhost';
  return bindHost.includes(':') ? `[${bindHost}]` : bindHost; // bracket IPv6 literals
}
const serverHost = fetchableHost((process.env['HOST'] || 'localhost').trim());
const serverApiBaseUrl = process.env['API_BASE_URL'] ?? `http://${serverHost}:${serverPort}/api`;

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    {provide: API_BASE_URL, useValue: serverApiBaseUrl},
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
