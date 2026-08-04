/**
 * Persistence bootstrap (SERVER-ONLY).
 *
 * `initPersistence()` is called ONCE at server boot (by WF-2, from src/server.ts)
 * and brings the selected database to a ready state:
 *
 *   - PostgreSQL: one advisory-lock-protected transaction applies pending
 *     migrations, optional demo seed, and additive backfills. Concurrent process
 *     starts serialize at the database boundary.
 *   - Demo seed runs only when the validated seed policy enables it; production
 *     defaults it off and therefore cannot be contaminated implicitly.
 *
 *   - Validated memory mode: NO-OP. The in-memory repositories returned by
 *     getRepositories() are already constructed from the same seed arrays, so
 *     there is nothing to migrate or seed.
 *
 * Safe to retry: the locked transaction, empty checks, and conflict-safe inserts
 * make repeat/concurrent calls idempotent. No `any` is used.
 *
 * IMPORTANT: server-only — pulls in ./client.ts (node-postgres) and the schema.
 */
import { count, sql } from 'drizzle-orm';
import type { PgTable, PgInsertValue } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { db, persistenceConfig } from './client';
import { runSeedDataPhase } from './bootstrap-policy.util';
import { type DrizzleDb } from './repository';
import * as schema from './schema';
import * as seed from './seed';

/**
 * Folder holding the generated SQL migrations. Matches `out: './drizzle'` in
 * drizzle.config.ts and resolves against the process working directory (the
 * project root) at server boot, exactly like the drizzle-kit CLI.
 */
const MIGRATIONS_FOLDER = './drizzle';
const BOOTSTRAP_DATA_LOCK = 'project-resource-mgmt:bootstrap-data:v1';

/**
 * Insert `rows` into `table` only if the table is currently empty
 * (`count(*) === 0`). Returns the number of rows inserted (0 when the table was
 * already populated or the seed array was empty).
 *
 * Generic over the concrete `PgTable`; the seed array's element type is the
 * table's insert model structurally (both derive from the same api.service
 * interfaces), so the single Drizzle-generics cast is localized to the
 * `.values()` argument via `unknown` — never widening `table` to `any`.
 */
async function seedIfEmpty<T extends PgTable>(
  database: DrizzleDb,
  table: T,
  rows: readonly unknown[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  // Widen the generic table to the concrete `PgTable` for the query-builder
  // calls. Drizzle's `.from()` parameter contains a conditional type that
  // TypeScript leaves DEFERRED for an unresolved generic table (rejecting it),
  // whereas a value typed as the non-generic `PgTable` resolves it and is
  // accepted. This is a sound upcast — no `unknown`/`any`.
  const tbl: PgTable = table;
  const [{ value }] = await database.select({ value: count() }).from(tbl);
  if (value !== 0) {
    // Table already has data — idempotent no-op.
    return 0;
  }
  // LOCALIZED CAST (Drizzle generics): `.values()` expects the table's inferred
  // insert model, which cannot be tied to the generic `T` statically. The seed
  // arrays are the matching shapes by construction, so the cast (via `unknown`)
  // is confined to this one argument.
  const inserted = await database
    .insert(tbl)
    .values(rows as unknown as PgInsertValue<PgTable>[])
    .onConflictDoNothing()
    .returning();
  return inserted.length;
}

/**
 * Create the month rows an already-populated database is missing (B3).
 *
 * Idempotent and additive: only (assignment, month) pairs that have day rows but
 * no lifecycle row are inserted, carrying the assignment's CURRENT status — what
 * was booked and approved before B3 stays approved. Runs after seeding so a
 * fresh database (already consistent via seed.ts) finds nothing to do. The
 * mapping day -> month needs the calendar, so it cannot live in the SQL migration.
 */
async function backfillAssignmentMonths(database: DrizzleDb): Promise<number> {
  const days = await database.select().from(schema.assignmentDays);
  if (days.length === 0) return 0;
  const existing = new Set((await database.select().from(schema.assignmentMonths)).map(m => m.id));
  const statusById = new Map(
    (await database.select().from(schema.assignments)).map(a => [a.id, a.status]),
  );
  const VALID = new Set(['Draft', 'Requested', 'Allocated', 'Rejected']);

  const rows: { id: string; assignmentId: string; month: string; status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected' }[] = [];
  const seen = new Set<string>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    const id = `${d.assignmentId}:${month}`;
    if (existing.has(id) || seen.has(id)) continue;
    const raw = statusById.get(d.assignmentId);
    if (raw === undefined) continue; // orphan day row: nothing to attach a lifecycle to
    seen.add(id);
    rows.push({
      id, assignmentId: d.assignmentId, month,
      // A pre-B3 free-text status that is not one of the four is treated as
      // booked work: 'Allocated' preserves the aggregates it already fed.
      status: (VALID.has(raw) ? raw : 'Allocated') as 'Draft' | 'Requested' | 'Allocated' | 'Rejected',
    });
  }
  if (rows.length === 0) return 0;
  const inserted = await database
    .insert(schema.assignmentMonths)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: schema.assignmentMonths.id });
  return inserted.length;
}

