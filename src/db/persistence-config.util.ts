export type PersistenceAdapter = 'memory' | 'postgresql';

export type PersistenceConfig =
  | { adapter: 'memory'; production: false; seedDemoData: boolean }
  | { adapter: 'postgresql'; databaseUrl: string; production: boolean; seedDemoData: boolean };

export class PersistenceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConfigurationError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanSetting(name: string, raw: string | undefined): boolean | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PersistenceConfigurationError(`${name} must be exactly "true" or "false"`);
}

/**
 * Resolve persistence once at process startup. Unsafe ambiguity is rejected:
 * production can never select memory, explicit adapter/URL conflicts fail, and
 * demo seeding defaults off in production.
 */
export function resolvePersistenceConfig(environment: Environment): PersistenceConfig {
  const nodeEnvironment = nonEmpty(environment['NODE_ENV']);
  if (nodeEnvironment !== undefined
      && nodeEnvironment !== 'development'
      && nodeEnvironment !== 'test'
      && nodeEnvironment !== 'production') {
    throw new PersistenceConfigurationError(
      `Unknown NODE_ENV "${nodeEnvironment}"; expected "development", "test", or "production"`,
    );
  }
  const production = nodeEnvironment === 'production';
  const databaseUrl = nonEmpty(environment['DATABASE_URL']);
  const requestedAdapter = nonEmpty(environment['PERSISTENCE_ADAPTER']);

  if (requestedAdapter !== undefined
      && requestedAdapter !== 'memory'
      && requestedAdapter !== 'postgresql') {
    throw new PersistenceConfigurationError(
      `Unknown PERSISTENCE_ADAPTER "${requestedAdapter}"; expected "memory" or "postgresql"`,
    );
  }

  const adapter: PersistenceAdapter = requestedAdapter ?? (databaseUrl ? 'postgresql' : 'memory');
  if (adapter === 'memory' && databaseUrl) {
    throw new PersistenceConfigurationError(
      'PERSISTENCE_ADAPTER=memory conflicts with DATABASE_URL; refusing to ignore persistent storage',
    );
  }
  if (adapter === 'postgresql' && !databaseUrl) {
    throw new PersistenceConfigurationError(
      'PERSISTENCE_ADAPTER=postgresql requires a non-empty DATABASE_URL',
    );
  }
  if (production && adapter !== 'postgresql') {
    throw new PersistenceConfigurationError(
      'Production requires PostgreSQL persistence; refusing to fall back to memory/demo state',
    );
  }

  const seedOverride = booleanSetting('SEED_DEMO_DATA', environment['SEED_DEMO_DATA']);
  const seedDemoData = seedOverride ?? !production;
  if (adapter === 'memory') return { adapter, production: false, seedDemoData };
  return { adapter, databaseUrl: databaseUrl as string, production, seedDemoData };
}
