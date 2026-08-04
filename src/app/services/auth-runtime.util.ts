const DEFAULT_ISSUER = 'http://localhost:8081/realms/psa';
const DEFAULT_CLIENT_ID = 'psa-web';

export interface AuthRuntimeMetadata {
  readonly oidcIssuer?: unknown;
  readonly oidcClientId?: unknown;
}

export interface ResolvedAuthRuntimeConfig {
  readonly issuer: string;
  readonly clientId: string;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function validIssuer(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return candidate.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Resolve public OAuth settings returned by the server's runtime metadata. */
export function resolveAuthRuntimeConfig(metadata: AuthRuntimeMetadata): ResolvedAuthRuntimeConfig {
  return {
    issuer: validIssuer(metadata.oidcIssuer) ?? DEFAULT_ISSUER,
    clientId: nonEmptyString(metadata.oidcClientId) ?? DEFAULT_CLIENT_ID,
  };
}

/**
 * Decode and validate OAuth state before feeding it back to the router.
 * Only an application-local absolute path is accepted, preventing open redirects.
 */
export function safeOAuthReturnPath(encodedState: string | null | undefined): string | null {
  if (!encodedState) return null;
  try {
    const path = decodeURIComponent(encodedState);
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
    return path;
  } catch {
    return null;
  }
}
