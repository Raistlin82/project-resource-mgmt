# Design — B3: Approvazione dell'allocazione per-mese (multi-commessa)

- **Data:** 2026-08-02
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «B — Allocazione mensile time-phased + FTE» della gap analysis RPT (Resource Planning Tool) vs Delivery Control. B è decomposto in 3 fasi; questa spec copre **B3**, l'ultima.
- **Fonte funzionale:** `Manuale utente RPT (ITA) v4.pdf`, §3.3 (Dettaglio Calendario), §3.5 (Campo Note), §4.1–4.2 (People Manager, Gestione Allocazione Risorse).

---

## 1. Contesto e obiettivo

B1 ha introdotto l'allocazione time-phased (`assignmentDays`, calendario, mesi aperti, capacità/giorno); B2 il rollup mensile FTE con semaforo. Il **ciclo di approvazione**, però, è ancora quello del gap A: vive **sull'assignment**, non sul mese. Conseguenze:

- il PM manda in approvazione l'intero assignment, non un mese;
- modificare un solo mese di un assignment `Allocated` retrocede **tutto** l'assignment a `Requested` (`PUT /assignments/:id/allocation`, STEP 2), invalidando anche i mesi già approvati;
- l'approvatore non ha una vista risorsa×mese multi-commessa: decide una richiesta alla volta dall'inbox generica.

In RPT il ciclo è **mese per mese e multi-commessa**: il PM usa «Salva mese in Bozza» / «Invia mese in Approvazione» dal calendario; il People Manager apre una **modale-calendario multi-commessa**, seleziona il mese dai «Mesi aperti», spunta le commesse e preme **«Approva Mese»**, ripetendo per ciascun mese; con l'**allocazione multipla** decide più risorse in sequenza tramite **«Approva e Prosegui»**, che approva e avanza automaticamente al mese successivo. Le **note** sono bidirezionali per commessa-mese (pianificatore ↔ approvatore).

**Obiettivo:** spostare l'unità di approvazione da *assignment* a *assignment × mese*, riusando il motore `approvalRequests` già adottato in A, e fornire la UI di approvazione mensile del People Manager.

### Decisioni di requisito (approvate)

1. **Perimetro: fedeltà piena a RPT** — stato per-mese, modale-calendario multi-commessa, note bidirezionali, allocazione multipla con «Approva e Prosegui».
2. **Poteri dell'approvatore: superset di RPT** — può **approvare**, **rifiutare esplicitamente** (RPT non ha il rifiuto: azzera e approva) e **correggere le ore** prima di approvare.
3. **Aggregati confermato/pianificato ricalcolati per-mese** ovunque (utilization, staffedEffort, dashboard `/capacity`).
4. **UI su pagina dedicata `/allocation-approvals`**; grafici e riepilogo costi della dashboard People Manager restano fuori scope (blocco «dashboard per-ruolo»).
5. **Architettura: `assignmentMonths` + una `ApprovalRequest` per (assignment, mese)**, con riuso del motore esistente.

### Fuori scope

- Dashboard People Manager ricca (istogrammi, torta, riepilogo costi) ed export `.xlsx` multi-sheet.
- Risorse Dummy/Subco e sostituzione dummy (blocco C), a cui il manuale aggancia la stessa modale.
- Deleghe di ruolo e gerarchia organizzativa estesa.

---

## 2. Modello dati

### 2.1 Nuova tabella `assignmentMonths`

```
{ id: '<assignmentId>:<YYYY-MM>',
  assignmentId → assignments (FK),
  month: 'YYYY-MM',
  status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected',
  approvalId?: string,
  plannerNote?: string,
  approverNote?: string }
```

La **chiave naturale è la colonna `id`** (stile `holidays`/`planningPeriods` di B1, non un adapter natural-key sintetico), così `Repository<T>` funziona senza modifiche. Indici su `assignmentId` e su `month`. Id composito con `:` come `assignmentDays` — **mai** `newId()`, e la tabella è esclusa da `seedSequences()`.

Il tipo `AssignmentMonth` è dichiarato nel canonico `src/app/services/api.service.ts` e importato da `src/db/schema.ts`, come le altre entità.

