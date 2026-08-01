# Design — B2: FTE mensile + semaforo di capacità + dashboard

- **Data:** 2026-08-01
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «B — Allocazione mensile time-phased + FTE» della gap analysis RPT (Lutech Resource Planning Tool) vs Delivery Control. B è **decomposto in 3 fasi**; questa spec copre **B2** e poggia interamente sul modello per-giorno introdotto da **B1** (già completato e mergiato).

---

## 1. Contesto e obiettivo

B1 ha introdotto il modello di allocazione **per-giorno** (`assignmentDays`), il calendario dei giorni lavorabili (weekend + `holidays` globali), la capacità giornaliera per risorsa (`contractHoursPerDay`) e i `planningPeriods` (mesi aperti/chiusi). Oggi però **non esiste alcuna vista di portfolio** che mostri il carico mensile aggregato: l'unica aggregazione mensile è nell'editor di allocazione di un singolo assignment.

RPT offre una **vista di capacità mensile** cross-risorsa con FTE equivalente e semaforo (verde/giallo/rosso) sul carico. B2 introduce questa vista.

**Obiettivo B2:** una **pagina dedicata `/capacity`**, sola lettura, che per ogni **risorsa × mese** in un intervallo mostri le ore allocate (confermate e pianificate), l'**FTE base-standard**, e una **banda semaforo**; più **totali di portfolio** (domanda vs capacità FTE per mese).

