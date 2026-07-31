# Design — B1: Modello di allocazione time-phased (per-giorno)

- **Data:** 2026-07-17
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «B — Allocazione mensile time-phased + FTE» della gap analysis RPT (Lutech Resource Planning Tool) vs Delivery Control. B è **decomposto in 3 fasi**; questa spec copre **B1** (il fondamento).

---

## 1. Contesto e obiettivo

Oggi l'allocazione di una risorsa è modellata come un **assignment con finestra piatta**: `assignedHours` totale + `startDate/endDate` + `allocationPct` uniforme sulla capacità *settimanale* (`resources.capacity`), più lo `status`/`approvalId` del workflow di approvazione (gap A). Non è time-phased.

RPT modella l'allocazione **mese per mese con dettaglio giornaliero** (ore/giorno, capacità massima giornaliera, calendario di "mesi aperti", giorni lavorabili al netto di weekend/festività). B1 introduce questo modello.

**Decomposizione di B (concordata):**
- **B1 (questa spec):** modello dati per-giorno + aggregazione mensile, ore-contratto/giorno per risorsa, calendario (mesi aperti + festività + giorni lavorabili), conflict capacità/giorno, **UI calendario giornaliero completo**, migrazione, API.
- **B2 (fase futura):** FTE equivalente + semaforo mensile (target ore/mese) + integrazione dashboard (utilization/forecast mensile).
- **B3 (fase futura):** approvazione **per-mese** (rimodella l'integrazione con il gap A, che oggi approva per-assignment).

### Decisioni di requisito (approvate)
1. Granularità: **mensile + giornaliero**.
2. Capacità: **`contractHoursPerDay` per risorsa** (default dal `settings.hoursPerDay` globale), = anche capacità massima giornaliera. `resources.capacity` (ore/settimana) declassata a legacy.
3. Giorni lavorabili: **weekend + calendario festività globale** (una tabella aziendale, non per-paese).
4. UI: **calendario giornaliero completo** in B1.
5. Storage: **`assignmentDays`** — una riga per assignment-giorno (modello normalizzato).

### Fuori scope (di B1)
- FTE e semaforo mensile → **B2**.
- Approvazione per-mese → **B3** (in B1 l'approvazione resta **per-assignment**, gap A invariato).
- Festività per-paese/sede (deciso: solo globale).

---

## 2. Modello dati

### 2.1 Nuova tabella `assignmentDays`
`{ id, assignmentId → assignments (FK), date 'YYYY-MM-DD', hours }`. Indici su `assignmentId` e su `(assignmentId, date)`; un indice su `date` per le aggregazioni per-giorno cross-assignment. **Una riga per assignment-giorno con `hours > 0`** (i giorni a 0 non generano righe → l'"azzera" cancella le righe del mese).

### 2.2 `resources` (estensione)
- `contractHoursPerDay` (doublePrecision, **nullable**; fallback a `settings.hoursPerDay` quando assente) — ore-contratto/giorno e **capacità massima giornaliera**.
- `capacity` (ore/settimana) resta la colonna ma diventa **legacy**: l'aggregazione time-phased usa `contractHoursPerDay`.

### 2.3 `assignments` (transizione)
- `assignedHours` → **colonna derivata** = Σ `assignmentDays.hours` dell'assignment, ricalcolata a ogni mutazione dei giorni (stesso pattern di `utilization`). Mantenuta per compatibilità con `staffedEffort` e con gli aggregati confermato/pianificato del gap A.
- `startDate/endDate/allocationPct` → **legacy** (non più fonte dell'allocazione; derivabili dai giorni allocati). Colonne non rimosse (retro-compatibilità).
- `status`/`approvalId` (gap A) → **invariati**; l'approvazione resta per-assignment in B1.

### 2.4 Nuova tabella `holidays`
`{ id 'YYYY-MM-DD', name }` — calendario festività aziendale **globale**. La **chiave naturale (la data) È la colonna `id`** (stile `settings`, dove l'`id` è la chiave — non un adapter natural-key sintetico come `languages`/`fxRates`), così `crud()`/`Repository<T>` funzionano senza modifiche. Gestito da **admin/delivery-executive** (nuovo catalogo `/config`, coerente con gli altri cataloghi config).

### 2.5 Nuova tabella `planningPeriods`
`{ id 'YYYY-MM', status 'Open' | 'Closed' }` — i "mesi aperti"; la chiave naturale (il mese) È la colonna `id` (come sopra). Gestiti da **admin**. Le mutazioni di allocazione sono ammesse **solo su mesi aperti**.

---

## 3. Calendario di sistema (funzioni pure)

Nuovo `src/app/services/calendar.util.ts` (side-effect-free, testabile; date come stringhe ISO, nessun uso di `Date.now()`):
- `workingDaysInMonth(month: 'YYYY-MM', holidays: Set<string>): string[]` — le date lun–ven del mese meno le festività.
- `monthlyTargetHours(contractHoursPerDay, month, holidays): number` = `workingDaysInMonth(...).length × contractHoursPerDay`.
- `isWorkingDay(date, holidays): boolean`, `monthOf(date): 'YYYY-MM'`, iteratori di supporto.

---

## 4. Aggregazione e integrazione con il gap A

- **Aggregazioni di B1** (funzioni pure): somma ore **per-giorno per risorsa** (per il conflict capacità/giorno) e `monthlyTargetHours` (per i tasti 100%/50% e la colonna target del calendario). NB: il **rollup mensile risorsa→ore** (utilization mensile "vera") è rimandato a **B2** — B1 non ne ha bisogno (YAGNI).
- **Compatibilità gap A (nessuna rottura):** `assignedHours` resta come derivato → `assignmentAggregateHours`, `recomputeResourceUtilization`/`recomputeRequestStaffing` e gli aggregati confermato/pianificato **continuano invariati** (sommano `assignedHours` per stato). L'`utilization` scalare (0–100) resta per retro-compatibilità; l'**utilization mensile "vera"** (ore/mese vs target/mese) e il semaforo sono **B2**.
- **Conflict per-giorno (capacità massima giornaliera):** alla mutazione degli `assignmentDays`, si valida che Σ ore della risorsa in quel giorno — su **tutti** i suoi assignment — non superi `contractHoursPerDay` (400 se sfora). Naturale con `assignmentDays` (aggregazione `resourceId + date`). Affianca/sostituisce lo sweep settimanale di `schedule.util`.

---

## 5. API

- **Allocazione bulk per assignment+mese:** `PUT /assignments/:id/allocation` con `{ month, dailyHours: {day→ore} }` — rimpiazza i giorni di quel mese, valida **mese-aperto** + **capacità/giorno**, poi ricalcola `assignedHours` e gli aggregati (dentro `withLock` sulla risorsa/request, come il gap A).
  - **Ri-approvazione forzata (fissato):** se l'assignment è `Allocated`, **qualsiasi** modifica ai suoi giorni tramite questo endpoint lo retrocede a `Requested` e rigenera l'approvazione (gap A) — **anche una ridistribuzione a `assignedHours` totale invariato**, perché il manager ha approvato *quel* profilo giornaliero. **Non** ci si affida al delta di `assignedHours` (che può restare identico); il trigger è "l'allocazione giornaliera è cambiata".
  - I tasti calendario (100%/50%/azzera per mese) costruiscono questo payload lato client.
- **`GET`** per il calendario: ore/giorno di un assignment (o di una risorsa) su un intervallo di mesi, con target e capacità.
- **`planningPeriods`:** `GET` lista; `PUT /planning-periods/:month` (open/close) — **admin**.
- **`holidays`:** CRUD catalogo — **admin/delivery-executive** (come gli altri cataloghi config, via `crud()` + `roleGate`).
- **RBAC:** le mutazioni di allocazione restano gated come `/assignments` (`pm, resource-manager, delivery-executive, admin`); mese-aperto e capacità/giorno sono validazioni aggiuntive nel handler.

---

## 6. UI — calendario giornaliero

Vista **calendario per assignment** (modale/pannello agganciato al flusso staffing/assignment), fedele a RPT:
- Griglia **mesi × giorni** con **ore editabili per singolo giorno**; i **mesi chiusi** sono mostrati **read-only** (visibili ma bloccati), i mesi aperti editabili; weekend e festività marcati e non allocabili.
- **Tasti per mese:** *Allocazione 100%* (ogni giorno lavorabile = `contractHoursPerDay`), *50%*, *Azzera*; selettore dei mesi aperti.
- **Feedback per-giorno:** un giorno oltre la capacità massima giornaliera è evidenziato (rosso) e bloccato lato server. (Semaforo mensile + FTE → **B2**.)
- Pattern esistenti: standalone signal-first, `rxResource` su `auth.authReady()`, control flow nativo, design system `command-*` con token `-text` (WCAG AA), Material solo per le icone.

---

## 7. Migrazione

- Gli assignment esistenti (finestra piatta) → `assignmentDays` distribuendo `assignedHours` **uniformemente sui giorni lavorabili** della finestra (`startDate/endDate`, fallback alle date del request), preservando il totale. Funzione pura testabile. **Edge case:** se un assignment non ha né una propria finestra né quella del request risolvibile (caso che `schedule.util` salta), non genera righe `assignmentDays` (0 ore) e resta senza allocazione giornaliera finché non viene editato dal calendario. Il seed ha sempre finestre, quindi la demo è coperta.
- `seed.ts` genera `assignmentDays` coerenti coi suoi assignment; `contractHoursPerDay` default da `hoursPerDay`; `planningPeriods` con i mesi del periodo demo aperti; `holidays` con qualche festività di esempio.
- Migration Drizzle (`drizzle-kit generate`) per le tre nuove tabelle + colonna `contract_hours_per_day`; tutte additive/nullable, retro-compatibili. Il seed è single source of truth (in-memory + Pg).
- **Decisione — backfill Pg dei dati legacy (NON in B1):** su un DB Postgres **già popolato** prima di questa migration, gli assignment esistenti restano **senza `assignmentDays`** (0 righe) finché non vengono ri-editati dal calendario — coerente con l'edge case sopra e **self-healing** (la prima modifica dal calendario li popola). La distribuzione richiede logica di calendario (giorni lavorabili/festività) non esprimibile in SQL puro, quindi non c'è un backfill SQL nella migration. Un **nuovo** deploy Pg è invece pienamente coerente perché `bootstrap.ts` seed le tre tabelle da `seed.ts` (Task 3). Scelta coerente con l'analoga decisione del gap A (planned aggregates NULL su DB legacy). Da **disclosare nella PR**; se in futuro servisse un backfill per un prod legacy, sarà un task dedicato.

---

## 8. Testing

- **Funzioni pure** (`calendar.util`, aggregazione, conflict, distribuzione di migrazione): Vitest, come i `*.util.spec.ts` esistenti; nessuna dipendenza da orologio/fuso.
- **Handler:** gate mese-aperto, gate capacità/giorno, ricalcolo di `assignedHours` derivato → **smoke** (`scripts/smoke-api.mjs` esteso).
- **Parità in-memory/Pg** per `assignmentDays`/`holidays`/`planningPeriods` (repository pattern + `nullsToUndefined`).
- **UI:** `ng build`/`ng lint` + verifica manuale del calendario (editing giorno, tasti mese, giorno sovra-capacità bloccato, mese chiuso non editabile).

---

## 9. Rischi e questioni aperte

- **Volume righe `assignmentDays`:** un assignment lungo genera molte righe; per una demo/PSA i volumi sono gestibili e il modello normalizzato è ottimo per aggregazione/conflict. Gli indici su `(assignmentId, date)` e `date` coprono i pattern d'accesso.
- **Doppia fonte finestra/giorni durante la transizione:** `startDate/endDate/allocationPct` restano come legacy ma non sono più autorevoli; va evitato che codice residuo li usi come fonte dell'allocazione (lo `schedule.util` settimanale va rivisto o marcato legacy).
- **Confine B1/B2 sul feedback visivo:** B1 fornisce il feedback/vincolo **per-giorno** (capacità); il semaforo **mensile** (target) e l'FTE sono B2 — il calendario B1 non colora il rollup mensile.
- **Approvazione in B1:** resta per-assignment (gap A). La ri-approvazione forzata su modifica dei giorni di un `Allocated` è **fissata in §5**: qualsiasi edit dei giorni retrocede a `Requested` (non ci si affida al delta di `assignedHours`).
