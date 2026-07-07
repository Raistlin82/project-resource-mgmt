/**
 * Composition root for persistence (SERVER-ONLY).
 *
 * Wires every domain entity to a `Repository<T>` and exposes them through a
 * single, fully-typed `Repositories` object obtained via the memoized
 * `getRepositories()` accessor.
 *
 * Adapter selection (mirrors src/db/client.ts):
 *   - `process.env.DATABASE_URL` SET   -> `PgRepository(db, <table>)` per entity
 *                                         (`db` is the shared Drizzle handle).
 *   - `process.env.DATABASE_URL` UNSET -> `InMemoryRepository(<seed array>)`
 *                                         per entity (the DEV/mock store).
 *
 * Two entities are NATURAL-KEY (no `id` column in the source interfaces and the
 * Drizzle schema): `languages` (keyed by `code`) and `fxRates` (keyed by
 * `currency`). The generic `Repository<T>` / `PgRepository` / `InMemoryRepository`
 * machinery in `./repository.ts` requires `T extends Entity` (a string `id`),
 * which neither satisfies. We therefore expose these two through small,
 * self-contained natural-key adapters that implement the SAME `Repository<T>`
 * surface keyed on their natural-key column, so callers see one uniform
 * `Repository<T>` per entity. No `any` is used anywhere in this module.
 *
 * IMPORTANT: this module must never be imported into a browser bundle — it pulls
 * in `./client.ts` (node-postgres) and the Drizzle schema.
 */
