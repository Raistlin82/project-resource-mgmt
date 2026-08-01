# B2 — Monthly FTE + Capacity Semaphore + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere una **vista di portfolio della capacità mensile** (pagina `/capacity`, sola lettura): per ogni **risorsa × mese** in un intervallo, ore allocate confermate/pianificate, **FTE base-standard**, e **banda semaforo** bilaterale, più i **totali domanda vs capacità** per mese. Tutto derivato dai dati esistenti (`assignmentDays` di B1), senza modifiche allo schema e senza nuove mutazioni.

**Architecture:** Un layer di calcolo **puro** (`capacity.util.ts`) aggrega `assignmentDays` per `(risorsa, mese)` (split confermato/pianificato via lo stesso criterio del gap A), normalizza sul **mese standard** (`monthlyTargetHours(settings.hoursPerDay, mese, holidays)` di B1) e classifica la banda semaforo. Un **endpoint server bespoke** `GET /capacity/monthly?from&to` chiama quel layer e restituisce un envelope `{months, rows, totals}`, protetto da `roleGate` sulla collection `capacity`. Il frontend è un `CapacityComponent` signal-first su rotta lazy protetta, con griglia risorsa×mese, KPI e riga totali.

**Tech Stack:** Express 5 (`src/server.ts`), Drizzle ORM + PostgreSQL / in-memory repo (`src/db`), Angular 21 signal-first (`src/app`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-b2-monthly-fte-capacity-design.md`

---

## Note trasversali (leggere PRIMA)

- **Branch:** già su `feature/b2-monthly-fte-capacity` (spec committata lì).
- **Tooling:** usare `./node_modules/.bin/ng` (NON `npx ng` — gate di sicurezza). Build: `./node_modules/.bin/ng build`. Test singolo file: `./node_modules/.bin/ng test app --include='**/<name>.spec.ts' --watch=false`. Tutti: `./node_modules/.bin/ng test app --watch=false`. Lint: `./node_modules/.bin/ng lint`. **Nessuna migration** (nessun cambio di schema).
- **Riuso B1 / gap A (NON duplicare):** `monthlyTargetHours(hoursPerDay, month, holidays)` e `monthOf(date)` sono in `src/app/services/calendar.util.ts`. Lo split confermato/pianificato riusa la semantica di `staffing.util`: **confermato = status `Allocated`**, **pianificato = `Requested` + `Allocated`**. `getHoursPerDay()` (server.ts, default 8) fornisce `settings.hoursPerDay`. Le `holidays` sono un catalogo con `id` = data ISO.
- **Sola lettura:** nessuna mutazione, nessun `withLock`, nessun impatto su gap A / B1. L'FTE è **calcolato, mai persistito**; **non** dipende dallo scalare `resource.utilization` (clampato 0–100).
- **Moduli puri SSR-safe:** `capacity.util.ts` NON usa `Date.now()`/`new Date()` argless (deterministico, come `calendar.util`). L'unica data "corrente" è il **fallback** del default-range, che vive **nell'handler server** (non nel modulo puro).
- **RBAC bespoke:** l'handler `GET /capacity/monthly` **deve** invocare `roleGate` sulla chiave collection `capacity` (i bespoke handler sono l'unico punto in cui il gating si può bypassare per errore). La prova è il test smoke 403 (Task 5).
- **Modelli consigliati (subagent-driven):** Task 1 → standard (logica di rollup non banale); Task 2 → cheap (tipi + 1 metodo); Task 3 → **opus** (confine di sicurezza + default-range); Task 4 → **opus** (component signal-first + WCAG); Task 5 → standard.
- **Gotcha smoke live (da B1):** la porta **3000 è occupata da grafana su IPv6**; avviare il server su una porta libera diversa (es. 4173). Su questo Mac `localhost` risolve a `::1` e il server Node binda `::1`: puntare `localhost`, **non** `127.0.0.1`. Avvio: `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs`; poi `SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs`.
- **Edge-case (dati incoerenti):** una riga `assignmentDays` datata in un mese in cui la risorsa è inattiva (es. dopo `terminationDate`) NON genera una cella e non conta nei totali di quel mese. Per dati ben formati (allocazioni entro il rapporto) non accade mai. Comportamento accettato.

---

## File Structure

**Creati:**
- `src/app/services/capacity.util.ts` — layer di calcolo puro (standard month, FTE, banda semaforo, rollup, range mesi).
- `src/app/services/capacity.util.spec.ts` — test del layer puro.
- `src/app/capacity/capacity.component.ts` — pagina dashboard `/capacity` (griglia risorsa×mese, KPI, totali).
- `src/app/capacity/capacity.component.spec.ts` — test component (render da stub + gating authReady).

**Modificati:**
- `src/app/services/api.service.ts` — tipi `CapacityCell`/`CapacityRow`/`CapacityTotals`/`CapacityMonthly` + metodo `getCapacityMonthly(from?, to?)`.
- `src/server.ts` — handler bespoke `GET /capacity/monthly` (validazione, default-range, predicato per-mese, `rollupMonthly`), `roleGate('capacity')`, `READ_RULES['capacity']`.
- `src/app/app.routes.ts` — rotta lazy `/capacity` con `capacityGuard`.
- `src/app/guards/role.guard.ts` — `capacityGuard` (ruoli staffing) se non già coperto da `roleGuard(...)`.
- (navigazione) il componente che rende il menu principale — nuova voce "Capacità".
- `scripts/smoke-api.mjs` — flusso `/capacity/monthly` (happy-path + validazione + RBAC 403).
- `docs/roles-and-permissions.md` — nuova collection sola-lettura `/capacity`.

---

## Task 1: `capacity.util.ts` — layer di calcolo puro (TDD)

**Files:** Create `src/app/services/capacity.util.ts`, Test `src/app/services/capacity.util.spec.ts`

- [ ] **Step 1: test che falliscono** in `capacity.util.spec.ts` (coprire: confine bande a 50/85/105, `fteOf` con denominatore 0, range mesi, rollup multi-assignment + part-time + festività + `capacityFte`):

```ts
import {
  standardMonthlyHours, fteOf, semaphoreBand, monthsInRange, isActiveInMonth, rollupMonthly,
} from './capacity.util';

const NO_HOL = new Set<string>();

describe('fteOf', () => {
  it('divides by standard hours', () => expect(fteOf(88, 176)).toBeCloseTo(0.5));
  it('guards zero denominator', () => expect(fteOf(10, 0)).toBe(0));
});

describe('semaphoreBand (lower-bound-inclusive: [0,50) idle, [50,85) under, [85,105] healthy, (105,∞) over)', () => {
  it('below 50 → idle', () => expect(semaphoreBand(49.9)).toBe('idle'));
  it('exactly 50 → under', () => expect(semaphoreBand(50)).toBe('under'));
  it('exactly 85 → healthy', () => expect(semaphoreBand(85)).toBe('healthy'));
  it('exactly 105 → healthy', () => expect(semaphoreBand(105)).toBe('healthy'));
  it('just over 105 → over', () => expect(semaphoreBand(105.0001)).toBe('over'));
});

describe('monthsInRange', () => {
  it('inclusive, ascending, crosses year', () => {
    expect(monthsInRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('single month', () => expect(monthsInRange('2026-05', '2026-05')).toEqual(['2026-05']));
});

describe('isActiveInMonth (hireDate ≤ monthStart AND (no term OR term ≥ monthStart))', () => {
  it('hired before, not terminated → active', () =>
    expect(isActiveInMonth({ hireDate: '2020-01-01' }, '2026-05')).toBe(true));
  it('hired after month start → inactive', () =>
    expect(isActiveInMonth({ hireDate: '2026-06-15' }, '2026-05')).toBe(false));
  it('terminated before month start → inactive', () =>
    expect(isActiveInMonth({ terminationDate: '2026-04-30' }, '2026-05')).toBe(false));
  it('terminated on/after month start → active', () =>
    expect(isActiveInMonth({ terminationDate: '2026-05-01' }, '2026-05')).toBe(true));
});

describe('rollupMonthly', () => {
  // May 2026: 21 working days (no holidays here) × 8h = 168h standard.
  const months = ['2026-05'];
  const hoursPerDay = 8;
  const resources = [
    { id: 'r1', name: 'Full', contractHoursPerDay: 8 },
    { id: 'r2', name: 'Part', contractHoursPerDay: 4 },
  ];
  const assignments = [
    { id: 'a1', resourceId: 'r1', status: 'Allocated' },
    { id: 'a2', resourceId: 'r1', status: 'Requested' },
    { id: 'a3', resourceId: 'r2', status: 'Allocated' },
  ];
  // r1: 100h Allocated + 40h Requested in May; r2: 84h Allocated (≈ full part-time month)
  const assignmentDays = [
    { assignmentId: 'a1', date: '2026-05-04', hours: 100 },
    { assignmentId: 'a2', date: '2026-05-05', hours: 40 },
    { assignmentId: 'a3', date: '2026-05-04', hours: 84 },
  ];

  const out = rollupMonthly({ resources, assignments, assignmentDays, months, hoursPerDay, holidays: NO_HOL });

  it('splits confirmed vs planned per resource/month', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    expect(r1.confirmedHours).toBe(100);
    expect(r1.plannedHours).toBe(140); // Allocated 100 + Requested 40
  });
  it('band uses planned FTE', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    // ftePlanned = 140/168 ≈ 0.833 → 83.3% → under
    expect(r1.band).toBe('under');
  });
  it('part-time capacity is 0.5 FTE', () => {
    // capacityFte(month) = Σ monthlyTargetHours(contract)/standard = 8/8·(168/168)=1.0 + 4h→ (84/168)=0.5
    expect(out.totals['2026-05'].capacityFte).toBeCloseTo(1.5);
    expect(out.totals['2026-05'].resourceCount).toBe(2);
  });
  it('idle active resource still appears with a 0% cell', () => {
    const out2 = rollupMonthly({ resources: [{ id: 'r9', name: 'Idle', contractHoursPerDay: 8 }],
      assignments: [], assignmentDays: [], months, hoursPerDay, holidays: NO_HOL });
    expect(out2.rows[0].monthly['2026-05'].band).toBe('idle');
  });
});
```

- [ ] **Step 2: eseguire i test → falliscono** (`Run: ./node_modules/.bin/ng test app --include='**/capacity.util.spec.ts' --watch=false` — Expected: FAIL, moduli non definiti). **NB:** verificare a mano che maggio 2026 abbia 21 giorni lavorativi (Ven 1 mag è festività in molti calendari ma NON è nella `holidays` di test → contato); se il conteggio reale differisse, aggiornare i numeri attesi con `workingDaysInMonth('2026-05', NO_HOL).length`, non forzare l'implementazione.

- [ ] **Step 3: implementazione minima** in `capacity.util.ts`:

```ts
import { monthOf, monthlyTargetHours } from './calendar.util';

export type SemaphoreBand = 'idle' | 'under' | 'healthy' | 'over';
export const SEMAPHORE_THRESHOLDS = { idle: 50, under: 85, healthy: 105 } as const;
const EPS = 1e-9;

export interface CapacityCell {
  confirmedHours: number; plannedHours: number; targetHours: number;
  fteConfirmed: number; ftePlanned: number; band: SemaphoreBand;
}
export interface CapacityRow { resourceId: string; resourceName: string; monthly: Record<string, CapacityCell>; }
export interface CapacityTotals { demandFteConfirmed: number; demandFtePlanned: number; capacityFte: number; resourceCount: number; }
export interface CapacityRollup { months: string[]; rows: CapacityRow[]; totals: Record<string, CapacityTotals>; }

interface RollupResource { id: string; name: string; contractHoursPerDay?: number; hireDate?: string; terminationDate?: string; }
interface RollupAssignment { id: string; resourceId: string; status: string; }
interface RollupDay { assignmentId: string; date: string; hours: number; }
export interface RollupInput {
  resources: RollupResource[]; assignments: RollupAssignment[]; assignmentDays: RollupDay[];
  months: string[]; hoursPerDay: number; holidays: ReadonlySet<string>;
}

const CONFIRMED = new Set(['Allocated']);
const PLANNED = new Set(['Requested', 'Allocated']);

export function standardMonthlyHours(month: string, hoursPerDay: number, holidays: ReadonlySet<string>): number {
  return monthlyTargetHours(hoursPerDay, month, holidays);
}
export function fteOf(hours: number, standardHours: number): number {
  return standardHours > 0 ? hours / standardHours : 0;
}
export function semaphoreBand(pct: number): SemaphoreBand {
  const { idle, under, healthy } = SEMAPHORE_THRESHOLDS;
  if (pct < idle) return 'idle';
  if (pct < under) return 'under';
  if (pct <= healthy + EPS) return 'healthy';
  return 'over';
}
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
export function isActiveInMonth(r: { hireDate?: string; terminationDate?: string }, month: string): boolean {
  const monthStart = `${month}-01`;
  if (r.hireDate && r.hireDate > monthStart) return false;
  if (r.terminationDate && r.terminationDate < monthStart) return false;
  return true;
}

export function rollupMonthly(input: RollupInput): CapacityRollup {
  const { resources, assignments, assignmentDays, months, hoursPerDay, holidays } = input;
  const asgById = new Map(assignments.map(a => [a.id, a]));
  const byResMonth = new Map<string, Map<string, { confirmed: number; planned: number }>>();
  for (const d of assignmentDays) {
    const a = asgById.get(d.assignmentId); if (!a) continue;
    const m = monthOf(d.date);
    let rm = byResMonth.get(a.resourceId); if (!rm) { rm = new Map(); byResMonth.set(a.resourceId, rm); }
    let c = rm.get(m); if (!c) { c = { confirmed: 0, planned: 0 }; rm.set(m, c); }
    if (PLANNED.has(a.status)) c.planned += d.hours;
    if (CONFIRMED.has(a.status)) c.confirmed += d.hours;
  }
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const totals: Record<string, CapacityTotals> = {};
  for (const m of months) totals[m] = { demandFteConfirmed: 0, demandFtePlanned: 0, capacityFte: 0, resourceCount: 0 };
  const rows: CapacityRow[] = [];
  for (const r of resources) {
    const monthly: Record<string, CapacityCell> = {}; let hasAny = false;
    for (const m of months) {
      if (!isActiveInMonth(r, m)) continue;
      const target = targetByMonth.get(m)!;
      const src = byResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      const fteConfirmed = fteOf(src.confirmed, target);
      const ftePlanned = fteOf(src.planned, target);
      monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
        fteConfirmed, ftePlanned, band: semaphoreBand(ftePlanned * 100) };
      const t = totals[m];
      t.demandFteConfirmed += fteConfirmed;
      t.demandFtePlanned += ftePlanned;
      t.capacityFte += fteOf(monthlyTargetHours(r.contractHoursPerDay ?? hoursPerDay, m, holidays), target);
      t.resourceCount += 1;
      hasAny = true;
    }
    if (hasAny) rows.push({ resourceId: r.id, resourceName: r.name, monthly });
  }
  return { months, rows, totals };
}
```

- [ ] **Step 4: eseguire i test → passano** (stesso comando dello Step 2 — Expected: PASS).
- [ ] **Step 5: commit**

```bash
git add src/app/services/capacity.util.ts src/app/services/capacity.util.spec.ts
git commit -m "feat(b2): pure capacity rollup util (monthly FTE, bilateral semaphore, active-in-month)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Tipi API + `getCapacityMonthly` (TDD-light)

**Files:** Modify `src/app/services/api.service.ts`

- [ ] **Step 1:** aggiungere i tipi dell'envelope (riusare i tipi esportati da `capacity.util` dove possibile, ri-esportandoli o importandoli, per evitare drift):

```ts
import type { CapacityCell, CapacityRow, CapacityTotals } from './capacity.util';
export type { CapacityCell, CapacityRow, CapacityTotals };
export interface CapacityMonthly {
  months: string[];
  rows: CapacityRow[];
  totals: Record<string, CapacityTotals>;
}
```

- [ ] **Step 2:** aggiungere il metodo (seguire lo stile degli altri metodi `get*` del service — stessa gestione base-url/headers/observable già usata, es. `getAssignmentAllocation`):

```ts
getCapacityMonthly(from?: string, to?: string): Observable<CapacityMonthly> {
  let params = new HttpParams();
  if (from) params = params.set('from', from);
  if (to) params = params.set('to', to);
  return this.http.get<CapacityMonthly>(`${this.base}/capacity/monthly`, { params });
}
```
(Adeguare `this.base`/nome dell'`HttpClient` a quelli reali del file.)

- [ ] **Step 3:** build + lint verdi.

```bash
./node_modules/.bin/ng build && ./node_modules/.bin/ng lint
```

- [ ] **Step 4: commit**

```bash
git add src/app/services/api.service.ts
git commit -m "feat(b2): api.service getCapacityMonthly + capacity envelope types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Endpoint `GET /capacity/monthly` + RBAC (server)

**Files:** Modify `src/server.ts`, `docs/roles-and-permissions.md`

- [ ] **Step 1: leggere il contesto** in `src/server.ts`: come un GET bespoke esistente applica `roleGate` e come è strutturata la tabella `READ_RULES` (es. la regola di `/resources`/`/assignments`), il pattern del GET computato `GET /assignments/:id/allocation`, `getHoursPerDay()`, e come si ottiene il set `holidays` (i cui `id` sono date ISO). Replicare quei pattern; non inventarne di nuovi.

- [ ] **Step 2: RBAC** — aggiungere a `READ_RULES` la chiave `capacity` con i ruoli staffing `['pm','resource-manager','delivery-executive','finance','admin']`, e registrare l'handler in modo che `roleGate` giri sulla chiave collection `capacity` (come per le altre collection). Aggiornare `docs/roles-and-permissions.md` (nuova collection sola-lettura `/capacity`, chi la vede).

- [ ] **Step 3: handler** `GET /capacity/monthly` (async, bespoke). Logica:
  - `from`/`to` da query. Validazione: se presenti, regex `/^\d{4}-(0[1-9]|1[0-2])$/`, `from ≤ to` (confronto stringa), span ≤ 24 mesi → altrimenti `400 {error}`.
  - **Default-range** (se `from`/`to` assenti): `from` = primo `planningPeriods` con `status === 'Open'` in ordine crescente di `id`; se nessuno, mese corrente `new Date().toISOString().slice(0,7)` (questa è l'unica data "corrente", vive qui non nel modulo puro). `to` = `from` + 5 mesi (usare `monthsInRange` + slicing, o calcolo diretto).
  - Caricare (via repo, già `nullsToUndefined`-normalizzati): `assignments`, `assignmentDays`, `resources`, `holidays` (→ `new Set(holidays.map(h => h.id))`), `hoursPerDay = await getHoursPerDay()`.
  - `months = monthsInRange(from, to)`.
  - `const rollup = rollupMonthly({ resources, assignments, assignmentDays, months, hoursPerDay, holidays: holSet })` (mappare i campi risorsa: `id`, `name`, `contractHoursPerDay`, `hireDate`, `terminationDate`).
  - `res.json(rollup)` (envelope `{months, rows, totals}`).
  - **Import:** `rollupMonthly`/`monthsInRange` da `./app/services/capacity.util` (verificare il path relativo reale usato dal server per gli util condivisi, es. come importa `staffing.util`/`calendar.util`).

- [ ] **Step 4: verifica manuale rapida** — build, avviare il server sulla porta 4173 (vedi gotcha nelle note), `curl` con header admin:

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
# attendere il "listening", poi:
curl -s -H "X-User-Id: 1" -H "X-User-Role: admin" "http://localhost:4173/api/capacity/monthly?from=2026-05&to=2026-07" | head -c 400
# e la prova RBAC:
curl -s -o /dev/null -w "%{http_code}\n" -H "X-User-Id: 9" -H "X-User-Role: employee" "http://localhost:4173/api/capacity/monthly"
# atteso 403. Poi fermare il server.
```

- [ ] **Step 5: commit**

```bash
git add src/server.ts docs/roles-and-permissions.md
git commit -m "feat(b2): GET /capacity/monthly rollup endpoint + capacity READ_RULE

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — rotta `/capacity`, guard, `CapacityComponent` (TDD)

**Files:** Create `src/app/capacity/capacity.component.ts` (+ `.spec.ts`); Modify `src/app/app.routes.ts`, `src/app/guards/role.guard.ts`, il componente di navigazione.

- [ ] **Step 1: guard + rotta** — aggiungere `capacityGuard` (ruoli staffing `['pm','resource-manager','delivery-executive','finance','admin']`) riusando `roleGuard(...)` esistente se già parametrico (vedi `commercialGuard`/`financeGuard`). Registrare in `app.routes.ts` una rotta lazy `loadComponent` `/capacity` con `canMatch: [capacityGuard]`. Aggiungere la voce di menu "Capacità" nel componente di navigazione (allo stesso posto delle altre voci principali, con l'icona Material coerente, es. `insights`/`calendar_view_month`).

- [ ] **Step 2: test component che fallisce** (`capacity.component.spec.ts`): stub di `ApiService.getCapacityMonthly` che ritorna un envelope noto (2 risorse × 2 mesi con bande diverse); montare il component con `auth.authReady()` = `true`; assert che la griglia rende una cella con la classe/label di banda attesa (es. `over`) e la percentuale; e che con `authReady()` = `false` non parte la fetch (rimane empty-state). Seguire il pattern di test di `reporting`/allocation-calendar per lo stub di `ApiService` e `AuthService`.

- [ ] **Step 3: implementazione** `CapacityComponent` (standalone, `OnPush`, signal-first):
  - `rxResource` **keyed su `auth.authReady()` + segnale `range` (from/to)**; default vuoto (`{months:[],rows:[],totals:{}}`) finché `authReady()` è `false`. Chiama `api.getCapacityMonthly(range.from, range.to)`.
  - Selettore intervallo (from/to) come segnali; default: lasciare che il server scelga (chiamare senza `from/to` al primo load) e popolare i selettori dai `months` ricevuti.
  - **Striscia KPI** sul primo mese dell'intervallo: `demandFtePlanned`, `capacityFte`, # risorse in banda `over`.
  - **Griglia** risorsa×mese: `@for` su `rows`, `@for` su `months`; ogni cella mostra `ftePlanned` in % (`| percent` o formattazione custom) + classe di banda; marcatore più sottile del confermato (es. barra interna o seconda riga). **WCAG:** la banda è veicolata da **testo/label + colore** (non solo colore) e `aria-label` con il dettaglio ore (`plannedHours`/`targetHours`). Usare i token `command-*` + `bg-*-tint`/`text-*-text`.
  - **Riga totali** per mese: domanda (conf./pian.) vs `capacityFte`.
  - Stati: `accessNotice` su 401/403 (come `reporting`), `dataError` con retry, empty-state.
  - **Export** CSV/JSON via `export.util` (SSR-safe).
  - Mappa banda→tono: `idle`→neutro, `under`→caution, `healthy`→positive, `over`→critical (usare i `-text` per il testo su tint).

- [ ] **Step 4: test → passano; build + lint verdi.**

```bash
./node_modules/.bin/ng test app --include='**/capacity.component.spec.ts' --watch=false
./node_modules/.bin/ng build && ./node_modules/.bin/ng lint
```

- [ ] **Step 5: commit**

```bash
git add src/app/capacity src/app/app.routes.ts src/app/guards/role.guard.ts src/app/<nav-component>
git commit -m "feat(b2): /capacity dashboard — resource×month grid, semaphore bands, KPIs, totals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Smoke coverage `/capacity/monthly`

**Files:** Modify `scripts/smoke-api.mjs`

- [ ] **Step 1:** aggiungere una funzione `checkCapacityMonthly()` (stile delle altre check del file, dependency-free):
  - `GET /api/capacity/monthly?from=<mese seed>&to=<mese seed+2>` con header **admin** → 200; asserire che `months` contenga i mesi richiesti, che esista almeno una `row` con `resourceId` noto del seed, e che una **cella nota** abbia `band` ∈ {idle,under,healthy,over} coerente col numero (`ftePlanned` e `band` concordi secondo le soglie). Scegliere un mese/risorsa deterministici dal seed (es. lo stesso assignment/risorsa usato dallo smoke di B1).
  - **Validazione:** `?from=2026-13` (o `from>to`) → **400**.
  - **RBAC:** stesso GET con header ruolo non-staffing (es. `X-User-Role: employee`) → **403**.
  - **Default-range:** GET senza `from/to` con admin → 200 e `months.length >= 1`.
  - Registrare la nuova check nel runner dello script insieme alle altre.

- [ ] **Step 2: gate offline** — build, unit test, lint verdi.

```bash
./node_modules/.bin/ng build && ./node_modules/.bin/ng test app --watch=false && ./node_modules/.bin/ng lint
```

- [ ] **Step 3: smoke live** (vedi gotcha porta/`localhost`):

```bash
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
# attendere il 200 su http://localhost:4173/api/resources (header admin), poi:
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
# tutte le check devono passare. Fermare il server.
```

- [ ] **Step 4: commit**

```bash
git add scripts/smoke-api.mjs
git commit -m "test(b2): smoke coverage for /capacity/monthly (happy path, validation 400, RBAC 403, default range)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Definition of Done (intera feature B2)

- [ ] `capacity.util` puro e testato (bande ai confini, part-time, festività, `capacityFte`, range mesi, active-in-month).
- [ ] `GET /capacity/monthly` funzionante su entrambi gli adapter (in-memory ora; parità Pg garantita dai repo esistenti), RBAC 403 per ruoli non-staffing.
- [ ] Pagina `/capacity` signal-first, `authReady`-gated, WCAG (banda testo+colore), export, guard UX.
- [ ] Smoke live verde (happy-path + validazione + RBAC + default-range) e unit test tutti verdi, lint pulito.
- [ ] `docs/roles-and-permissions.md` aggiornato.
- [ ] Nessuna modifica allo schema, nessuna mutazione, gap A / B1 intatti.
- [ ] Review finale del branch → `superpowers:finishing-a-development-branch`.
