import { runSeedDataPhase } from './bootstrap-policy.util';

describe('PostgreSQL bootstrap data phase', () => {
  it('runs demo seed and backfill inside one exclusive transaction', async () => {
    const events: string[] = [];
    let insideTransaction = false;

    await runSeedDataPhase(true, {
      runExclusiveTransaction: async operation => {
        events.push('begin+lock');
        insideTransaction = true;
        await operation('transaction');
        insideTransaction = false;
        events.push('commit');
      },
      seedDemoData: async transaction => {
        expect(insideTransaction).toBe(true);
        expect(transaction).toBe('transaction');
        events.push('seed');
      },
      backfill: async transaction => {
        expect(insideTransaction).toBe(true);
        expect(transaction).toBe('transaction');
        events.push('backfill');
      },
    });

    expect(events).toEqual(['begin+lock', 'seed', 'backfill', 'commit']);
  });

  it('still runs schema/data backfill transactionally when demo seed is disabled', async () => {
    const events: string[] = [];

    await runSeedDataPhase(false, {
      runExclusiveTransaction: async operation => {
        events.push('begin+lock');
        await operation('transaction');
        events.push('commit');
      },
      seedDemoData: async () => { events.push('seed'); },
      backfill: async () => { events.push('backfill'); },
    });

    expect(events).toEqual(['begin+lock', 'backfill', 'commit']);
  });
});
