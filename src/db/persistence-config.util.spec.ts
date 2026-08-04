import { PersistenceConfigurationError, resolvePersistenceConfig } from './persistence-config.util';

describe('persistence adapter configuration', () => {
  it('preserves the local-development default and selects PostgreSQL when a URL is present', () => {
    expect(resolvePersistenceConfig({ NODE_ENV: 'development' })).toEqual({
      adapter: 'memory', production: false, seedDemoData: true,
    });
    expect(resolvePersistenceConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://db/app' })).toEqual({
      adapter: 'postgresql', databaseUrl: 'postgres://db/app', production: false, seedDemoData: true,
    });
  });

  it('rejects unknown adapter and seed-mode values instead of falling back', () => {
    expect(() => resolvePersistenceConfig({ PERSISTENCE_ADAPTER: 'postgres' }))
      .toThrowError(PersistenceConfigurationError);
    expect(() => resolvePersistenceConfig({ SEED_DEMO_DATA: 'yes' }))
      .toThrowError(PersistenceConfigurationError);
    expect(() => resolvePersistenceConfig({ NODE_ENV: 'prodution' }))
      .toThrowError(PersistenceConfigurationError);
  });

  it('rejects incomplete or contradictory explicit adapter configuration', () => {
    expect(() => resolvePersistenceConfig({ PERSISTENCE_ADAPTER: 'postgresql' }))
      .toThrow(/DATABASE_URL/);
    expect(() => resolvePersistenceConfig({
      PERSISTENCE_ADAPTER: 'memory', DATABASE_URL: 'postgres://db/app',
    })).toThrow(/conflicts/i);
  });

  it('fails closed when production would otherwise fall back to memory', () => {
    expect(() => resolvePersistenceConfig({ NODE_ENV: 'production' }))
      .toThrow(/production/i);
    expect(() => resolvePersistenceConfig({
      NODE_ENV: 'production', PERSISTENCE_ADAPTER: 'memory',
    })).toThrow(/production/i);
  });

  it('does not seed demo data in production unless explicitly enabled', () => {
    expect(resolvePersistenceConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://db/app',
    }).seedDemoData).toBe(false);
    expect(resolvePersistenceConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://db/app', SEED_DEMO_DATA: 'true',
    }).seedDemoData).toBe(true);
  });
});