import { eq } from 'drizzle-orm';
import type {
  PgColumn,
  PgTable,
  PgInsertValue,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core';

import { db } from './client';
import {
  InMemoryRepository,
  PgRepository,
  nullsToUndefined,
  type Repository,
  type EntityTable,
  type Entity,
  type DrizzleDb,
} from './repository';

import * as schema from './schema';
import * as seed from './seed';

import type {
  Resource,
  User,
  ResourceRequest,
  Assignment,
  TimeEntry,
  Language,
  SkillCatalog,
  ProficiencySet,
  Skill,
  ProjectRole,
  ServiceOrganization,
  ResourceOrganization,
  Country,
  City,
  Industry,
  CostCategory,
  PartnerRole,
  Vendor,
  RateCard,
  Setting,
  Project,
  Partner,
  ProjectDocument,
  WorkPackage,
  Milestone,
  FinancialItem,
  ProjectCostCenter,
  Task,
  Issue,
  ChangeRequest,
  CostCenter,
  Customer,
  Contract,
  Order,
  OrderLine,
  BillingPlanItem,
  ApprovalRequest,
  AuditLog,
  FxRate,
} from '../app/services/api.service';

// ---------------------------------------------------------------------------
// Natural-key entity row types.
//
// `Language` and `FxRate` have no `id` in the source interfaces; their identity
// is `code` / `currency`. To flow them through the `Repository<T extends Entity>`
// contract WITHOUT mutating the persisted shape, we model each as the original
// interface intersected with an `id: string` that ALWAYS MIRRORS the natural
// key (`id === code` / `id === currency`). The adapters below keep that mirror
// in sync on every read/write, so the natural-key field stays authoritative and
// the synthetic `id` is purely the identity `Repository<T>` needs.
// ---------------------------------------------------------------------------

/** `Language` exposed with an `id` mirroring `code` (id === code). */
export type LanguageRow = Language & Entity;
/** `FxRate` exposed with an `id` mirroring `currency` (id === currency). */
export type FxRateRow = FxRate & Entity;
/** `Country` exposed with an `id` mirroring `code` (id === code). */
export type CountryRow = Country & Entity;

/**
 * Natural-key DEV adapter.
 *
 * Wraps an `InMemoryRepository` over rows that carry a synthetic `id` mirroring
 * a natural-key field (`keyField`). Seeds are projected to add `id`; writes that
 * change the natural key keep `id` in lockstep. The store-isolation guarantees
 * of `InMemoryRepository` are inherited unchanged.
 */
class NaturalKeyInMemoryRepository<TRow extends Entity, KBase>
  implements Repository<TRow>
{
  private readonly inner: InMemoryRepository<TRow>;

  constructor(
    seedRows: readonly KBase[],
    private readonly keyField: keyof KBase & keyof TRow & string,
  ) {
    const projected = seedRows.map((row) => this.withId(row));
    this.inner = new InMemoryRepository<TRow>(projected);
  }

  /** Project a key-only base row into a row whose `id` mirrors its natural key. */
  private withId(row: KBase): TRow {
    const key = String((row as Record<string, unknown>)[this.keyField]);
    return { ...(row as object), id: key } as unknown as TRow;
  }

  list(): Promise<TRow[]> {
    return this.inner.list();
  }

  get(id: string): Promise<TRow | undefined> {
    return this.inner.get(id);
  }

  create(entity: TRow): Promise<TRow> {
    // Keep `id` and the natural-key field consistent on insert.
    const key = String((entity as Record<string, unknown>)[this.keyField]);
    const normalized = { ...(entity as object), id: key } as unknown as TRow;
    return this.inner.create(normalized);
  }

  async update(id: string, patch: Partial<TRow>): Promise<TRow | undefined> {
    // If the patch rewrites the natural key, the identity must move with it.
    // `InMemoryRepository.update` pins `id`, so a key change is applied as a
    // remove+create to keep `id === <naturalKey>` invariant intact.
    const keyPatch = (patch as Record<string, unknown>)[this.keyField];
    if (keyPatch !== undefined && String(keyPatch) !== id) {
      const existing = await this.inner.get(id);
      if (!existing) return undefined;
      const newKey = String(keyPatch);
      const merged = { ...existing, ...patch, id: newKey } as TRow;
      await this.inner.remove(id);
      return this.inner.create(merged);
    }
    return this.inner.update(id, patch);
  }

  remove(id: string): Promise<boolean> {
    return this.inner.remove(id);
  }
}

/**
 * A natural-key pgTable: a `PgTable` that exposes its key column (`KCol`) as a
 * Drizzle `PgColumn`. Used to constrain `NaturalKeyPgRepository` to tables that
 * actually have the addressed key column, without naming the literal table
 * config.
 */
type NaturalKeyTable<KCol extends string> = PgTable & Record<KCol, PgColumn>;

/**
 * Natural-key production adapter.
 *
 * A PostgreSQL `Repository<TRow>` for tables whose primary key is a natural-key
 * column (`keyColumn`) rather than an `id` column. CRUD maps onto Drizzle's
 * query builder exactly like `PgRepository`, but addresses rows by the natural
 * key and synthesizes the `id` mirror on the way out (and strips it on the way
 * in, since the table has no `id` column).
 */
class NaturalKeyPgRepository<TRow extends Entity, KCol extends string>
  implements Repository<TRow>
{
  /**
   * The table widened to the concrete `PgTable` type, used for the query-builder
   * calls (`.select().from()`, `.insert()`, `.update()`, `.delete()`). Drizzle's
   * `.from()` parameter type contains a conditional (`TableLikeHasEmptySelection`)
   * that TypeScript leaves DEFERRED when handed an unresolved generic table,
   * rejecting the argument; a value typed as the non-generic `PgTable` resolves
   * the conditional to `false` and is accepted. This widening is a sound upcast
   * (no `unknown`/`any`); the typed `table` is retained for key-column access.
   */
  private readonly tbl: PgTable;

  constructor(
    private readonly database: DrizzleDb,
    private readonly table: NaturalKeyTable<KCol>,
    private readonly keyColumn: KCol,
  ) {
    this.tbl = table;
  }

  /**
   * Add the synthetic `id` (mirroring the natural key) to a stored DB row, and
   * normalize nullable columns to the `V | undefined` contract via
   * `nullsToUndefined` so the prod JSON shape matches the in-memory (DEV)
   * adapter (no `key: null` vs key-absent divergence). Applied on every return
   * path (list/get/create/update). The synthetic `id` is derived from the
   * natural key, which is never null, so it is added after normalization.
   */
  private withId(row: Record<string, unknown>): TRow {
    const normalized = nullsToUndefined(row);
    return { ...normalized, id: String(row[this.keyColumn]) } as unknown as TRow;
  }

  /** Drop the synthetic `id` before writing — the table has no `id` column. */
  private stripId(row: Record<string, unknown>): Record<string, unknown> {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (key !== 'id') {
        rest[key] = row[key];
      }
    }
    return rest;
  }

  async list(): Promise<TRow[]> {
    const rows = (await this.database
      .select()
      .from(this.tbl)
      .orderBy(this.table[this.keyColumn])) as Record<string, unknown>[];
    return rows.map((row) => this.withId(row));
  }

  async get(id: string): Promise<TRow | undefined> {
    const rows = (await this.database
      .select()
      .from(this.tbl)
      .where(eq(this.table[this.keyColumn], id))
      .limit(1)) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.withId(row) : undefined;
  }

  async create(entity: TRow): Promise<TRow> {
    const values = this.stripId(entity as unknown as Record<string, unknown>);
    // LOCALIZED CAST (Drizzle generics): `.values()` wants the table's
    // statically-inferred insert model, which cannot be tied to the generic
    // `TRow` here (same rationale documented on `PgRepository`). The natural-key
    // column constraint guarantees structural correctness at runtime; the cast
    // is confined to this one argument via `unknown`.
    const rows = (await this.database
      .insert(this.tbl)
      .values(values as unknown as PgInsertValue<PgTable>)
      .returning()) as Record<string, unknown>[];
    return this.withId(rows[0]);
  }

  async update(id: string, patch: Partial<TRow>): Promise<TRow | undefined> {
    const setValues = this.stripId(patch as Record<string, unknown>);
    // Empty-patch parity with the in-memory adapter: if there is nothing to set
    // (no keys, or every remaining value is `undefined`), Drizzle's `.set()`
    // throws "No values to set" — a 500 in prod, while the in-memory adapter
    // returns the unchanged entity (200). Short-circuit to a plain read so both
    // adapters behave identically.
    const hasValuesToSet = Object.values(setValues).some(
      (value) => value !== undefined,
    );
    if (!hasValuesToSet) {
      return this.get(id);
    }
    // LOCALIZED CAST (Drizzle generics): same rationale as `create`, for the
    // `.set()` update model. Set semantics are unchanged — `undefined` is
    // omitted by Drizzle (no clobber), explicit `null` still sets NULL; only the
    // RETURNED row is normalized (inside `withId`).
    const rows = (await this.database
      .update(this.tbl)
      .set(setValues as unknown as PgUpdateSetSource<PgTable>)
      .where(eq(this.table[this.keyColumn], id))
      .returning()) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.withId(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const rows = (await this.database
      .delete(this.tbl)
      .where(eq(this.table[this.keyColumn], id))
      .returning()) as Record<string, unknown>[];
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// The fully-typed Repositories surface — one Repository<T> per entity.
// ---------------------------------------------------------------------------

export interface Repositories {
  resources: Repository<Resource>;
  users: Repository<User>;
  requests: Repository<ResourceRequest>;
  assignments: Repository<Assignment>;
  timeEntries: Repository<TimeEntry>;
  languages: Repository<LanguageRow>;
  skillCatalogs: Repository<SkillCatalog>;
  proficiencySets: Repository<ProficiencySet>;
  skills: Repository<Skill>;
  projectRoles: Repository<ProjectRole>;
  serviceOrganizations: Repository<ServiceOrganization>;
  resourceOrganizations: Repository<ResourceOrganization>;
  countries: Repository<CountryRow>;
  cities: Repository<City>;
  industries: Repository<Industry>;
  costCategories: Repository<CostCategory>;
  partnerRoles: Repository<PartnerRole>;
  vendors: Repository<Vendor>;
  rateCards: Repository<RateCard>;
  settings: Repository<Setting>;
  projects: Repository<Project>;
  projectPartners: Repository<Partner>;
  projectDocuments: Repository<ProjectDocument>;
  workPackages: Repository<WorkPackage>;
  milestones: Repository<Milestone>;
  projectFinancials: Repository<FinancialItem>;
  projectCostCenters: Repository<ProjectCostCenter>;
  projectTasks: Repository<Task>;
  projectIssues: Repository<Issue>;
  changeRequests: Repository<ChangeRequest>;
  costCenters: Repository<CostCenter>;
  customers: Repository<Customer>;
  contracts: Repository<Contract>;
  orders: Repository<Order>;
  orderLines: Repository<OrderLine>;
  billingPlanItems: Repository<BillingPlanItem>;
  fxRates: Repository<FxRateRow>;
  approvalRequests: Repository<ApprovalRequest>;
  auditLogs: Repository<AuditLog>;
}

/**
 * Build the Postgres-backed `Repositories`. Receives the (non-null) Drizzle
 * handle. Every id-bearing entity uses `PgRepository(db, <table>)`; the two
 * natural-key entities use `NaturalKeyPgRepository`.
 */
function buildPgRepositories(database: DrizzleDb): Repositories {
  // Small helper to construct one `PgRepository<T>` per id-bearing table.
  //
  // LOCALIZED CAST (Drizzle `$inferSelect` vs the api.service interfaces):
  // `PgRepository`'s `EntityTable<T>` constraint demands `table.$inferSelect`
  // EXACTLY equal `T`. Drizzle infers a NULLABLE column as `prop: V | null`,
  // whereas the api.service interfaces model the same field as OPTIONAL
  // (`prop?: V`, i.e. `V | undefined`). `null` is not assignable to `undefined`,
  // so the otherwise structurally-identical row type fails the constraint. The
  // runtime shapes are compatible (a nullable column simply carries `null`
  // where the interface would omit the key), so we bridge the table argument
  // through `unknown` HERE — one confined cast — keeping every entry's public
  // `Repository<T>` boundary precise and free of `any`.
  const pg = <T extends Entity>(table: PgTable & { id: PgColumn }): Repository<T> =>
    new PgRepository<T>(database, table as unknown as EntityTable<T>);

  return {
    resources: pg<Resource>(schema.resources),
    users: pg<User>(schema.users),
    requests: pg<ResourceRequest>(schema.requests),
    assignments: pg<Assignment>(schema.assignments),
    timeEntries: pg<TimeEntry>(schema.timeEntries),
    languages: new NaturalKeyPgRepository<LanguageRow, 'code'>(
      database,
      schema.languages,
      'code',
    ),
    skillCatalogs: pg<SkillCatalog>(schema.skillCatalogs),
    proficiencySets: pg<ProficiencySet>(schema.proficiencySets),
    skills: pg<Skill>(schema.skills),
    projectRoles: pg<ProjectRole>(schema.projectRoles),
    serviceOrganizations: pg<ServiceOrganization>(schema.serviceOrganizations),
    resourceOrganizations: pg<ResourceOrganization>(
      schema.resourceOrganizations,
    ),
    countries: new NaturalKeyPgRepository<CountryRow, 'code'>(
      database,
      schema.countries,
      'code',
    ),
    cities: pg<City>(schema.cities),
    industries: pg<Industry>(schema.industries),
    costCategories: pg<CostCategory>(schema.costCategories),
    partnerRoles: pg<PartnerRole>(schema.partnerRoles),
    vendors: pg<Vendor>(schema.vendors),
    rateCards: pg<RateCard>(schema.rateCards),
    settings: pg<Setting>(schema.settings),
    projects: pg<Project>(schema.projects),
    projectPartners: pg<Partner>(schema.projectPartners),
    projectDocuments: pg<ProjectDocument>(schema.projectDocuments),
    workPackages: pg<WorkPackage>(schema.workPackages),
    milestones: pg<Milestone>(schema.milestones),
    projectFinancials: pg<FinancialItem>(schema.projectFinancials),
    projectCostCenters: pg<ProjectCostCenter>(schema.projectCostCenters),
    projectTasks: pg<Task>(schema.projectTasks),
    projectIssues: pg<Issue>(schema.projectIssues),
    changeRequests: pg<ChangeRequest>(schema.changeRequests),
    costCenters: pg<CostCenter>(schema.costCenters),
    customers: pg<Customer>(schema.customers),
    contracts: pg<Contract>(schema.contracts),
    orders: pg<Order>(schema.orders),
    orderLines: pg<OrderLine>(schema.orderLines),
    billingPlanItems: pg<BillingPlanItem>(schema.billingPlanItems),
    fxRates: new NaturalKeyPgRepository<FxRateRow, 'currency'>(
      database,
      schema.fxRates,
      'currency',
    ),
    approvalRequests: pg<ApprovalRequest>(schema.approvalRequests),
    auditLogs: pg<AuditLog>(schema.auditLogs),
  };
}

/**
 * Build the in-memory `Repositories` from the shared seed arrays. Every
 * id-bearing entity uses `InMemoryRepository(<seed>)`; the two natural-key
 * entities use `NaturalKeyInMemoryRepository`.
 */
function buildInMemoryRepositories(): Repositories {
  const mem = <T extends Entity>(seedRows: readonly T[]): Repository<T> =>
    new InMemoryRepository<T>(seedRows);

  return {
    resources: mem<Resource>(seed.resources),
    users: mem<User>(seed.users),
    requests: mem<ResourceRequest>(seed.requests),
    assignments: mem<Assignment>(seed.assignments),
    timeEntries: mem<TimeEntry>(seed.timeEntries),
    languages: new NaturalKeyInMemoryRepository<LanguageRow, Language>(
      seed.languages,
      'code',
    ),
    skillCatalogs: mem<SkillCatalog>(seed.skillCatalogs),
    proficiencySets: mem<ProficiencySet>(seed.proficiencySets),
    skills: mem<Skill>(seed.skills),
    projectRoles: mem<ProjectRole>(seed.projectRoles),
    serviceOrganizations: mem<ServiceOrganization>(seed.serviceOrganizations),
    resourceOrganizations: mem<ResourceOrganization>(
      seed.resourceOrganizations,
    ),
    countries: new NaturalKeyInMemoryRepository<CountryRow, Country>(
      seed.countries,
      'code',
    ),
    cities: mem<City>(seed.cities),
    industries: mem<Industry>(seed.industries),
    costCategories: mem<CostCategory>(seed.costCategories),
    partnerRoles: mem<PartnerRole>(seed.partnerRoles),
    vendors: mem<Vendor>(seed.vendors),
    rateCards: mem<RateCard>(seed.rateCards),
    settings: mem<Setting>(seed.settings),
    projects: mem<Project>(seed.projects),
    projectPartners: mem<Partner>(seed.projectPartners),
    projectDocuments: mem<ProjectDocument>(seed.projectDocuments),
    workPackages: mem<WorkPackage>(seed.workPackages),
    milestones: mem<Milestone>(seed.milestones),
    projectFinancials: mem<FinancialItem>(seed.projectFinancials),
    projectCostCenters: mem<ProjectCostCenter>(seed.projectCostCenters),
    projectTasks: mem<Task>(seed.projectTasks),
    projectIssues: mem<Issue>(seed.projectIssues),
    changeRequests: mem<ChangeRequest>(seed.changeRequests),
    costCenters: mem<CostCenter>(seed.costCenters),
    customers: mem<Customer>(seed.customers),
    contracts: mem<Contract>(seed.contracts),
    orders: mem<Order>(seed.orders),
    orderLines: mem<OrderLine>(seed.orderLines),
    billingPlanItems: mem<BillingPlanItem>(seed.billingPlanItems),
    fxRates: new NaturalKeyInMemoryRepository<FxRateRow, FxRate>(
      seed.fxRates,
      'currency',
    ),
    approvalRequests: mem<ApprovalRequest>(seed.approvalRequests),
    auditLogs: mem<AuditLog>(seed.auditLogs),
  };
}

// ---------------------------------------------------------------------------
// Memoized accessor.
// ---------------------------------------------------------------------------

let cached: Repositories | undefined;

/**
 * Return the process-wide `Repositories`, building it once on first use.
 *
 * Selection is driven by `DATABASE_URL` exactly as `src/db/client.ts`:
 * when set, `db` is non-null and the Postgres adapters are used; otherwise the
 * in-memory (seeded) adapters are used. The result is memoized so every caller
 * shares the same repository instances (and, for the in-memory adapters, the
 * same backing stores) for the lifetime of the process.
 */
export function getRepositories(): Repositories {
  if (cached) return cached;
  cached = db ? buildPgRepositories(db) : buildInMemoryRepositories();
  return cached;
}