/** Seed demo rows parent-before-child so every FK is satisfied. */
async function seedDemoDatabase(database: DrizzleDb): Promise<void> {
  // Each entry is guarded independently by its own count(*) === 0 check. The
  // caller holds the cross-process bootstrap advisory lock for this transaction.
  //    Each entry is guarded independently by its own count(*) === 0 check.
  // Roots (no outgoing FKs to other seeded tables).
  await seedIfEmpty(database, schema.customers, seed.customers);
  // C1: resources.vendorId FKs to vendors (subco only), so vendors must be
  // seeded first. vendors itself has no outgoing FKs, so hoisting it here
  // ahead of its own "Customizing catalogs" batch below is safe.
  await seedIfEmpty(database, schema.vendors, seed.vendors);
  await seedIfEmpty(database, schema.resources, seed.resources); // -> vendors (C1, subco only)
  await seedIfEmpty(database, schema.languages, seed.languages);
  await seedIfEmpty(database, schema.fxRates, seed.fxRates);
  await seedIfEmpty(database, schema.settings, seed.settings); // global settings (hoursPerDay)
  await seedIfEmpty(database, schema.skillCatalogs, seed.skillCatalogs);
  await seedIfEmpty(database, schema.proficiencySets, seed.proficiencySets);
  await seedIfEmpty(database, schema.projectRoles, seed.projectRoles);
  await seedIfEmpty(database, schema.costCenters, seed.costCenters);
  await seedIfEmpty(
    database,
    schema.serviceOrganizations,
    seed.serviceOrganizations,
  );

  // Customizing catalogs (Phase F1 — additive). Roots, except cities which FK
  // to countries (countries seeded first).
  await seedIfEmpty(database, schema.countries, seed.countries);
  await seedIfEmpty(database, schema.cities, seed.cities); // -> countries
  await seedIfEmpty(database, schema.industries, seed.industries);
  await seedIfEmpty(database, schema.costCategories, seed.costCategories);
  await seedIfEmpty(database, schema.partnerRoles, seed.partnerRoles);
  // vendors is seeded earlier, above, alongside the other roots — resources
  // (C1) now FKs to it, and resources seeds before this batch runs.
  // Rate cards (Phase E): role-based default rates. No DB FK (role/org are name
  // strings matched at resolve time), so ordering is unconstrained.
  await seedIfEmpty(database, schema.rateCards, seed.rateCards);

  // First-level dependents.
  await seedIfEmpty(database, schema.contracts, seed.contracts); // -> customers
  await seedIfEmpty(database, schema.users, seed.users); // -> resources
  await seedIfEmpty(database, schema.skills, seed.skills); // -> proficiencySets
  await seedIfEmpty(
    database,
    schema.resourceOrganizations,
    seed.resourceOrganizations,
  ); // -> serviceOrganizations

  // Projects depend on contracts.
  await seedIfEmpty(database, schema.projects, seed.projects); // -> contracts

  // Negotiated sell rates (design spec) FK to BOTH contracts and projects, so
  // this step must run after both are seeded above. A previous feature shipped
  // a server that could not boot on a fresh database because a new reference
  // broke this ordering — invisible in-memory, since that adapter enforces no
  // foreign keys, so this comment (and this position) is load-bearing.
  await seedIfEmpty(database, schema.negotiatedRates, seed.negotiatedRates); // -> contracts, projects

  // Project sub-resources depend on projects (and partners).
  await seedIfEmpty(database, schema.projectPartners, seed.projectPartners); // -> projects
  await seedIfEmpty(database, schema.requests, seed.requests); // -> projects
  await seedIfEmpty(database, schema.projectDocuments, seed.projectDocuments); // -> projects
  await seedIfEmpty(database, schema.workPackages, seed.workPackages); // -> projects
  await seedIfEmpty(database, schema.milestones, seed.milestones); // -> projects
  await seedIfEmpty(
    database,
    schema.projectFinancials,
    seed.projectFinancials,
  ); // -> projects
  await seedIfEmpty(
    database,
    schema.projectCostCenters,
    seed.projectCostCenters,
  ); // -> projects
  await seedIfEmpty(database, schema.projectTasks, seed.projectTasks); // -> projects, projectPartners
  await seedIfEmpty(database, schema.projectIssues, seed.projectIssues); // -> projects
  await seedIfEmpty(database, schema.changeRequests, seed.changeRequests); // -> projects

  // Time-phased allocation (B1) config catalogs. Roots (no outgoing FKs).
  await seedIfEmpty(database, schema.holidays, seed.holidays);
  await seedIfEmpty(database, schema.planningPeriods, seed.planningPeriods);

  // Demand/staffing fulfilment.
  await seedIfEmpty(database, schema.assignments, seed.assignments); // -> requests, resources
  await seedIfEmpty(database, schema.assignmentDays, seed.assignmentDays); // -> assignments
  await seedIfEmpty(database, schema.assignmentMonths, seed.assignmentMonths); // -> assignments
  // Commercial chain.
  await seedIfEmpty(database, schema.orders, seed.orders); // -> contracts, projectPartners
  await seedIfEmpty(database, schema.timeEntries, seed.timeEntries); // -> assignments, requests, resources, projects
  await seedIfEmpty(database, schema.orderLines, seed.orderLines); // -> orders, projects
  await seedIfEmpty(database, schema.billingPlanItems, seed.billingPlanItems); // -> contracts, projects, milestones, orders

  // Approval workflow (references projects; refId is a soft reference).
  await seedIfEmpty(database, schema.approvalRequests, seed.approvalRequests); // -> projects

  // auditLogs is intentionally append-only and seeded empty -> nothing to insert.
  await seedIfEmpty(database, schema.auditLogs, seed.auditLogs);
}

