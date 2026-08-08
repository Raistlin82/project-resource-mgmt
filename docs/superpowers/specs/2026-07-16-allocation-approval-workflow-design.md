# Design — Workflow di approvazione dell'allocazione risorse

- **Data:** 2026-07-16
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «A — Workflow approvazione allocazione» della gap analysis RPT (Resource Planning Tool) vs Delivery Control.

---

## 1. Contesto e obiettivo

RPT modella lo staffing come un **ciclo a due stadi**: il *Project Manager* propone chi allocare su una commessa, e il *People Manager* (il manager della persona) **approva o rifiuta** l'allocazione. Stati: `BOZZA → RICHIESTO → ALLOCATO`.

Delivery Control oggi **non ha questo ciclo**: un `assignment` viene creato direttamente, con `status` testo libero e non validato (`src/server.ts:1249`), e gli aggregati (`staffedEffort`, `utilization`) si ricalcolano alla creazione a prescindere dallo stato (`recomputeResourceUtilization`, `src/server.ts:996`). Esiste però un **motore di approvazione generico e completo** (`approvalRequests`: multi-step, SoD, SLA, lock di concorrenza, inbox `/approvals`), che è **scollegato dal lifecycle delle entità** — `createApprovalRequest` non è mai invocato dal frontend e la decisione non ha effetti collaterali sull'entità referenziata (`refId` è un riferimento "soft").

**Obiettivo:** introdurre il workflow Pianificazione → Approvazione dell'allocazione **riusando** il motore `approvalRequests`, così da avere un'unica inbox, un unico audit trail e un'unica implementazione di SoD/SLA — completando l'infrastruttura già predisposta.

### Fuori scope (gap distinti)

- Allocazione mensile time-phased / calendario giornaliero / FTE (gap B) — restiamo sul modello attuale per-assignment (finestra `startDate/endDate` + `allocationPct`).
- Tipi risorsa Dummy/Subco + Multi-FTE (gap C).
- Dashboard Unchargeable / bench temporale (gap F).

L'approvazione è quindi a livello di **assignment**, non di mese.

---

## 2. Decisioni chiave (confermate)

1. **Approvatore = People Manager gerarchico**: il `managerId` della risorsa allocata (`schema.ts:91`), con **fallback** al ruolo `resource-manager` quando `managerId` è assente/non valido.
2. **Macchina a stati a 4 stati** con **ri-approvazione forzata**: modificare un'allocazione `Allocated` la riporta a `Requested` e rigenera l'approvazione.
3. **Aggregati doppi**: per ogni grandezza tracciamo *confermato* (solo `Allocated`) e *pianificato* (`Requested` + `Allocated`).
4. **Auto-approvazione** quando il proponente coincide con il `managerId` della risorsa: l'assignment nasce direttamente `Allocated`, senza approval-request.
5. **Approccio architetturale**: riuso del motore `approvalRequests` con nuovo `kind='Allocation'`.

---

## 3. Modello dati e macchina a stati

### 3.1 `assignments` (estensione — `schema.ts:149`)

- `status`: **validato** a `'Draft' | 'Requested' | 'Allocated' | 'Rejected'` (oggi testo libero, `server.ts:1249`).
- `approvalId?: string`: link all'approval-request corrente (nullable).
- Invariati: `assignedHours`, `allocationPct`, `startDate/endDate`, `requestId`, `resourceId`.

### 3.2 `approvalRequests` (estensione minima — `server.ts:2379-2395`)

- `ApprovalKind` += `'Allocation'`; `APPROVAL_KINDS` += `'Allocation'`.
- `ApprovalStep` += `approverId?: string`: l'utente specifico autorizzato a decidere lo step (il People Manager), **in aggiunta** al `role` esistente (che resta come etichetta e fallback).
  - **Attenzione — doppia definizione da tenere in sync:** il tipo `ApprovalStep` (e `ApprovalRequestEntry`) esiste in due punti: il canonico `src/app/services/api.service.ts:448` (importato da `src/db/schema.ts:41` per il typing del jsonb `steps`) e una **copia locale** in `src/server.ts:2381`. `approverId?` va aggiunto a **entrambi**. Nessuna migration SQL per gli step: `steps` è una colonna `jsonb`.

### 3.3 Transizioni

