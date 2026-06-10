/**
 * Generic, hardened CRUD Express router backed by a `Repository<T>` (SERVER-ONLY).
 *
 * `createCrudRouter` is the repository-backed successor to the `crud()` helper in
 * `src/server.ts`: it mounts the five standard REST endpoints for a single
 * id-keyed collection, but persists through the `Repository<T>` abstraction
 * (`src/db/repository.ts`) instead of an in-process `{ items: T[] }` array, so the
 * same router works against either the in-memory or the Postgres adapter selected
 * by `getRepositories()` (`src/db/repositories.ts`).
 *
 * It keeps the SAME security philosophy as `server.ts`:
 *   - NO MASS ASSIGNMENT: writes copy ONLY `allowedFields` from the request body
 *     via a local `pick()` equivalent (server.ts does not export its `pick`, and
 *     this module must not modify server.ts), so untrusted callers cannot set
 *     server-owned fields (id, audit stamps, derived state, ...).
 *   - VALIDATION: an optional `validate(body)` hook (mirroring `findInvalidNumericField`
 *     / the per-resource validators in server.ts) rejects invalid input — e.g.
 *     negative/NaN numbers or broken FKs — with `400 { error }` before any write.
 *   - SERVER-ASSIGNED ID: POST always assigns the id from `idFactory?.()` (or the
 *     built-in monotonic fallback); any client-supplied id is dropped by `pick()`.
 *
 * Endpoints (ALL async; the router is auth/role/audit-agnostic and is expected to
 * be mounted under the already-hardened `apiRouter` middleware stack):
 *   - GET    '/'      -> repo.list()                         (200 json T[])
 *   - GET    '/:id'   -> repo.get(id)                        (200 json T | 404 { error })
 *   - POST   '/'      -> validate + pick + assign id + create (201 json T | 400 { error })
 *   - PUT    '/:id'   -> 404 if missing; validate + pick + update (200 json T | 4xx)
 *   - DELETE '/:id'   -> repo.remove(id)                     (204 no content | 404 { error })
 */
import express, { type Request, type Response, type Router } from 'express';

import type { Entity, Repository } from '../db/repository';

/**
 * S1 (mass-assignment): copy ONLY allow-listed fields from an untrusted body.
 *
 * Local equivalent of the `pick()` in `src/server.ts` (which is not exported, and
 * which this task must not modify). Keys whose value is `undefined` are skipped so
 * a PUT applies a true partial patch without clobbering stored fields with
 * `undefined`.
 */
function pick<T extends object>(body: unknown, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  if (body && typeof body === 'object') {
    const src = body as Record<string, unknown>;
    for (const k of keys) {
      if (src[k] !== undefined) out[k] = src[k];
    }
  }
  return out as Partial<T>;
}

/**
 * Default server-side id generator (a `newId`-equivalent, mirroring server.ts).
 * Monotonic per process; only used when no `idFactory` is supplied. Module-scoped
 * so ids stay unique across every router built without a custom factory.
 */
let idSeq = 1000;
const defaultNewId = (): string => `${++idSeq}`;

/**
 * Read the `:id` route parameter as a single string.
 *
 * `req.params` is typed `Record<string, string | string[]>` here, and this
 * project enables `noPropertyAccessFromIndexSignature`, so the param is read with
 * bracket access and an array form (only possible with repeated params, which
 * this route shape never produces) is collapsed to its first element.
 */
function idParam(req: Request): string {
  const raw = req.params['id'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Options for {@link createCrudRouter}.
 *
 * @typeParam T - the entity type; must carry a string `id` (`Entity`).
 */
export interface CrudRouterOptions<T extends Entity> {
  /** Backing store. Either adapter from `getRepositories()` works unchanged. */
  repo: Repository<T>;
  /**
   * Allow-list of body fields a client may set on POST/PUT. Anything outside this
   * list (notably `id` and any server-owned/derived field) is dropped, preventing
   * mass assignment.
   */
  allowedFields: readonly string[];
  /**
   * Optional id generator for POST. Defaults to the built-in monotonic
   * `newId`-equivalent. A client-supplied id is always ignored (it is not — and
   * must not be — in `allowedFields`).
   */
  idFactory?: () => string;
  /**
   * Optional validation hook run on the request body for POST and PUT BEFORE the
   * allow-listed fields are applied. Return an error message to reject with
   * `400 { error }`, or `null` when the body is acceptable. Mirrors the
   * validate-then-`pick` ordering used throughout server.ts.
   */
  validate?: (body: unknown) => string | null;
}

/**
 * Build an Express {@link Router} exposing the five standard CRUD endpoints for a
 * single `Repository<T>`-backed collection. See the module doc comment for the
 * endpoint contract and security guarantees.
 *
 * @typeParam T - the entity type; must extend `Entity` (string `id`).
 */
export function createCrudRouter<T extends Entity>(opts: CrudRouterOptions<T>): Router {
  const { repo, allowedFields, validate } = opts;
  const newId = opts.idFactory ?? defaultNewId;
  const router = express.Router();

  // GET '/' -> all entities.
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const items = await repo.list();
    res.json(items);
  });

  // GET '/:id' -> one entity, or 404 when absent.
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const item = await repo.get(idParam(req));
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(item);
  });

  // POST '/' -> validate, pick allow-listed fields, assign a server-side id, create.
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    if (validate) {
      const error = validate(req.body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
    }
    // NO MASS ASSIGNMENT: only allow-listed fields survive; id is server-assigned
    // last so a client-supplied id (even if somehow allow-listed) cannot win.
    const data = pick<T>(req.body, allowedFields);
    const entity = { ...data, id: newId() } as T;
    const created = await repo.create(entity);
    res.status(201).json(created);
  });

  // PUT '/:id' -> 404 if missing, then validate, pick allow-listed fields, update.
  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = idParam(req);
    const existing = await repo.get(id);
    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (validate) {
      const error = validate(req.body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
    }
    // NO MASS ASSIGNMENT: a partial patch of only the allow-listed fields. The
    // repository pins `id`, so the path id is authoritative regardless of body.
    const patch = pick<T>(req.body, allowedFields);
    const updated = await repo.update(id, patch);
    if (!updated) {
      // Lost-update race: the row vanished between the existence check and the
      // update. Surface it as a 404 rather than emitting a misleading 200.
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(updated);
  });

  // DELETE '/:id' -> 204 on success, 404 when the entity does not exist.
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const removed = await repo.remove(idParam(req));
    if (!removed) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
