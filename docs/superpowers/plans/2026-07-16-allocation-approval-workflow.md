# Allocation Approval Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introdurre il ciclo Pianificazione → Approvazione dell'allocazione risorse (Draft → Requested → Allocated/Rejected) riusando il motore `approvalRequests` esistente.

**Architecture:** Un `assignment` acquista una macchina a stati validata. Proporre un'allocazione (`Requested`) crea un `approvalRequest` di nuovo `kind='Allocation'`, instradato al People Manager (`managerId` della risorsa) con fallback al ruolo `resource-manager`. La decisione (approve/reject) sull'approvazione, via l'endpoint `/approval-requests/:id/decision` già esistente, aggiorna lo stato dell'assignment tramite un hook post-decisione e ricalcola due aggregati (confermato = `Allocated`; pianificato = `Requested`+`Allocated`). Se il proponente coincide col manager della risorsa, l'allocazione è auto-approvata.

**Tech Stack:** Express 5 (`src/server.ts`), Drizzle ORM + PostgreSQL / in-memory repository (`src/db`), Angular 21 signal-first (`src/app`), Vitest (`@angular/build:unit-test`).

**Spec di riferimento:** `docs/superpowers/specs/2026-07-16-allocation-approval-workflow-design.md`

---

## Note trasversali (leggere PRIMA di iniziare)

