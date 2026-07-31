# B1 — Time-Phased Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rimpiazzare l'allocazione a finestra piatta con un modello **time-phased per-giorno** (`assignmentDays`), con capacità/ore-contratto per risorsa, un calendario aziendale (festività + mesi aperti), conflict per-giorno, un calendario UI giornaliero e la migrazione — mantenendo intatto il workflow di approvazione del gap A.

**Architecture:** Una nuova tabella normalizzata `assignmentDays {id, assignmentId, date, hours}` è la fonte dell'allocazione; `assignments.assignedHours` diventa la sua somma derivata, così gli aggregati confermato/pianificato del gap A restano invariati. Un endpoint bulk `PUT /assignments/:id/allocation` rimpiazza i giorni di un mese, validando mese-aperto (`planningPeriods`) e capacità/giorno (`resources.contractHoursPerDay`), poi ricalcola gli aggregati e forza la ri-approvazione se l'assignment era `Allocated`. Le regole di calendario sono funzioni pure in `calendar.util.ts`.

**Tech Stack:** Express 5 (`src/server.ts`), Drizzle ORM + PostgreSQL / in-memory repo (`src/db`), Angular 21 signal-first (`src/app`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-17-b1-time-phased-allocation-design.md`

---

## Note trasversali (leggere PRIMA)

- **Branch:** già su `feature/b1-time-phased-allocation` (la spec è committata lì).
- **Tooling:** usare `./node_modules/.bin/ng` (NON `npx ng`). Build: `./node_modules/.bin/ng build`. Test singolo file: `./node_modules/.bin/ng test app --include='**/<name>.spec.ts' --watch=false`. Tutti: `./node_modules/.bin/ng test app --watch=false`. Lint: `./node_modules/.bin/ng lint`. Migration: `./node_modules/.bin/drizzle-kit generate`.
- **Chiave naturale (id=chiave):** `holidays.id` = la data ISO, `planningPeriods.id` = il mese `YYYY-MM`. Il `crud()` generico (`server.ts:590`) NON va bene perché genera `id` con `newId()`; usare **handler bespoke stile `settings`** (`server.ts:1771-1774`) che prendono la chiave dal body/param. `holidays` è comunque un catalogo (add/remove); `planningPeriods` ha solo open/close.
- **Riuso gap A:** l'endpoint di allocazione riusa `recomputeResourceUtilization`/`recomputeRequestStaffing` (server.ts:1019/1046), `createAllocationApproval`/`withdrawAllocationApproval` (server.ts ~1068/1083), `autoApprovesAllocation` (server.ts ~1097), `withLock`. Non duplicare quella logica.
- **`assignedHours` derivato:** dopo ogni mutazione dei giorni di un assignment, `assignedHours = Σ assignmentDays.hours` di quell'assignment, poi si richiamano i recompute del gap A (che sommano `assignedHours` per stato). Così `assignmentAggregateHours` e gli aggregati confermato/pianificato NON cambiano.
- **Date come stringhe ISO 'YYYY-MM-DD'**, mai `Date.now()`/`new Date()` argless nei moduli puri (SSR-safe, come `schedule.util`/`calendar.util`).

---

## File Structure

**Creati:**
- `src/app/services/calendar.util.ts` — funzioni pure calendario (giorni lavorabili, target, iterazione, distribuzione migrazione).
- `src/app/services/calendar.util.spec.ts` — test.
- `src/app/allocation-calendar/allocation-calendar.component.ts` — UI calendario giornaliero per un assignment.
- `drizzle/0009_*.sql` (+ meta) — migration generata.

**Modificati:**
- `src/db/schema.ts` — tabelle `assignmentDays`, `holidays`, `planningPeriods`; colonna `resources.contract_hours_per_day`.
- `src/db/seed.ts` — `assignmentDays` derivati dagli assignment seed; `holidays`/`planningPeriods` seed; `contractHoursPerDay`.
- `src/db/repositories.ts` — costruzione dei nuovi repos (in-memory + Pg).
- `src/app/services/api.service.ts` — interfacce `AssignmentDay`, `Holiday`, `PlanningPeriod`; metodi API; `Resource.contractHoursPerDay`.
- `src/server.ts` — `assignmentDays` repo wiring + audit segment; endpoint `PUT /assignments/:id/allocation` + `GET` calendario; handler `holidays` + `planningPeriods`; regole `roleGate`; validazioni pure agganciate; marcatura legacy dello sweep settimanale.
- `src/app/services/schedule.util.ts` — commento "legacy: superseded by time-phased daily model" (nessun cambio funzionale in B1).
- `scripts/smoke-api.mjs` — flusso allocazione time-phased.
- `docs/roles-and-permissions.md` — RBAC di `holidays`/`planning-periods`/allocazione.

---

## Task 1: `calendar.util.ts` — funzioni pure (TDD)

**Files:** Create `src/app/services/calendar.util.ts`, Test `src/app/services/calendar.util.spec.ts`

- [ ] **Step 1: test che falliscono** in `calendar.util.spec.ts`:
```ts
import { monthOf, isWorkingDay, workingDaysInMonth, monthlyTargetHours, distributeHoursOverWindow } from './calendar.util';

describe('monthOf', () => {
  it('extracts YYYY-MM', () => expect(monthOf('2026-03-14')).toBe('2026-03'));
});

describe('isWorkingDay', () => {
  const hol = new Set(['2026-03-17']);
  it('weekday not holiday → true', () => expect(isWorkingDay('2026-03-16', hol)).toBe(true)); // Mon
  it('weekend → false', () => expect(isWorkingDay('2026-03-14', hol)).toBe(false)); // Sat
  it('holiday → false', () => expect(isWorkingDay('2026-03-17', hol)).toBe(false));
});

describe('workingDaysInMonth', () => {
  it('lists weekdays minus holidays, ascending', () => {
    const days = workingDaysInMonth('2026-03', new Set(['2026-03-17']));
    expect(days[0]).toBe('2026-03-02'); // Mar 1 2026 is Sun
    expect(days).not.toContain('2026-03-17');
    expect(days).not.toContain('2026-03-14'); // Sat
    expect(days.every(d => d.startsWith('2026-03'))).toBe(true);
  });
});

describe('monthlyTargetHours', () => {
  it('working days × contract hours/day', () => {
    const t = monthlyTargetHours(8, '2026-03', new Set(['2026-03-17']));
    expect(t).toBe(workingDaysInMonth('2026-03', new Set(['2026-03-17'])).length * 8);
  });
});

describe('distributeHoursOverWindow', () => {
  it('spreads total hours evenly across working days, preserving total', () => {
    const map = distributeHoursOverWindow(160, '2026-03-01', '2026-03-31', new Set());
    const sum = Object.values(map).reduce((a, b) => a + b, 0);
    expect(Math.round(sum)).toBe(160);
    expect(Object.keys(map).every(d => isWorkingDay(d, new Set()))).toBe(true);
  });
  it('no working days → empty map', () => {
    expect(distributeHoursOverWindow(40, '2026-03-14', '2026-03-15', new Set())).toEqual({}); // Sat+Sun
  });
});
```

- [ ] **Step 2: verificare FAIL** — `./node_modules/.bin/ng test app --include='**/calendar.util.spec.ts' --watch=false` → FAIL (moduli non definiti).

- [ ] **Step 3: implementazione** in `src/app/services/calendar.util.ts`:
```ts
/** Pure, SSR-safe calendar helpers for time-phased allocation. Dates are ISO
 *  'YYYY-MM-DD' strings; no Date.now()/argless new Date() (parity with schedule.util). */

/** 'YYYY-MM-DD' → 'YYYY-MM'. */
export function monthOf(date: string): string { return date.slice(0, 7); }

/** UTC day-of-week 0=Sun..6=Sat via Date.parse (deterministic). */
function dow(date: string): number { return new Date(date + 'T00:00:00Z').getUTCDay(); }

/** True iff `date` is a weekday and not in `holidays`. */
export function isWorkingDay(date: string, holidays: ReadonlySet<string>): boolean {
  const d = dow(date);
  return d !== 0 && d !== 6 && !holidays.has(date);
}

/** All working-day dates of `month` ('YYYY-MM'), ascending. */
export function workingDaysInMonth(month: string, holidays: ReadonlySet<string>): string[] {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
  const out: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${month}-${String(day).padStart(2, '0')}`;
    if (isWorkingDay(iso, holidays)) out.push(iso);
  }
  return out;
}

/** Target hours for a resource in a month = working days × contract hours/day. */
export function monthlyTargetHours(contractHoursPerDay: number, month: string, holidays: ReadonlySet<string>): number {
  return workingDaysInMonth(month, holidays).length * contractHoursPerDay;
}

/** Spread `total` hours evenly across the working days in [start,end] (inclusive),
 *  preserving the total (last day absorbs the rounding remainder). Empty if none. */
export function distributeHoursOverWindow(total: number, start: string, end: string, holidays: ReadonlySet<string>): Record<string, number> {
  const days: string[] = [];
  // Iterate calendar days start..end inclusive.
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isWorkingDay(iso, holidays)) days.push(iso);
  }
  if (days.length === 0 || !(total > 0)) return {};
  const per = Math.round((total / days.length) * 100) / 100;
  const map: Record<string, number> = {};
  let acc = 0;
  days.forEach((d, i) => {
    const h = i === days.length - 1 ? Math.round((total - acc) * 100) / 100 : per;
    map[d] = h; acc += h;
  });
  return map;
}
```

- [ ] **Step 4: verificare PASS** — stesso comando → PASS. Poi `./node_modules/.bin/ng build` + `./node_modules/.bin/ng lint`.

- [ ] **Step 5: commit** — `git add src/app/services/calendar.util.ts src/app/services/calendar.util.spec.ts && git commit -m "feat(b1): pure calendar helpers (working days, target, migration distribution)"` + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Task 2: Schema + tipi + migration

**Files:** Modify `src/db/schema.ts`, `src/app/services/api.service.ts`; Create `drizzle/0009_*.sql`

- [ ] **Step 1: schema** in `src/db/schema.ts`:
```ts
export const assignmentDays = pgTable('assignment_days', {
  id: text('id').primaryKey(),
  assignmentId: text('assignment_id').notNull().references(() => assignments.id),
  date: text('date').notNull(),                 // 'YYYY-MM-DD'
  hours: doublePrecision('hours').notNull(),
}, (t) => [
  index('assignment_days_assignment_id_idx').on(t.assignmentId),
  index('assignment_days_date_idx').on(t.date),
]);

export const holidays = pgTable('holidays', {    // id IS the ISO date (settings-style natural key)
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const planningPeriods = pgTable('planning_periods', { // id IS the 'YYYY-MM' month
  id: text('id').primaryKey(),
  status: text('status').notNull(),              // 'Open' | 'Closed'
});
```
Aggiungere a `resources`: `contractHoursPerDay: doublePrecision('contract_hours_per_day')` (nullable, accanto a `capacity`).

- [ ] **Step 2: tipi** in `src/app/services/api.service.ts`: `AssignmentDay {id; assignmentId; date; hours}`, `Holiday {id; name}`, `PlanningPeriod {id; status: 'Open'|'Closed'}`; aggiungere `contractHoursPerDay?: number` a `Resource`.

- [ ] **Step 3: generare la migration** — `./node_modules/.bin/drizzle-kit generate` → `drizzle/0009_*.sql` con le 3 CREATE TABLE + ALTER resources ADD COLUMN. Verificare l'SQL e il journal.

- [ ] **Step 4: verifica** — `./node_modules/.bin/ng build` (i nuovi tipi compilano) + `./node_modules/.bin/ng lint`.

- [ ] **Step 5: commit** — `git add src/db/schema.ts src/app/services/api.service.ts drizzle/ && git commit -m "feat(b1): schema + migration for assignmentDays, holidays, planningPeriods, contractHoursPerDay"` + trailer.

---

## Task 3: Repos wiring + seed

**Files:** Modify `src/db/repositories.ts`, `src/db/seed.ts`, `src/server.ts` (audit segment)

- [ ] **Step 1:** in `src/db/repositories.ts` costruire i repos `assignmentDays`, `holidays`, `planningPeriods` per entrambi gli adapter (in-memory + Pg), seguendo il pattern degli altri (es. `cities`/`industries`). Aggiungerli al tipo `Repositories`.
- [ ] **Step 2: seed** in `src/db/seed.ts`: (a) `holidays` con qualche festività demo (es. `{id:'2026-12-25', name:'Natale'}`); (b) `planningPeriods` aprendo i mesi del periodo demo (es. 2026-04..2026-12 `Open`); (c) `contractHoursPerDay` sui resource seed (es. 8, uno part-time a 4); (d) `assignmentDays` generati da ogni assignment seed via `distributeHoursOverWindow(assignedHours, startDate, endDate, holidaysSet)` — importare la pura da `calendar.util`. Ricalcolare `assignedHours` = Σ giorni per coerenza (dovrebbe restare uguale).
- [ ] **Step 3:** in `src/server.ts` registrare i nuovi repos in `repos` e nell'`auditRepoBySegment` (righe ~243-255). Nota: `assignmentDays` non ha un path REST proprio (è mutato solo via `/allocation`, auditato sotto il segmento `assignments`), quindi registrarlo è innocuo ma non load-bearing; per `holidays` e `planning-periods` assicurarsi che le **chiavi di segmento** (`holidays`, `planning-periods` con trattino) combacino esattamente con i path degli handler di Task 6.
- [ ] **Step 4: verifica** — `./node_modules/.bin/ng build` + `./node_modules/.bin/ng test app --watch=false` (le suite esistenti restano verdi) + lint.
- [ ] **Step 5: commit** — `git commit -m "feat(b1): repos wiring + seed for assignmentDays/holidays/planningPeriods"` + trailer.

---

## Task 4: Funzioni pure conflict + aggregazione per-giorno (TDD)

**Files:** Modify `src/app/services/calendar.util.ts` (o `staffing.util.ts`), Test relativo

- [ ] **Step 1: test che falliscono** — `sumHoursByDate(rows: {date; hours}[]): Record<string, number>` (mappa data→ore totali) e `exceedsDailyCapacity(total: number, cap: number): boolean`. Esempi: `sumHoursByDate([{date:'D',hours:4},{date:'D',hours:5}])['D'] === 9`; `exceedsDailyCapacity(9, 8) === true`; `exceedsDailyCapacity(8, 8) === false` (tolleranza epsilon). (La firma è **2-arg `(total, cap)`**, coerente con Step 3.)
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implementazione** — funzioni pure: `sumHoursByDate(rows: {date; hours}[]): Record<string, number>` e `exceedsDailyCapacity(total: number, cap: number): boolean { return total > cap + 1e-9; }`. Mantenere pure/testate.
- [ ] **Step 4: PASS** + build + lint.
- [ ] **Step 5: commit** — `git commit -m "feat(b1): pure daily-capacity conflict + per-day aggregation"` + trailer.

---

## Task 5: Endpoint allocazione bulk `PUT /assignments/:id/allocation`

**Files:** Modify `src/server.ts`

- [ ] **Step 1:** nuovo handler `apiRouter.put('/assignments/:id/allocation', ...)`:
  - 404 se l'assignment non esiste.
  - Body `pick({ month, dailyHours })`; validare `month` = 'YYYY-MM' e `dailyHours` = mappa `{'YYYY-MM-DD': number≥0}` i cui giorni appartengono a `month`.
  - **Mese aperto:** `planningPeriods.get(month)?.status === 'Open'`, altrimenti 403 "month is not open".
  - **Giorni lavorabili:** ogni giorno con ore>0 dev'essere `isWorkingDay(date, holidaysSet)`, altrimenti 400.
  - **Capacità/giorno:** per ogni giorno, `(ore già allocate della risorsa in quel giorno da ALTRI assignment) + ore nuove ≤ contractHoursPerDay` (fallback `getHoursPerDay()`), altrimenti 400. **Data path:** `assignmentDays` porta `assignmentId`, non `resourceId` — le "ore già allocate della risorsa nel giorno D" si ottengono raccogliendo gli `assignmentDays` di **tutti gli assignment della risorsa** (join `assignments` con `resourceId` → i loro giorni in D), escludendo l'assignment corrente (che viene rimpiazzato). Poi le pure di Task 4.
  - **Applica:** rimpiazzare gli `assignmentDays` dell'assignment per quel mese (cancella le righe di quel mese, inserisci le nuove con `hours>0`). Ricalcolare `assignedHours` = Σ tutti i giorni dell'assignment.
  - **Ordine di esecuzione (concorrenza + status PRIMA del recompute):**
    1. **Sotto `withLock('res:'+resourceId)`** (TOCTOU): check capacità/giorno + replace dei giorni del mese + write di `assignedHours`. Il lock evita che due allocazioni concorrenti su assignment diversi della stessa risorsa nello stesso giorno passino entrambe il check (disciplina aggregati condivisi, CLAUDE.md).
    2. **Ri-approvazione forzata** — **FUORI** da qualsiasi lock `res:`/`req:` (l'I/O sull'approval-repo non va mai dentro quei lock, disciplina gap A `server.ts:~1062-1065`): il trigger è **`oldStatus === 'Allocated'`** (via `/allocation` i giorni cambiano per definizione), **NON** il delta `MATERIAL_KEYS`/`assignedHours` del gap A (una ridistribuzione a totale invariato sfuggirebbe, spec §5). Se `oldStatus === 'Allocated'`: `autoApprovesAllocation(req, resourceId)` → resta `Allocated` (nessuna approval); altrimenti `withdrawAllocationApproval(old.approvalId, 'superseded')` + `createAllocationApproval` → nuovo `approvalId`, status `Requested`. Se `oldStatus === 'Requested'`: lasciare l'approval invariata (l'approvatore rilegge via `refId`). `Draft`/`Rejected`: nessun effetto. Scrivere lo `status`/`approvalId` finale dell'assignment. Riusare le **funzioni helper** del gap A, non il blocco `materialChange`.
    3. **Recompute come STEP FINALE** (dopo il cambio di stato, così gli aggregati confermato/pianificato riflettono il nuovo `status`): `withLock('res:'+resourceId, recomputeResourceUtilization)` poi `withLock('req:'+requestId, recomputeRequestStaffing)`.
  - Rispondere con l'assignment aggiornato + i suoi giorni del mese.
- [ ] **Step 2:** `GET /assignments/:id/allocation?from=YYYY-MM&to=YYYY-MM` → giorni dell'assignment nell'intervallo, con `target`/`contractHoursPerDay`.
- [ ] **Step 3: RBAC** — le mutazioni `/assignments` sono già gated (server.ts:489); il sub-path `/allocation` eredita. Verificare che la regola `startsWith('/assignments')` copra `/allocation`.
- [ ] **Step 4: verifica** — build + test + lint; smoke manuale rimandato a Task 9.
- [ ] **Step 5: commit** — `git commit -m "feat(b1): bulk per-month allocation endpoint with open-month + daily-capacity guards + forced re-approval"` + trailer.

---

## Task 6: Cataloghi `holidays` + `planningPeriods`

**Files:** Modify `src/server.ts`, `src/db/repositories.ts` (già fatto), `docs/roles-and-permissions.md`

- [ ] **Step 1: `holidays`** — handler bespoke (stile `settings`): `GET /holidays`; `PUT /holidays/:id` (id=data ISO, valida formato, upsert `{id, name}`); `DELETE /holidays/:id`. NON usare `crud()` (genererebbe `newId()`).
- [ ] **Step 2: `planningPeriods`** — `GET /planning-periods`; `PUT /planning-periods/:id` (id=mese 'YYYY-MM', body `{status:'Open'|'Closed'}`, upsert). Solo open/close.
- [ ] **Step 3: roleGate** — aggiungere `/holidays` alla regola cataloghi config (server.ts:508, `admin/delivery-executive`); aggiungere `/planning-periods` a una regola **admin-only** (nuova voce nelle `rules`). **Letture aperte:** NON aggiungere READ_RULES per `/holidays` né `/planning-periods` — una READ_RULE *restringe* la lettura, e il calendario di Task 8 (usato anche da `pm`/`resource-manager`) deve poterli leggere per marcare festività e mesi aperti/chiusi. Come gli altri cataloghi config: lettura aperta, mutazione gated.
- [ ] **Step 4: docs** — aggiornare `docs/roles-and-permissions.md`: mutazioni `/holidays` = admin/delivery-executive, `/planning-periods` = admin.
- [ ] **Step 5: verifica** — build + test + lint.
- [ ] **Step 6: commit** — `git commit -m "feat(b1): holidays + planningPeriods catalogs (bespoke, natural-key id) + RBAC"` + trailer.

---

## Task 7: Migrazione degli assignment esistenti (Pg backfill)

**Files:** Modify `drizzle/0009_*.sql` (o nuovo `0010_*.sql` di dati), `src/db/bootstrap.ts` (opzionale)

- [ ] **Step 1:** l'in-memory è già coerente via seed (Task 3). Per **Pg** esistente, gli `assignmentDays` vanno backfillati dagli assignment a finestra piatta. Poiché la distribuzione richiede logica (giorni lavorabili/festività) non esprimibile in SQL puro, il backfill è **best-effort e opzionale in B1**: documentare che un DB Pg pre-esistente parte con 0 `assignmentDays` finché gli assignment non vengono ri-editati dal calendario (self-healing, come il caso planned di A). Un nuovo deploy è coerente dal seed.
- [ ] **Step 2:** aggiungere una nota di decisione al piano/spec (coerente con la scelta analoga del gap A Task 7 Step 5).
- [ ] **Step 3: commit** (se ci sono modifiche) — `git commit -m "docs(b1): record Pg backfill decision for assignmentDays"` + trailer.

*(Task piccolo/decisionale — nessun test.)*

---

## Task 8: UI calendario giornaliero

**Files:** Create `src/app/allocation-calendar/allocation-calendar.component.ts`; Modify `src/app/app.routes.ts` (se serve una route) o il componente staffing che lo apre; `src/app/services/schedule.util.ts` (commento legacy)

- [ ] **Step 1:** componente standalone signal-first (`rxResource` su `auth.authReady()`, control flow nativo, `command-*`): dato un assignment, mostra la **griglia mesi × giorni** dei `planningPeriods`; mesi `Open` editabili, `Closed` read-only; weekend/festività marcati e non allocabili; input ore per giorno; tasti per mese *100%* (ogni giorno lavorabile = `contractHoursPerDay`), *50%*, *Azzera*; un giorno che supera la capacità giornaliera è evidenziato (rosso) — coerente col vincolo server. Salvataggio = `PUT /assignments/:id/allocation` per mese (Task 5).
- [ ] **Step 2:** agganciare l'apertura del calendario dal flusso staffing/assignment (bottone "Calendario" su una riga assignment).
- [ ] **Step 3:** marcare `schedule.util.ts` come legacy (commento in testa: superseded dal modello time-phased per-giorno; nessun cambio funzionale in B1).
- [ ] **Step 4: verifica** — `./node_modules/.bin/ng build` + `./node_modules/.bin/ng lint`; verifica manuale (`ng serve`): editing giorno, tasti mese, giorno sovra-capacità bloccato dal server, mese chiuso non editabile.
- [ ] **Step 5: commit** — `git commit -m "feat(b1): daily allocation calendar UI (open/closed months, day editing, capacity feedback)"` + trailer.

---

## Task 9: Smoke + docs

**Files:** Modify `scripts/smoke-api.mjs`, `docs/roles-and-permissions.md` (se non già in Task 6)

- [ ] **Step 1: smoke** — nuovo caso: `PUT /planning-periods/2026-05 {status:'Open'}` (admin); `PUT /assignments/:id/allocation {month:'2026-05', dailyHours:{...giorni lavorabili...}}` → 200, l'assignment ha `assignedHours` = somma; `GET /assignments/:id/allocation` mostra i giorni; caso negativo: allocazione su un mese `Closed` → 403; ore/giorno oltre `contractHoursPerDay` → 400.
- [ ] **Step 2: verifica finale** — `./node_modules/.bin/ng build` + `./node_modules/.bin/ng test app --watch=false` + lint; poi lo smoke live (server con `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=3000 node dist/app/server/server.mjs` — nota: passare l'env con `env`, non come prefisso inline, e attendere il "listening").
- [ ] **Step 3: commit** — `git commit -m "test(b1): smoke coverage for time-phased allocation + open-month/capacity guards"` + trailer.

---

## Rischi / promemoria
- **`assignedHours` derivato:** ogni mutazione dei giorni DEVE ricalcolarlo e richiamare i recompute del gap A, o gli aggregati confermato/pianificato divergono.
- **Ri-approvazione forzata:** il trigger è "i giorni sono cambiati" (anche a totale invariato), NON il delta di `assignedHours` (spec §5).
- **`crud()` vs id=chiave:** holidays/planningPeriods usano handler bespoke (id dal client/param), non `crud()`.
- **schedule.util settimanale:** resta ma è legacy; non usarlo come fonte dell'allocazione.
- **Pg backfill assignmentDays:** non fatto in B1 (self-healing + nuovo deploy coerente dal seed) — decisione da disclosare nella PR.