### Decisioni di requisito (approvate)
1. **Base FTE = standard comune.** 1.0 FTE = un "mese standard" uguale per tutte le risorse. Un part-time (es. Alice 4h/g) allocata al massimo del suo contratto risulta **< 1.0 FTE** (≈ 0.5): scala di confronto headcount comune. *(Implicazione esplicitamente accettata dall'utente.)*
2. **Mese standard = giorni lavorativi × `settings.hoursPerDay` (festività-aware).** Cioè `monthlyTargetHours(settings.hoursPerDay, mese, holidays)` di B1. Varia per mese; niente valore fisso.
3. **Doppio aggregato confermato + pianificato.** Ogni cella espone sia il confermato (assignment `Allocated`) sia il pianificato (`Requested` + `Allocated`), stesso split di gap A (`staffing.util`). Il **semaforo si basa sul pianificato** (vista forward-looking del carico).
4. **Collocazione: pagina dedicata `/capacity`** (nuova voce di menu), sola lettura.
5. **Semaforo bilaterale (idle + over)** sull'FTE% pianificato, base standard. Bande **lower-bound-inclusive**, senza sovrapposizioni ai confini: `[0,50)` **idle** · `[50,85)` **sotto** · `[85,105]` **sano** · `(105,∞)` **over** (quindi esattamente 50→sotto, 85→sano, 105→sano). Soglie **configurabili come costante di codice** `SEMAPHORE_THRESHOLDS` (tarabili senza settings a runtime; non è richiesta configurabilità utente).
6. **Calcolo su endpoint server dedicato** `GET /capacity/monthly` (aggregazione server-side, RBAC-gated, testabile), non lato client.

### Fuori scope (follow-up)
- Striscia contestuale di carico mensile nella gestione risorse / accanto al calendario B1 (era il layout "C").
- Drill-down dalla cella agli assignment / al calendario di allocazione.
- Editing o ribilanciamento dalla dashboard (B2 è **sola lettura**).
- Raggruppamenti/filtri per progetto o per manager oltre al selettore di intervallo mesi.
- Materializzazione/persistenza dell'FTE o utilization mensile (non serve: è **calcolata**).
- Approvazione per-mese → resta **B3**.

---

## 2. Modello dati — nessuna modifica allo schema

B2 **non aggiunge tabelle né colonne**. Tutto deriva da dati esistenti:
- **`assignmentDays`** `{assignmentId, date, hours}` — sorgente delle ore allocate.
- **`assignments`** `{resourceId, status}` — per collegare le righe-giorno a una risorsa e allo split confermato/pianificato.
- **`resources`** `{contractHoursPerDay, hireDate, terminationDate}` — per la capacità (supply) e il filtro **risorse attive nel mese** (predicato per-mese definito in §4).
- **`holidays`** + **`settings.hoursPerDay`** — denominatore del mese standard.

**FTE e bande sono calcolate, non memorizzate.** Coerente con la filosofia esistente ("utilization è derivata a ogni scrittura") e **aggira il problema del `clampUtil` che satura a 100**: il ricalcolo fresco può rappresentare l'over-allocazione (> 100%) senza perdita.

---

## 3. Layer di calcolo puro — `src/app/services/capacity.util.ts`

Funzioni **pure, SSR-safe, deterministiche (UTC)**, unit-testate, riusate sia dall'endpoint che (per i tipi) dal frontend:

- `standardMonthlyHours(month, hoursPerDay, holidays)` → ore del mese standard; alias di `monthlyTargetHours(hoursPerDay, month, holidays)` di B1 (nessuna duplicazione: la richiama).
- `fteOf(hours, standardHours)` → `standardHours > 0 ? hours / standardHours : 0`.
- `SEMAPHORE_THRESHOLDS = { idle: 50, under: 85, healthy: 105 }` (costante di codice) e `semaphoreBand(pct)` → `'idle' | 'under' | 'healthy' | 'over'` con confini **lower-bound-inclusive**: `pct < 50 → idle`, `pct < 85 → under`, `pct <= 105 → healthy`, altrimenti `over` (tolleranza epsilon sui confronti). Così 50→`under`, 85→`healthy`, 105→`healthy`.
- `rollupMonthly({ assignments, assignmentDays, months, hoursPerDay, holidays, resources })` → per ogni `(resourceId, month)`: `{ confirmedHours, plannedHours, targetHours, fteConfirmed, ftePlanned, band }`, più i **totali per mese** `{ demandFteConfirmed, demandFtePlanned, capacityFte, resourceCount }`. È il **cuore testabile**.

**Semantica del rollup:**
- `plannedHours(r, m)` = Σ `hours` delle righe-giorno con `monthOf(date) === m`, sugli assignment di `r` con status ∈ {`Requested`, `Allocated`}. `confirmedHours` = idem con status = `Allocated`.
- `targetHours(m)` = `standardMonthlyHours(m, settings.hoursPerDay, holidays)` — **uguale per tutte le risorse** nel mese.
- `ftePlanned = fteOf(plannedHours, targetHours)`; `band = semaphoreBand(ftePlanned * 100)`.
- **Capacità (supply)** per risorsa/mese = `fteOf(monthlyTargetHours(r.contractHoursPerDay, m, holidays), targetHours(m))` (stesso guard zero-denominatore della domanda) → Julie (8h/g) = 1.0, Alice (4h/g) = 0.5. `capacityFte(m)` = Σ sulle **risorse attive nel mese** (predicato §4). Quando una risorsa è piena al suo contratto, `domanda == capacità` per quella risorsa (coerente).

---

## 4. Endpoint — `GET /capacity/monthly`

Handler **bespoke async** in `src/server.ts` (pattern dei GET computati già presenti, es. `/assignments/:id/allocation`).

- **Query:** `?from=YYYY-MM&to=YYYY-MM`. Default (assenti) → dal **primo `planningPeriod` con status `Open`** (in ordine crescente) per 6 mesi (`+5`); se non esiste alcun periodo `Open`, fallback al **mese corrente** `+5`.
- **Validazione:** `from`/`to` regex `^\d{4}-(0[1-9]|1[0-2])$`, `from ≤ to`, ampiezza massima ~24 mesi → altrimenti **400**.
- **Corpo:** carica (via repo, già normalizzati) `assignments` + `assignmentDays` + `holidays` + `settings.hoursPerDay` + `resources`, costruisce la lista mesi `[from..to]`, chiama `rollupMonthly`, e restituisce:
  ```
  { months: string[],
    rows: [ { resourceId, resourceName,
              monthly: { 'YYYY-MM': { confirmedHours, plannedHours, targetHours,
                                      fteConfirmed, ftePlanned, band } } } ],
    totals: { 'YYYY-MM': { demandFteConfirmed, demandFtePlanned, capacityFte, resourceCount } } }
  ```
- **Risorsa attiva nel mese `m` (predicato per-mese univoco):** `hireDate ≤ inizioMese(m) AND (terminationDate assente OR terminationDate ≥ inizioMese(m))`, valutato **per ciascun mese** dell'intervallo (una risorsa può entrare/uscire a metà range → compare/scompare dalle colonne e dai totali di conseguenza). `resourceCount(m)`, `capacityFte(m)` e la presenza di una riga in un dato mese seguono questo predicato. Le date-input `resources`/`assignmentDays` arrivano già normalizzate dal repo (`nullsToUndefined`); l'aggregato numerico calcolato non emette `null`.
- **RBAC:** l'handler bespoke invoca **`roleGate`** sulla chiave collection `capacity`, per cui la nuova `READ_RULE` `/capacity` = ruoli staffing `['pm','resource-manager','delivery-executive','finance','admin']` si applica davvero (i bespoke handler sono l'unico punto in cui il gating può essere bypassato per errore). Nessuna mutazione (endpoint sola lettura).