### Modello di identità (nodo critico)
Il motore approvazioni ragiona in **user-id space**: `by = actorId(req)` e `requestedBy` sono user-id (o l'header demo `X-User-Id`). Il `managerId` di una risorsa è invece un **resource-id** (self-reference verso `resources.id`). Per farli combaciare senza ambiguità:
- `step.approverId` contiene il **resource-id del manager** (= `resource.managerId`).
- L'enforcement e l'auto-approvazione confrontano `await actorResourceId(req)` (resource-id dell'attore, `server.ts:387`) con `approverId`/`managerId`, **non** `actorId`.
- La SoD esistente (`by === ar.requestedBy`, user-id space) resta invariata.
- Nei dati demo `X-User-Id` = resource-id, quindi i due spazi coincidono; in produzione la mappatura user→resource è `users.resourceId`.

### Macchina a stati
`ALLOCATION_STATES = 'Draft' | 'Requested' | 'Allocated' | 'Rejected'`.
- Transizioni **guidate dall'utente** via `PUT/POST /assignments`: l'utente può impostare `status` solo a `Draft` o `Requested`. `Allocated`/`Rejected` non sono mai client-settable (derivano dalla decisione), esattamente come `Fulfilled`/`Approved` altrove.
- `Requested → Allocated | Rejected`: solo via `PUT /approval-requests/:id/decision` (hook).
- `Allocated → Requested`: **automatico** quando si modificano `assignedHours`/`startDate`/`endDate`/`resourceId` di un assignment `Allocated` (forza ri-approvazione).
- `Rejected → Requested`: quando il PM rimanda (imposta `status='Requested'`).
- Auto-approvazione: se il proponente è il manager della risorsa, `Draft/Requested → Allocated` diretto, nessun `approvalRequest`.

### Doppio aggregato
- `resources.utilization` (esistente) = solo assignment `Allocated`. Nuovo `resources.utilizationPlanned` = `Requested`+`Allocated`.
- `requests.staffedEffort` (esistente) = solo `Allocated`. Nuovo `requests.staffedEffortPlanned` = `Requested`+`Allocated`.
- Entrambi diventano **recompute-by-status** dall'insieme completo degli assignment (oggi `utilization` è già così, `staffedEffort` è incrementale e va convertito).

### Convenzioni test
I test server sono **pure unit test** senza Express/DB (`src/server/server-logic.spec.ts`, `src/app/services/staffing.util.spec.ts`): si estrae la logica in funzioni pure in `staffing.util.ts` e la si testa. Il flusso HTTP end-to-end si verifica con `scripts/smoke-api.mjs`. Comandi: `npm test` (tutti), `npx ng build` (typecheck), `npm run lint`.

---

## File Structure

**Modificati:**
- `src/app/services/api.service.ts` — tipi `ApprovalKind`, `ApprovalStep` (+`approverId`, +`note`); interfacce `Assignment` (status tipizzato, +`approvalId`), `ResourceRequest` (+`staffedEffortPlanned`), `Resource` (+`utilizationPlanned`).
- `src/db/schema.ts` — colonne `assignments.approval_id`, `requests.staffed_effort_planned`, `resources.utilization_planned`.
- `src/app/services/staffing.util.ts` — **cuore della logica pura**: transizioni allocazione, routing step, recompute doppio aggregato, mapping decisione→stato.
- `src/app/services/staffing.util.spec.ts` — test delle funzioni pure.
- `src/server.ts` — tipi locali `ApprovalKind`/`ApprovalStep`/`APPROVAL_KINDS`; handler `POST/PUT/DELETE /assignments`; `recomputeResourceUtilization` + nuova `recomputeRequestStaffing`; enforcement + hook nel decision handler; routing allocazione.
- `src/db/seed.ts` — `status` degli assignment → `Allocated`; aggregati `planned`.
- `src/app/staffing/staffing.component.ts` — azioni "Salva in bozza" / "Manda in approvazione".
- `src/app/resource-requests/resource-requests.component.ts` — badge stati + doppia barra.
- `src/app/approvals/approvals.ts` — kind `Allocation`, `canDecide` via `approverId`.
- `src/app/resources/resources.component.ts` — campo `managerId` nel form.
- `scripts/smoke-api.mjs` — copertura del flusso allocazione.
- `docs/roles-and-permissions.md` — nuovo kind `Allocation` + routing per-manager.

**Creati:**
- `drizzle/0008_*.sql` (+ update `drizzle/meta/_journal.json`) — generato da `drizzle-kit generate` + backfill manuale.

---

## Task 0: Branch di lavoro

- [ ] **Step 1: Creare il branch**

```bash
git checkout -b feature/allocation-approval-workflow
git add docs/superpowers/specs/2026-07-16-allocation-approval-workflow-design.md docs/superpowers/plans/2026-07-16-allocation-approval-workflow.md
git commit -m "docs: allocation approval workflow spec + plan"
```

---

## Task 1: Estendere i tipi di approvazione e assignment

**Files:**
- Modify: `src/app/services/api.service.ts:445-453` (canonico) e `:71-83`, `:56-69`, `:15`
- Modify: `src/server.ts:2379-2397` (copia locale — DEVE restare in sync col canonico)

- [ ] **Step 1: `api.service.ts` — estendere i tipi canonici**

In `src/app/services/api.service.ts`:
```ts
export type ApprovalKind = 'TimeEntry' | 'Expense' | 'Milestone' | 'ChangeRequest' | 'Invoice' | 'Allocation';

export interface ApprovalStep {
  role: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  /** Resource-id of the specific approver (People Manager) authorised to decide this step, in addition to `role`. */
  approverId?: string;
  /** Approver's note recorded on decision (the requester's note lives on ApprovalRequest.note). */
  note?: string;
}
```
Estendere `Assignment` (`:71`): `status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected'` e aggiungere `approvalId?: string;`.
Estendere `ResourceRequest` (`:56`): aggiungere `staffedEffortPlanned?: number;`.
Estendere `Resource` (`:15`): aggiungere `utilizationPlanned?: number;`.

- [ ] **Step 2: `server.ts` — allineare la copia locale**

In `src/server.ts:2379`: `type ApprovalKind = ... | 'Allocation';`. In `:2381` aggiungere `approverId?: string; note?: string;` a `ApprovalStep`. In `:2397`: `APPROVAL_KINDS = [... , 'Allocation']`.

- [ ] **Step 3: Typecheck**

Run: `npx ng build`
Expected: build OK (nessun errore di tipo). Se falla, allineare i punti che usano `Assignment.status` come stringa libera.

- [ ] **Step 4: Commit**

```bash
git add src/app/services/api.service.ts src/server.ts
git commit -m "feat(alloc): add Allocation approval kind, step approverId/note, typed assignment status"
```

---

## Task 2: Funzioni pure — transizioni e routing (TDD)

**Files:**
- Modify: `src/app/services/staffing.util.ts`
- Test: `src/app/services/staffing.util.spec.ts`

- [ ] **Step 1: Scrivere i test che falliscono**

In `src/app/services/staffing.util.spec.ts` aggiungere:
```ts
import { isAllowedAllocationTransition, allocationApproverStep, ALLOCATION_CLIENT_SETTABLE } from './staffing.util';

describe('allocation transition guard', () => {
  it('allows client-settable moves: Draft<->Requested, Rejected->Requested, Allocated->Requested', () => {
    expect(isAllowedAllocationTransition('Draft', 'Requested')).toBe(true);
    expect(isAllowedAllocationTransition('Requested', 'Draft')).toBe(true);
    expect(isAllowedAllocationTransition('Rejected', 'Requested')).toBe(true);
    // Allocated -> Requested is the manual re-request path (Task 6 Step 2 relies on it).
    expect(isAllowedAllocationTransition('Allocated', 'Requested')).toBe(true);
  });
  it('rejects client jumps straight to Allocated/Rejected', () => {
    expect(isAllowedAllocationTransition('Draft', 'Allocated')).toBe(false);
    expect(isAllowedAllocationTransition('Requested', 'Rejected')).toBe(false);
  });
  it('allows no-op', () => {
    for (const s of ['Draft','Requested','Allocated','Rejected'] as const) {
      expect(isAllowedAllocationTransition(s, s)).toBe(true);
    }
  });
});

describe('allocationApproverStep', () => {
  it('routes to the resource manager (resource-id) with fallback role', () => {
    expect(allocationApproverStep('R42')).toEqual({ role: 'resource-manager', status: 'Pending', approverId: 'R42' });
  });
  it('falls back to role only when no manager', () => {
    expect(allocationApproverStep(undefined)).toEqual({ role: 'resource-manager', status: 'Pending' });
  });
});
```

- [ ] **Step 2: Verificare il fallimento** — Run: `npm test -- staffing.util` → FAIL (funzioni non definite).

- [ ] **Step 3: Implementazione minima**

In `src/app/services/staffing.util.ts` (usa i tipi già importati da `./api.service`; importare `ApprovalStep`, `Assignment`):
```ts
import type { ApprovalStep, Assignment } from './api.service';

export type AllocationStatus = 'Draft' | 'Requested' | 'Allocated' | 'Rejected';

/** Only these statuses may be set by a client via POST/PUT /assignments. */
export const ALLOCATION_CLIENT_SETTABLE: readonly AllocationStatus[] = ['Draft', 'Requested'];

// CLIENT-SETTABLE transitions only. The system transitions Requested -> Allocated
// and Requested -> Rejected are applied DIRECTLY by the decision hook (Task 5) and
// never routed through this guard, so they are intentionally absent here. This keeps
// the table consistent with ALLOCATION_CLIENT_SETTABLE.
const ALLOCATION_TRANSITIONS: Readonly<Record<AllocationStatus, readonly AllocationStatus[]>> = {
  Draft: ['Requested'],
  Requested: ['Draft'],
  Allocated: ['Requested'],
  Rejected: ['Requested'],
};

export function isAllowedAllocationTransition(from: AllocationStatus, to: AllocationStatus): boolean {
  if (from === to) return true;
  return ALLOCATION_TRANSITIONS[from].includes(to);
}

/** Build the single approval step for an allocation: the resource's manager (resource-id), fallback role only. */
export function allocationApproverStep(managerId: string | undefined): ApprovalStep {
  return managerId
    ? { role: 'resource-manager', status: 'Pending', approverId: managerId }
    : { role: 'resource-manager', status: 'Pending' };
}
```

- [ ] **Step 4: Verificare il pass** — Run: `npm test -- staffing.util` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/staffing.util.ts src/app/services/staffing.util.spec.ts
git commit -m "feat(alloc): pure allocation transition guard + approver routing"
```

---

## Task 3: Funzioni pure — doppio aggregato (TDD)

**Files:**
- Modify: `src/app/services/staffing.util.ts`
- Test: `src/app/services/staffing.util.spec.ts`

- [ ] **Step 1: Test che falliscono**

```ts
import { assignmentAggregateHours, decisionToAssignmentStatus } from './staffing.util';

describe('assignmentAggregateHours', () => {
  const rows = [
    { assignedHours: 10, status: 'Allocated' },
    { assignedHours: 5, status: 'Requested' },
    { assignedHours: 3, status: 'Draft' },
    { assignedHours: 7, status: 'Rejected' },
  ] as Assignment[];
  it('confirmed counts only Allocated', () => {
    expect(assignmentAggregateHours(rows).confirmed).toBe(10);
  });
  it('planned counts Requested + Allocated (not Draft/Rejected)', () => {
    expect(assignmentAggregateHours(rows).planned).toBe(15);
  });
});

describe('decisionToAssignmentStatus', () => {
  it('maps Approved->Allocated, Rejected->Rejected', () => {
    expect(decisionToAssignmentStatus('Approved')).toBe('Allocated');
    expect(decisionToAssignmentStatus('Rejected')).toBe('Rejected');
  });
});
```

- [ ] **Step 2: Verificare il fallimento** — Run: `npm test -- staffing.util` → FAIL.

- [ ] **Step 3: Implementazione**

```ts
/** Sum assignedHours split by lifecycle: confirmed = Allocated; planned = Requested + Allocated. */
export function assignmentAggregateHours(rows: Pick<Assignment, 'assignedHours' | 'status'>[]): { confirmed: number; planned: number } {
  let confirmed = 0, planned = 0;
  for (const a of rows) {
    const h = Number.isFinite(a.assignedHours) ? a.assignedHours : 0;
    if (a.status === 'Allocated') { confirmed += h; planned += h; }
    else if (a.status === 'Requested') { planned += h; }
  }
  return { confirmed, planned };
}

export function decisionToAssignmentStatus(decision: 'Approved' | 'Rejected'): AllocationStatus {
  return decision === 'Approved' ? 'Allocated' : 'Rejected';
}
```

- [ ] **Step 4: Verificare il pass** — Run: `npm test -- staffing.util` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/staffing.util.ts src/app/services/staffing.util.spec.ts
git commit -m "feat(alloc): pure dual-aggregate (confirmed/planned) + decision mapping"
```

---

## Task 4: Recompute server-side dei due aggregati

**Files:**
- Modify: `src/server.ts:996-1006` (`recomputeResourceUtilization`) + nuova `recomputeRequestStaffing`

- [ ] **Step 1: Estendere `recomputeResourceUtilization`**

Sostituire il corpo (`server.ts:996`) per scrivere entrambi gli aggregati usando `assignmentAggregateHours`:
```ts
async function recomputeResourceUtilization(resourceId: string): Promise<void> {
  const resource = await repos.resources.get(resourceId);
  if (!resource) return;
  const rows = (await repos.assignments.list()).filter(a => a.resourceId === resourceId);
  const { confirmed, planned } = assignmentAggregateHours(rows);
  await repos.resources.update(resourceId, {
    utilization: clampUtil(utilizationContribution(confirmed, resource.capacity)),
    utilizationPlanned: clampUtil(utilizationContribution(planned, resource.capacity)),
  });
}
```
Importare `assignmentAggregateHours` da `./app/services/staffing.util`.

- [ ] **Step 2: Nuova `recomputeRequestStaffing`**

Aggiungere accanto:
```ts
async function recomputeRequestStaffing(requestId: string): Promise<void> {
  const request = await repos.requests.get(requestId);
  if (!request) return;
  const rows = (await repos.assignments.list()).filter(a => a.requestId === requestId);
  const { confirmed, planned } = assignmentAggregateHours(rows);
  await repos.requests.update(request.id, {
    staffedEffort: confirmed,
    staffedEffortPlanned: planned,
    status: requestStatusFor(request, confirmed),
  });
}
```
Nota: `requestStatusFor` usa il **confermato** (una request è `Fulfilled` solo con ore allocate approvate).

- [ ] **Step 3: Verifica build/test** — Run: `npx ng build` poi `npm test` → OK.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(alloc): recompute confirmed/planned aggregates by status"
```

---

## Task 5: Enforcement decisione + hook post-decisione (server)

**Files:**
- Modify: `src/server.ts:2478-2540` (decision handler)

- [ ] **Step 1: Accettare `note` e consentire l'approvatore specifico**

Nel decision handler:
- `pick` allow-list: `['decision', 'note']`.
- Dopo aver risolto `decidingRole`, calcolare `const deciderResourceId = await actorResourceId(req);`.
- Modificare lo step-role enforcement (`:2519`) in:
```ts
const roleMatch = decidingRole === step.role || decidingRole === 'admin';
const managerMatch = step.approverId !== undefined && deciderResourceId === step.approverId;
if (!roleMatch && !managerMatch) {
  return { status: 403, body: { error: `Actor cannot decide a step assigned to ${step.approverId ?? step.role}` } };
}
```
- Registrare la nota approvatore sullo step: `if (typeof body.note === 'string') step.note = body.note;` (prima di settare `step.status`).

- [ ] **Step 2: Hook post-decisione per il kind Allocation**

Dopo `res.status(result.status).json(result.body);` non è possibile (response già inviata). Applicare l'effetto **dentro** `withLock('approval:...')` NO — l'effetto tocca res:/req: e va fatto DOPO il rilascio del lock approval. Struttura: catturare l'esito dal `withLock`, poi:
```ts
// result espone anche `allocation?: { refId, decided }` quando kind === 'Allocation' e la richiesta è conclusa
if (result.status === 200 && result.allocation) {
  const { refId, decided } = result.allocation; // decided: 'Approved' | 'Rejected'
  const assig = await repos.assignments.get(refId);
  if (assig) {
    const newStatus = decisionToAssignmentStatus(decided);
    await repos.assignments.update(assig.id, { status: newStatus });
    await withLock(`res:${assig.resourceId}`, () => recomputeResourceUtilization(assig.resourceId));
    await withLock(`req:${assig.requestId}`, () => recomputeRequestStaffing(assig.requestId));
    // Audit dell'effetto collaterale (l'audit middleware traccia /approval-requests, non l'assignment):
    await repos.auditLogs.create(allocationTransitionAudit(req, assig, newStatus));
  }
}
```
Estendere il tipo di ritorno del `withLock` per includere `allocation?: { refId: string; decided: 'Approved'|'Rejected' }`. Dentro il callback, nel `return` del ramo di successo, popolarlo così (allocazione single-step ⇒ un Approved conclude subito la catena, quindi `ar.status` è già `'Approved'`/`'Rejected'`):
```ts
return {
  status: 200,
  body: updated ?? ar,
  allocation: ar.kind === 'Allocation' && (ar.status === 'Approved' || ar.status === 'Rejected')
    ? { refId: ar.refId, decided: ar.status as 'Approved' | 'Rejected' }
    : undefined,
};
```
`allocationTransitionAudit` costruisce un `AuditEntry` (vedi la forma usata dall'audit middleware) attribuito a `actorId(req)`/`actorRole(req)` con `method:'PUT'`, `path:'/assignments/'+assig.id`, before/after dello status.

- [ ] **Step 3: Test unit del mapping** — già coperto da Task 3 (`decisionToAssignmentStatus`). Aggiungere in `staffing.util.spec.ts` un test che, data una lista di assignment con un `Requested` appena portato ad `Allocated`, `assignmentAggregateHours` sposta le ore da planned-only a confirmed. (Verifica la semantica dell'hook senza HTTP.)

- [ ] **Step 4: Verifica** — Run: `npx ng build` + `npm test` → OK.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/app/services/staffing.util.spec.ts
git commit -m "feat(alloc): decision enforcement via approverId + post-decision assignment hook + audit"
```

---

## Task 6: Aggancio lifecycle su POST/PUT/DELETE assignments

**Files:**
- Modify: `src/server.ts:1248-1363`

- [ ] **Step 1: `POST /assignments` — stato e proposta**

Dopo la validazione FK esistente e prima/dopo la create:
- Validare lo status in ingresso: se presente, deve essere in `ALLOCATION_CLIENT_SETTABLE` (`Draft`/`Requested`); default `Draft`. Altrimenti 400.
- Risolvere la risorsa e il suo `managerId`; `const proposerResourceId = await actorResourceId(req);`.
- Se lo status richiesto è `Requested`:
  - se `resource.managerId && resource.managerId === proposerResourceId` → **auto-approvazione**: create con `status:'Allocated'`, nessun approvalRequest.
  - altrimenti: create con `status:'Requested'`, poi creare l'`approvalRequest` (`kind:'Allocation'`, `refId:<assignmentId>`, `projectId:` dal request, `requestedBy: actorId(req)`, `steps:[allocationApproverStep(resource.managerId)]`, `currentStep:0`, `status:'Pending'`, `createdAt`, `slaDueAt`), e poi `assignments.update(id, { approvalId: created.id })`.
- Se lo status è `Draft`: create semplice.
- In tutti i casi ricalcolare: `await withLock('res:...', recomputeResourceUtilization)` e `await withLock('req:...', recomputeRequestStaffing)` (sostituisce la logica incrementale su `staffedEffort`).

- [ ] **Step 2: `PUT /assignments/:id` — transizioni e ri-approvazione**

- Se il body porta `status`, validarlo: consentito solo `Draft`/`Requested` come target esplicito; `isAllowedAllocationTransition(oldStatus, newStatus)` deve essere true, altrimenti 400. Rifiutare tentativi client di settare `Allocated`/`Rejected` (403/400).
- **Retrocessione automatica:** se `oldStatus === 'Allocated'` e cambia una tra `assignedHours`/`startDate`/`endDate`/`resourceId`/`allocationPct`, forzare `status='Requested'` e generare una nuova `approvalRequest` (come nel POST), aggiornando `approvalId`. La vecchia (Approved) resta nello storico.
- Se la transizione è `Rejected/Draft → Requested` esplicita, generare la nuova `approvalRequest` (o auto-approvare se proposer=manager).
- Sostituire tutta la logica incrementale su `staffedEffort` (`:1317-1342`) con `recomputeRequestStaffing` per la/e request affette (vecchia+nuova se `requestChanged`), e `recomputeResourceUtilization` per la/e risorsa/e affette.

- [ ] **Step 3: `DELETE /assignments/:id` — ritiro approvazione pendente**

Prima di rimuovere: se `oldAssig.approvalId` punta a un `approvalRequest` con `status:'Pending'`, marcarlo ritirato (`status:'Rejected'` con nota "assignment deleted", o rimuoverlo). Poi rimuovere l'assignment e ricalcolare con `recomputeRequestStaffing`/`recomputeResourceUtilization` (sostituisce il delta su `staffedEffort`).

- [ ] **Step 4: Smoke manuale del flusso**

```bash
npm run build && AUTH_TRUST_HEADERS=true PORT=3000 npm run serve:ssr:app &
sleep 3
# proposta come pm (X-User-Id=3 alice), decisione come manager/resource-manager
node scripts/smoke-api.mjs
```
Expected: gli step esistenti passano; verificare manualmente un POST assignment `Requested` → crea approval-request; decision Approved → assignment `Allocated`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(alloc): lifecycle hooks on assignment create/update/delete (propose, re-approve, withdraw)"
```

---

## Task 7: Migration + seed

**Files:**
- Modify: `src/db/schema.ts` (resources, requests, assignments)
- Create: `drizzle/0008_*.sql` + update `drizzle/meta/_journal.json` (via drizzle-kit)
- Modify: `src/db/seed.ts`

- [ ] **Step 1: Schema**

In `src/db/schema.ts`: aggiungere `approvalId: text('approval_id')` a `assignments`; `staffedEffortPlanned: doublePrecision('staffed_effort_planned')` a `requests`; `utilizationPlanned: doublePrecision('utilization_planned')` a `resources`. Tutte **nullable** (migration-safe).

- [ ] **Step 2: Generare la migration**

Run: `npx drizzle-kit generate`
Expected: nuovo `drizzle/0008_*.sql` con gli `ALTER TABLE ADD COLUMN`, journal aggiornato.

- [ ] **Step 3: Backfill nella stessa migration**

Appendere al file `0008_*.sql`:
```sql
UPDATE "assignments" SET "status" = 'Allocated' WHERE "status" IN ('hard-booked', 'soft-booked');
```
(Le allocazioni pre-esistenti sono considerate approvate. `utilization_planned`/`staffed_effort_planned` restano NULL e verranno ricalcolate al boot — vedi Step 5.)

- [ ] **Step 4: Seed**

In `src/db/seed.ts:127-132`: cambiare ogni `status: 'hard-booked'|'soft-booked'` in `status: 'Allocated'`. Aggiornare i request seed (`:107-111`) aggiungendo `staffedEffortPlanned` = `staffedEffort` (tutti gli assignment seed sono Allocated ⇒ confermato = pianificato). Aggiungere `utilizationPlanned` uguale a `utilization` sui resource seed.

- [ ] **Step 5: Ricalcolo al boot**

In `src/db/bootstrap.ts` (o accanto a `seedSequences()`): dopo il seeding, per ogni resource/request esistente invocare i recompute così i due aggregati sono coerenti anche su DB pre-esistenti. (In-memory: già coerente via seed.)

- [ ] **Step 6: Verifica** — Run: `npm test` (repository.spec) + `npx ng build`. Con Postgres: `docker compose up -d postgres` poi `DATABASE_URL=... npm run serve:ssr:app` e controllare che le migration passino.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/db/bootstrap.ts drizzle/
git commit -m "feat(alloc): schema + migration + seed for allocation status and planned aggregates"
```

---

## Task 8: Frontend

**Files:**
- Modify: `src/app/staffing/staffing.component.ts` (~:402-433)
- Modify: `src/app/resource-requests/resource-requests.component.ts` (~:330-343, :368)
- Modify: `src/app/approvals/approvals.ts` (~:27-45, :332)
- Modify: `src/app/resources/resources.component.ts` (form)

- [ ] **Step 1: Staffing — due azioni**

In `staffing.component.ts` sostituire l'"Assign" che crea `status:'hard-booked'` (`:415`) con due chiamate: "Salva in bozza" → `createAssignment({..., status:'Draft'})`; "Manda in approvazione" → `createAssignment({..., status:'Requested'})`. Mostrare lo stato risultante (badge). Rispettare il pattern `authReady`/signal esistente.

- [ ] **Step 2: Resource-requests — badge + doppia barra**

In `resource-requests.component.ts` mappare i badge stato: `Draft`(grigio)·`Requested`(ambra)·`Allocated`(verde)·`Rejected`(rosso), rimpiazzando gli orfani `proposed`/`confirmed` (`:368`). La barra di staffing (`:330-343`) mostra due valori: `staffedEffort` (pieno) e `staffedEffortPlanned` (tratteggiato). Usare i token `-text` per il testo accentato (WCAG AA).

- [ ] **Step 3: Approvals inbox — kind Allocation + canDecide**

In `approvals.ts`: aggiungere la label per `kind==='Allocation'` ("Allocazione: {risorsa} su {progetto}"). Estendere `canDecide`: oltre al match di ruolo, `true` se `step.approverId === auth.<resourceId>()` per lo step corrente. (Verificare in `auth.service.ts` il getter del resource-id dell'utente; se assente, usare `auth.userId()` coerentemente col mapping demo.) Passare la nota approvatore al `PUT decision` (`{ decision, note }`).

- [ ] **Step 4: Resources — campo manager**

In `resources.component.ts` aggiungere al form un dropdown `managerId` popolato dalle risorse **attive** (esclusa la risorsa in edit). Bind su `RESOURCE_FIELDS` server (già include `managerId`, `server.ts:684`). Etichetta "People Manager".

- [ ] **Step 5: Verifica** — Run: `npx ng build` + `npm run lint` → OK. Avviare `npx ng serve` e verificare a mano: proporre un'allocazione, vederla in `/approvals`, approvarla, vedere il badge diventare `Allocated`.

- [ ] **Step 6: Commit**

```bash
git add src/app/staffing src/app/resource-requests src/app/approvals src/app/resources
git commit -m "feat(alloc): UI for propose/approve allocation, status badges, manager field"
```

---

## Task 9: Smoke + docs

**Files:**
- Modify: `scripts/smoke-api.mjs`
- Modify: `docs/roles-and-permissions.md`

- [ ] **Step 1: Smoke del flusso allocazione**

In `scripts/smoke-api.mjs` aggiungere un caso: POST assignment `status:'Requested'` come un pm → attende `Allocated:false`; GET `/approval-requests` trova il nuovo `kind:'Allocation'`; PUT `/approval-requests/:id/decision {decision:'Approved'}` come admin/resource-manager → GET assignment mostra `status:'Allocated'` e la request mostra `staffedEffort` aggiornato.

- [ ] **Step 2: Aggiornare la reference RBAC**

In `docs/roles-and-permissions.md` (sezione Segregation of Duties + kind di approvazione) documentare: nuovo `kind='Allocation'`, routing per `managerId` (fallback `resource-manager`), auto-approvazione proponente=manager, e la nota approvatore su step.

- [ ] **Step 3: Verifica finale** — Run: `npm test` + `npx ng build` + `npm run lint` → tutti verdi. Poi lo smoke con server avviato (Task 6 Step 4).

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-api.mjs docs/roles-and-permissions.md
git commit -m "test(alloc): smoke coverage for allocation approval + RBAC docs"
```

---

## Rischi / promemoria
- **Doppia definizione `ApprovalStep`** (`api.service.ts:448` canonico usato dal jsonb di `schema.ts:41` + copia locale `server.ts:2381`): tenerle in sync (Task 1).
- **Identity model**: `approverId`/`managerId` in resource-id space, confronti via `actorResourceId(req)`; SoD in user-id space invariata.
- **Empty-patch parity / nullsToUndefined**: i nuovi campi nullable seguono i due shim di `repository.ts` (return-path); non applicare `nullsToUndefined` ai valori passati a `.set()`.
- **`requestStatusFor` usa il confermato**, non il pianificato (una request è `Fulfilled` solo con ore approvate).