| Da | Evento | A |
|---|---|---|
| — | crea proposta | `Draft` |
| `Draft` | "manda in approvazione" | `Requested` (+ crea approval-request) |
| `Requested` | approvatore *Approva* | `Allocated` |
| `Requested` | approvatore *Rifiuta* | `Rejected` (con nota) |
| `Rejected` | PM corregge e rimanda | `Requested` (nuova approval-request) |
| `Allocated` | modifica ore/finestra/risorsa | `Requested` (retrocessione + nuova approval-request) |
| *proponente = `managerId` della risorsa* | manda in approvazione | `Allocated` diretto (auto-approvazione) |

---

## 4. Logica server

### 4.1 Routing per-manager

Nuova logica di routing per `kind='Allocation'` (accanto a `buildApprovalSteps`/`approverRolesByKind`, `server.ts:2409-2431`): lo step è
`{ role: 'resource-manager', approverId: <managerId della risorsa> }`.
Se `managerId` è assente/non valido → step con solo `{ role: 'resource-manager' }` (fallback puro = comportamento attuale). **Single-step**, nessuna soglia € (l'allocazione non ha un "importo" naturale — YAGNI).

### 4.2 Creazione dell'approvazione (aggancio al lifecycle)

Nell'handler `POST/PUT /assignments`, quando `status` passa a `Requested`:
1. risolve il `managerId` della risorsa;
2. se `managerId === proponente` → salta l'approvazione, `status='Allocated'` (auto-approvazione);
3. altrimenti crea l'approval-request (`kind='Allocation'`, `refId=assignmentId`, `requestedBy=proponente` pinnato lato server) e salva `approvalId` sull'assignment.

Tutto entro il `withLock` già presente sugli aggregati dell'handler assignment.

### 4.3 Estensione dell'enforcement di decisione (`server.ts:2519`)

La decisione è ammessa se:
`decidingRole === step.role` **oppure** `by === step.approverId` **oppure** `decidingRole === 'admin'`.

Così il manager specifico può decidere, e il fallback per ruolo resta valido. La SoD esistente (`by === ar.requestedBy` → 403, `server.ts:2510`) resta invariata: copre anche il caso "fallback per ruolo" (un altro `resource-manager`, diverso dal proponente, può approvare).

### 4.4 Hook post-decisione (nuovo)

Dopo che una decisione su un'approval-request `kind='Allocation'` è committata, si applica l'effetto sull'assignment (`refId`):
- `Approved → assignment.status='Allocated'`;
- `Rejected → assignment.status='Rejected'`;
- ricalcolo degli aggregati.

Eseguito **dopo** il rilascio del lock `approval:<id>`, sotto `withLock('res:'+resourceId)` poi `withLock('req:'+requestId)` (ordine fisso res→req per evitare deadlock; nessun lock annidato incrociato con `approval:`).

### 4.5 Aggregati doppi (`recomputeResourceUtilization` + `requestStatusFor`)

Calcoliamo due grandezze:
- *confermato* = somma sugli assignment `Allocated`;
- *pianificato* = somma su `Requested` + `Allocated`.

Persistiti come: `requests.staffedEffort` / `requests.staffedEffortPlanned`; `resources.utilization` / `resources.utilizationPlanned`. `Draft` e `Rejected` non contano.

### 4.6 RBAC (`roleGate`)

La creazione/proposta di assignment resta gated a `pm, resource-manager, delivery-executive, admin` (invariato, `server.ts:489`). La decisione passa per `PUT /approval-requests/:id/decision` (già esistente).

**Assunzione sul gate approvazioni:** perché il routing per `step.approverId` sia effettivo, il People Manager deve prima passare il gate mutation coarse su `/approval-requests` (`server.ts:496`), che ammette solo `pm, resource-manager, delivery-executive, finance, admin`. Un manager con ruolo piattaforma `employee` o `sales` verrebbe bloccato **prima** del check a livello di step. Assumiamo che i People Manager abbiano il ruolo `resource-manager` (che è anche il ruolo di fallback, già gated); il caso di un manager con ruolo non ammesso è un edge case accettato (ricade comunque sul fallback per ruolo).

---

## 5. Frontend (Angular 21, signal-first, pattern `authReady`)

- **`staffing.component.ts`**: il pulsante "Assign" (oggi `status:'hard-booked'`, `:415`) diventa **"Salva in bozza"** (`Draft`) e **"Manda in approvazione"** (`Requested`). Mostra lo stato.
- **`resource-requests.component.ts`**: riconcilia i badge già abbozzati ma senza code-path (`proposed`/`confirmed`, `:368`) in `Draft` (grigio) · `Requested` (ambra) · `Allocated` (verde) · `Rejected` (rosso). La barra di staffing mostra **due valori** (confermato pieno, pianificato tratteggiato).
- **`approvals.ts`** (inbox `/approvals`): mostra il kind `Allocation` ("Allocazione: *risorsa* su *progetto*"). `canDecide` esteso per considerare anche `step.approverId === userId` (oltre al ruolo).
- **Note bidirezionali** (gap #22, incluso): il proponente allega una nota alla proposta tramite `note` (già nell'allow-list POST, `server.ts:2440`), che resta la **nota del richiedente** su `ApprovalRequestEntry.note`. Per la **nota dell'approvatore** aggiungiamo un `note?` opzionale al body di `PUT /approval-requests/:id/decision` (oggi accetta solo `decision`, `:2480`) e la persistiamo **sullo `ApprovalStep` deciso** (nuovo campo `note?` sullo step, accanto a `decidedBy`/`decidedAt`) — **non** sovrascrivendo `ApprovalRequestEntry.note`, altrimenti si perderebbe la nota del PM. Così il canale è realmente bidirezionale.
- **`utilization`/`forecast`**: utilization "reale" usa il *confermato*; forecast/what-if possono usare il *pianificato*.

---

## 6. Migrazione dati (Drizzle + `seed.ts`)

- Nuova migration in `drizzle/`: `assignments.status` (text, **default `'Allocated'`** per le righe esistenti — ciò che è già bookato è considerato allocato → retrocompatibile) + `assignments.approvalId` (nullable). Colonne `requests.staffedEffortPlanned` e `resources.utilizationPlanned` (derivate ma persistite, come l'attuale `utilization`).
- `seed.ts` (single source of truth in-memory + Pg): assegnare `status` agli assignment seed e ricalcolare i due aggregati. Parità in-memory/Pg garantita dai soliti shim (`nullsToUndefined`).
- Backfill/ricalcolo aggregati al boot, accanto a `seedSequences()`.

---

## 7. Edge case ed error handling

- `managerId` assente, o che punta a una risorsa **terminata/inesistente** → fallback allo step per ruolo `resource-manager`.
- **DELETE / azzeramento** di un assignment `Requested` → l'approval-request pendente collegata viene ritirata (chiusa), mai lasciata orfana.
- Retrocessione di un `Allocated`: la vecchia approval-request (Approved) resta nello storico; se ne crea una nuova; `approvalId` punta a quella corrente.
- **Audit dell'effetto collaterale**: l'hook post-decisione muta l'assignment *fuori* dalla richiesta HTTP tracciata dall'audit middleware (che è `PUT /approval-requests/:id/decision`). L'hook **logga esplicitamente** la transizione di stato dell'assignment nell'audit, per una traccia completa.
- Concurrency: decisione sotto `withLock('approval:'+id)`; effetto applicato dopo il rilascio, sotto `withLock('res:')` poi `withLock('req:')`.

---

## 8. Testing (vitest — pattern `server-logic.spec.ts` / `repository.spec.ts`)

- Macchina a stati: transizioni valide/invalide.
- Routing: `managerId` presente → `step.approverId`; assente → fallback ruolo.
- Auto-approvazione: proponente = manager → nasce `Allocated`, nessuna approval-request.
- SoD: il proponente non decide (anche via fallback ruolo).
- Enforcement: manager specifico approva; altro utente con lo stesso ruolo approva solo in fallback (o admin); utente errato → 403.
- Hook post-decisione: `Approved→Allocated`, `Rejected→Rejected` + ricalcolo confermato/pianificato.
- Retrocessione di `Allocated` → `Requested` + nuova approval-request.
- DELETE di `Requested` → withdraw dell'approval-request.
- Parità in-memory/Pg dei nuovi campi.

---

## 9. Rischi e questioni aperte

- **Il modello per-assignment (non mensile)** limita la fedeltà a RPT (che approva per mese). Accettato: gap B lo colmerà in seguito; questo design è pensato per convivere con l'introduzione futura dei bucket mensili.
- **`managerId` non editabile da UI** oggi (`resources.component.ts` non ha un campo manager; il valore arriva solo da seed/API). **Decisione: incluso in questo lavoro** — esponiamo `managerId` nel form risorsa (dropdown sulle risorse attive), così il routing per-manager è utile e verificabile anche fuori dai dati seed. È un piccolo aggancio al gap D, giustificato perché senza di esso la feature ricadrebbe sempre sul fallback per ruolo. (I dati seed già popolano `managerId`, quindi la demo funziona da subito.)
- **Auto-approvazione** (decisione utente) indebolisce la SoD nel caso proponente=manager: scelta consapevole per pragmatismo operativo.