---

## 5. Frontend — rotta `/capacity` + `CapacityComponent`

- **Rotta** lazy `loadComponent`, protetta da `capacityGuard` (ruoli staffing, `CanMatch`, SSR-aware: consente sul server, ri-valuta nel browser dopo `authReady`). Nuova voce di menu "Capacità".
- **Componente** signal-first, `OnPush`. `rxResource` **keyed su `auth.authReady()`** + un segnale `range` (from/to); default vuoto finché `authReady` è `true`. Legge da `api.getCapacityMonthly(from, to)`.
- **UI:**
  - **Striscia KPI** (sul mese "focus"/primo dell'intervallo): domanda FTE pianificata, capacità FTE, # risorse in `over`.
  - **Selettore intervallo** mesi (from/to) con default sensato.
  - **Griglia risorsa × mese:** righe = risorse, colonne = mesi; ogni cella mostra `ftePlanned%` con colore di banda (schema bilaterale) e un marcatore più sottile del **confermato**. Tooltip/`aria` con il dettaglio ore.
  - **Riga totali:** domanda (confermata/pianificata) vs capacità FTE per mese.
  - Eventuale `command-donut-chart` per un gauge d'insieme (utilization media di portfolio).
- **Design system:** classi `command-*` + token tint e relativo `-text` (contrasto WCAG AA). **Il colore non è l'unico veicolo:** la banda è resa anche da **testo/`%` + label/icona** e da `aria`.
- **Export** CSV/JSON della griglia via `export.util` (SSR-safe, guardato contro formula-injection).

---

## 6. Error handling

- **Endpoint:** `from/to` non validi o intervallo troppo ampio → **400** con `{error}`; assenti → intervallo di default. Dati vuoti (nessuna risorsa/allocazione) → griglia vuota, **non** errore.
- **Frontend:** `accessNotice` su 401/403 (come `reporting`), `dataError` con retry, empty-state quando non ci sono righe. Nessun read principal-gated parte prima di `authReady` (evita il 401-che-latcha).

---

## 7. Testing

- **Util spec (`capacity.util.spec.ts`):** `standardMonthlyHours` (riuso B1), `fteOf` (denominatore 0/negativo → 0), `semaphoreBand` (**valori di confine** 50/85/105 + epsilon: a quale banda appartengono), `rollupMonthly` (multi-assignment stessa risorsa/mese; split confermato vs pianificato; caso part-time 4h/g; mese con festività; `capacityFte` = somma supply).
- **Smoke (`scripts/smoke-api.mjs`):** `GET /capacity/monthly` happy-path (asserisce `ftePlanned` + `band` di una **cella nota** dal seed); validazione `from/to` → **400**; **RBAC → 403** per un ruolo non-staffing (es. `employee`/`sales`); comportamento default-range.
- **Component spec:** render della griglia da uno stub `api`; gating su `authReady` (vuoto finché `false`).

---

## 8. RBAC & docs

- Aggiunta di `/capacity` a `READ_RULES` in `src/server.ts` (ruoli staffing) **e** invocazione esplicita di `roleGate` nell'handler bespoke (vedi §4). La rotta frontend è "ungated" a livello router ma protetta da guard per UX; **i dati sono protetti dall'endpoint** a prescindere.
- Aggiornamento di `docs/roles-and-permissions.md` (nuova collection di sola lettura `/capacity` e chi la vede), mantenendo il doc in sync col codice.

---

## 9. Note e invarianti da rispettare

- **Parità dev↔prod:** l'endpoint gira identico su in-memory e Postgres; i dati caricati dai repo sono già normalizzati (`nullsToUndefined`), l'aggregato numerico calcolato non emette `null`.
- **Riuso, non duplicazione:** `standardMonthlyHours` richiama `monthlyTargetHours` di B1; lo split confermato/pianificato riusa la semantica di `staffing.util` (`Allocated` = confermato; `Requested`+`Allocated` = pianificato).
- **Nessuna dipendenza dallo scalare `resource.utilization`** (clampato 0–100, capacità settimanale): B2 aggrega `assignmentDays` per mese, indipendente da quel campo.
- **Soglie semaforo configurabili:** i part-time in base standard cadono strutturalmente nella fascia bassa; le soglie sono costanti così si possono tarare senza toccare la logica.
- **Sola lettura:** nessuna nuova mutazione, nessun `withLock`, nessun impatto sul workflow di approvazione (gap A) né su B1.
