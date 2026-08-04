export interface SeedDataPhaseDependencies<Transaction> {
  /** PostgreSQL implementation opens one transaction and acquires an advisory lock. */
  runExclusiveTransaction(operation: (transaction: Transaction) => Promise<void>): Promise<void>;
  seedDemoData(transaction: Transaction): Promise<void>;
  backfill(transaction: Transaction): Promise<void>;
}

/** Keep optional demo seed and mandatory additive backfill in one locked transaction. */
export function runSeedDataPhase<Transaction>(
  seedEnabled: boolean,
  dependencies: SeedDataPhaseDependencies<Transaction>,
): Promise<void> {
  return dependencies.runExclusiveTransaction(async transaction => {
    if (seedEnabled) await dependencies.seedDemoData(transaction);
    await dependencies.backfill(transaction);
  });
}
