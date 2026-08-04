import { resolveAuthRuntimeConfig, safeOAuthReturnPath } from './auth-runtime.util';

describe('OIDC runtime configuration', () => {
  it('uses deployment-provided public issuer and client id', () => {
    expect(resolveAuthRuntimeConfig({
      oidcIssuer: 'https://identity.example.com/realms/psa/',
      oidcClientId: 'delivery-control-web',
    })).toEqual({
      issuer: 'https://identity.example.com/realms/psa',
      clientId: 'delivery-control-web',
    });
  });

  it('falls back to the local realm only when runtime metadata is absent', () => {
    expect(resolveAuthRuntimeConfig({})).toEqual({
      issuer: 'http://localhost:8081/realms/psa',
      clientId: 'psa-web',
    });
  });
});

describe('OIDC return path validation', () => {
  it('restores an encoded same-origin deep link', () => {
    expect(safeOAuthReturnPath('%2Fprojects%2F42%3Ftab%3Drates')).toBe('/projects/42?tab=rates');
  });

  it('rejects absolute, protocol-relative and malformed redirect state', () => {
    expect(safeOAuthReturnPath('https%3A%2F%2Fevil.example%2Fsteal')).toBeNull();
    expect(safeOAuthReturnPath('%2F%2Fevil.example%2Fsteal')).toBeNull();
    expect(safeOAuthReturnPath('%E0%A4%A')).toBeNull();
  });
});