Una riga esiste **anche con 0 ore nel mese**: azzerare un mese già approvato è a sua volta una proposta che il People Manager deve approvare. Il manuale è esplicito (§4.2): le richieste vanno approvate «indipendentemente dalla presenza o meno di ore pianificate». La riga viene creata alla **prima scrittura di allocazione** su quel mese.

### 2.2 `assignments` (transizione)

- `status` → **derivato** dalle righe mensili e ripersistito a ogni mutazione (stesso trattamento di `assignedHours` in B1). Precedenza: `Requested` > `Rejected` > `Allocated` > `Draft`; nessuna riga mensile ⇒ `Draft`. Mantiene funzionanti le viste esistenti (staffing, my-assignments, badge) senza riscritture.
- `approvalId` → **legacy**, non più scritta. L'approvazione corrente vive su `assignmentMonths.approvalId`.
- `assignedHours` → invariato (derivato = Σ giorni, da B1).

### 2.3 `approvalRequests` (invariata)

Nessun cambio di schema: `kind='Allocation'` (già esistente) e `refId` = **id della riga mensile** (`'<assignmentId>:<YYYY-MM>'`). Gli step, la SoD e l'SLA restano quelli di A.

---

## 3. Macchina a stati (per mese)

| Da | Evento | A |
|---|---|---|
| — | prima scrittura ore sul mese | `Draft` |
| `Draft` / `Rejected` | «Invia mese in approvazione» | `Requested` (+ `ApprovalRequest`) |
| *proponente = `managerId` della risorsa* | «Invia mese in approvazione» | `Allocated` diretto (auto-approvazione, come in A) |
| `Requested` | approvatore *Approva Mese* | `Allocated` |
| `Requested` | approvatore *Rifiuta mese* | `Rejected` (+ nota) |
| `Requested` | edit ore (PM o approvatore) | resta `Requested`; la richiesta pendente **non** viene rigenerata (l'approvatore rilegge le ore correnti) |
| `Allocated` | edit ore di **quel** mese | `Requested` + nuova `ApprovalRequest` (vecchia superata) |
| `Draft` / `Rejected` | edit ore | invariato |

Il guadagno rispetto a oggi: la **ri-approvazione forzata di B1 è localizzata al mese modificato**; i mesi già approvati restano `Allocated`.

---

## 4. Logica server

### 4.1 Endpoint

- **`PUT /assignments/:id/allocation`** (esistente, modificato). Gate invariati (mese aperto, giorno lavorabile, capacità/giorno) e ordine dei lock invariato. Cambia l'effetto di stato: upsert della riga mensile (`Draft` se assente) e ri-approvazione forzata **limitata al mese** (STEP 2 oggi agisce sull'assignment). In coda: `assignedHours` + `assignments.status` derivato.
- **`POST /assignments/:id/months/:month/submit`** `{ plannerNote? }` — «Invia mese in approvazione». `Draft|Rejected → Requested` con apertura della `ApprovalRequest` (`refId` = id riga mensile, `requestedBy` pinnato lato server), oppure `Allocated` diretto quando il proponente è il manager della risorsa. Richiede **mese aperto**. Un mese già `Requested` o `Allocated` → **400** (non idempotente: un doppio invio è un errore del client, non un no-op silenzioso); riga mensile o assignment inesistenti → 404.
- **`PUT /assignments/:id/months/:month/note`** `{ plannerNote }` — nota del pianificatore. La nota dell'**approvatore** arriva nel body della decisione e viene persistita sia sullo step (come in A) sia su `approverNote`, così il calendario la mostra senza risalire all'approval-request.
- **`POST /allocation-approvals/decide`** `{ items: [{ assignmentMonthId, decision: 'Approved'|'Rejected', note? }] }` — è «Approva Mese»: decide in una chiamata le N commesse spuntate e, in modalità multipla, le N risorse × commesse del mese. Risposta `200` con **esito per item** (`{ id, status, error? }`): una riga già decisa, priva di richiesta pendente (`approvalId` assente) o non autorizzata non fa fallire le altre. Il client segnala gli esiti parziali.
- **`GET /allocation-approvals?from&to&status=`** — feed della pagina e della modale: risorse × mesi × commesse con ore/giorno, target mensile, stato, note. `status` ∈ `Requested|Allocated|all`.

### 4.2 Refactor mirato (necessario, non opportunistico)