/**
 * Initialize persistence at server boot.
 *
 * Migrations remain idempotent. All data bootstrap work then runs in one
 * PostgreSQL transaction under a transaction-scoped advisory lock, serializing
 * concurrent process starts. Production demo seed runs only when the validated
 * `SEED_DEMO_DATA=true` policy explicitly enables it; additive backfills always
 * run so upgraded real databases still receive required derived rows.
 */
export async function initPersistence(): Promise<void> {
  if (persistenceConfig.adapter === 'memory') return;
  if (!db) throw new Error('PostgreSQL persistence selected but the database client is unavailable');
  const database: DrizzleDb = db;

  await runSeedDataPhase<DrizzleDb>(persistenceConfig.seedDemoData, {
    runExclusiveTransaction: operation => database.transaction(async transaction => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${BOOTSTRAP_DATA_LOCK}, 0))`,
      );
      const transactionDatabase = transaction as unknown as DrizzleDb;
      // Drizzle's migrator uses a nested transaction/savepoint here. Keeping it
      // under the same advisory lock serializes migrations and seed across all
      // app processes, while PostgreSQL transactional DDL preserves rollback.
      await migrate(transactionDatabase, { migrationsFolder: MIGRATIONS_FOLDER });
      await operation(transactionDatabase);
    }),
    seedDemoData: seedDemoDatabase,
    backfill: async transaction => { await backfillAssignmentMonths(transaction); },
  });
}