La logica di decisione vive oggi inline in `PUT /approval-requests/:id/decision` (~85 righe: SoD, step enforcement per-manager, avanzamento chain, hook post-decisione). Va **estratta in una funzione riusata dai due endpoint**, altrimenti il batch duplicherebbe le regole di sicurezza. L'endpoint singolo resta per gli altri `kind`.

L'**hook post-decisione** diventa consapevole del formato di `refId`:
- `refId` contenente `:` → riga mensile: applica `Approved → Allocated` / `Rejected → Rejected` sul mese, poi ricalcola stato derivato e aggregati;
- `refId` senza `:` → **formato legacy** (approvazioni Allocation aperte prima di B3): applica il vecchio comportamento sull'assignment. Nessuna richiesta in volo resta orfana.

### 4.3 Aggregati per-mese

Nuovo layer puro `src/app/services/allocation-month.util.ts` (SSR-safe, nessun orologio, come `calendar.util`/`capacity.util`): stato derivato dell'assignment dalle righe mensili, transizioni ammesse per mese, e la funzione che somma le ore dei giorni **pesandole con lo stato del mese in cui cadono** — confermato = mesi `Allocated`; pianificato = `Requested + Allocated`. La consumano:

- `recomputeResourceUtilization` → `resources.utilization` / `utilizationPlanned`;
- `recomputeRequestStaffing` → `requests.staffedEffort` / `staffedEffortPlanned`;
- `rollupMonthly` (B2, `capacity.util`) → oggi classifica con `assignment.status`, passerà allo stato della coppia (assignmentId, month). La dashboard `/capacity` diventa più fedele: un mese approvato e uno in attesa sulla stessa risorsa non collassano più sullo stesso stato.

Gli assignment **privi di righe-giorno** contribuiscono 0, in continuità con la decisione self-healing di B1 (§7 della spec B1) — vale solo per DB Postgres popolati prima di B1.

### 4.4 Concorrenza

Per item del batch: `withLock('approval:<id>')` come oggi; hook applicato **fuori** dal lock; recompute degli aggregati **deduplicato per risorsa/request a fine batch** (non per item), sotto l'ordine fisso `res:` → `req:` già in uso. Best-effort come in A/B1: la decisione e la transizione sono già committate, un fallimento del recompute non deve produrre un 500.

### 4.5 Mesi chiusi

`submit` richiede mese aperto. La **decisione è ammessa anche su mese chiuso**: una richiesta inviata prima della chiusura non deve restare appesa. L'edit delle ore resta bloccato dal gate mese-aperto esistente, quindi su un mese chiuso l'approvatore può solo approvare o rifiutare, non correggere.

### 4.6 RBAC e SoD

- `submit` e note del pianificatore: stessi ruoli delle mutazioni `/assignments` — `pm, resource-manager, delivery-executive, admin`.
- Il prefisso `/allocation-approvals` porta **due regole distinte** in `roleGate` (che è middleware globale): la `READ_RULES` predicate per il `GET` — `resource-manager, delivery-executive, admin` — e la regola di mutazione per il `POST .../decide`, allineata a quella di `/approval-requests` (`pm, resource-manager, delivery-executive, finance, admin`) perché è lo stesso motore. Il filtro fine resta allo **step enforcement** per-manager (`step.approverId` = `managerId` in resource-id space): con step `role: 'resource-manager'`, un `pm` non supera comunque la decisione se non è il manager della risorsa.
- **SoD invariata** (`requester ≠ decider`), ereditata dalla funzione estratta in §4.2.
- La pagina: guard dedicata (`resource-manager, delivery-executive, admin`) sul modello di `capacityGuard`, con la costante dei ruoli condivisa con la nav.
- L'audit esplicito della transizione di sistema (`allocationTransitionAudit`) punta a `/assignment-months/<id>`.

### 4.7 Breaking change dichiarato

Con lo stato derivato, **`POST/PUT /assignments` non accetta più `status` dal client**: `ALLOCATION_CLIENT_SETTABLE` si svuota e il ciclo passa interamente dagli endpoint per-mese. `staffing.component` va adeguato: «Assign» crea la proposta, l'invio in approvazione avviene dal calendario.

---

## 5. Frontend (Angular 21, signal-first, pattern `authReady`)

### 5.1 Calendario di allocazione (esistente, lato PM)

Per ciascun mese: badge di stato, pulsante **«Invia mese in approvazione»** accanto al «Salva mese in bozza» già presente, campo **nota pianificatore** (abilitato solo dopo il salvataggio in bozza, come RPT §3.5), nota dell'approvatore in sola lettura quando presente.

### 5.2 Nuova pagina `/allocation-approvals` (People Manager)

- filtro periodo sui mesi aperti + filtri **Richiesto / Confermato / Tutti** (RPT §4.1.2);
- tabella risorse: ore pianificate vs target per mese, semaforo (riuso di `semaphoreBand`, B2), stato aggregato; checkbox di selezione e pulsante **«Allocazione multipla»**;
- **modale-calendario multi-commessa**: selettore mese, una riga per commessa con ore del mese e checkbox, pulsante note (evidenziato quando esistono note, RPT §4.2), azioni **«Approva Mese»** / **«Rifiuta mese»** e, in modalità multipla, **«Approva e Prosegui»** che decide e avanza al mese successivo senza chiudere la finestra. La correzione delle ore prima di approvare passa da `PUT /assignments/:id/allocation`.

L'inbox `/approvals` resta e descrive la riga `Allocation` come risorsa / commessa / **mese**, rimandando alla nuova pagina. Nav gated come `/capacity`.

Pattern obbligati: standalone + `OnPush`, `signal`/`computed`/`linkedSignal`, `rxResource` con params su `auth.authReady()`, control flow nativo, design system `command-*` con token `-text` (WCAG AA), Material solo per le icone.

---

## 6. Migrazione

- Migration Drizzle additiva per `assignment_months` (+ indici). Nessuna colonna rimossa: `assignments.approvalId` resta come legacy.
- **Backfill logico** (non SQL puro, serve la mappatura giorni→mesi): per ogni assignment con righe-giorno, una riga mensile per ciascun mese coperto, con `status` = stato corrente dell'assignment. Assignment senza giorni → nessuna riga (stato derivato `Draft`), coerente con B1.
- `seed.ts` — single source of truth in-memory + Pg — genera `assignmentMonths` coerenti con i suoi assignment e con gli stati della demo.
- Le `ApprovalRequest` Allocation **pendenti pre-B3** restano con `refId` = id assignment e sono gestite dal ramo legacy dell'hook (§4.2).

---

## 7. Testing

- **Funzioni pure** (Vitest, come i `*.util.spec.ts`): precedenza dello stato derivato, aggregati per-mese, transizioni ammesse per mese.
- **Handler** via smoke esteso (`scripts/smoke-api.mjs`): submit con gate mese-aperto e auto-approvazione; batch con **esiti misti**; SoD e step enforcement; edit di un mese `Allocated` che retrocede **solo** quel mese (i mesi vicini restano `Allocated`); decisione ammessa su mese chiuso ed edit rifiutato sullo stesso.
- **Componenti**: spec sul modello di `capacity.component.spec` (tabella, filtri, modale, selezione multipla).
- **Parità in-memory/Pg** della nuova tabella (`nullsToUndefined`, empty-patch).
- Gate finali come B1/B2: build, unit test, lint, smoke live.

---

## 8. Rischi e questioni aperte

- **La UI multi-risorsa è la parte più corposa.** Se serve tagliare, «Approva e Prosegui» è l'ultimo task e si rimanda senza intaccare il resto (la modale singola resta pienamente funzionale).
- **Doppio livello di stato** (mese autorevole, assignment derivato): richiede disciplina perché nessun percorso scriva più `assignments.status` direttamente. Mitigato dallo svuotamento di `ALLOCATION_CLIENT_SETTABLE` (§4.7) e da un test dedicato.
- **`rollupMonthly` cambia input**: la dashboard `/capacity` di B2 va riverificata (numeri e semaforo) dopo il passaggio allo stato per-mese.
- **Volume righe**: `assignmentMonths` ≈ assignment × mesi coperti — ordini di grandezza inferiori a `assignmentDays`, nessuna preoccupazione.
- **Edit su mese `Requested`**: la scelta di non rigenerare la richiesta (l'approvatore rilegge le ore correnti) diverge da RPT, che di fatto congela la proposta inviata. Scelta consapevole: coerente con il comportamento già adottato in B1 per gli assignment `Requested`, ed evita un'inutile catena di richieste superate.
