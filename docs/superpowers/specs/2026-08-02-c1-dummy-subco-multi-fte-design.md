# Design — C1: Risorse Dummy/Subco + pianificazione Multi-FTE

- **Data:** 2026-08-02
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «C — Risorse DUMMY / SUBCO + Multi-FTE» della gap analysis RPT (Lutech Resource Planning Tool) vs Delivery Control. C è **decomposto in 2 fasi**; questa spec copre **C1**.
- **Fonte funzionale:** `Manuale utente RPT (ITA) v4.pdf`, §3.2.3 (Nuova Pianificazione risorsa DUMMY), §3.2.3.1 (elenco dummy a sistema), §3.2.5 (Nuova Pianificazione risorsa SUBCO), §4.1.2 (tipologia stati risorse), §4.2.2 (creazione dummy).

---

## 1. Contesto e obiettivo

Delivery Control conosce un solo tipo di risorsa: la persona interna. RPT ne conosce tre, e i due tipi mancanti servono a rappresentare **capacità che non esiste ancora**:

- **DUMMY** — segnaposto per una persona non ancora identificata, preconfigurato per practice, livello professionale e tariffa giornaliera. Il PM lo pianifica come una risorsa vera; il People Manager lo sostituirà con una persona reale (C2) o farà aprire una demand di hiring (blocco F).
- **SUBCO** — collaboratore esterno, con la società di appartenenza. Il manuale è esplicito: «non essendo persone interne all'azienda non rientrano nei KPI di allocazione delle risorse interne» (§4.1.2).

Su entrambi RPT abilita il **Multi-FTE**: allocazione oltre 1 FTE (1,5 · 2 · 2,5 · … · 30) per esprimere un fabbisogno maggiore di quanto una singola persona copra. Sugli interni resta il tetto di 1 FTE (§3.2.3).

**Obiettivo di C1:** introdurre il tipo risorsa e il multi-FTE, tenendo dummy e subco fuori dai KPI di saturazione degli interni e mostrandoli come fabbisogno.

### Decomposizione di C (concordata)

- **C1 (questa spec):** tipo risorsa, società per i subco, creazione dalle schermate esistenti, multi-FTE, esclusione dai KPI interni, seed.
- **C2 (fase successiva):** **sostituzione dummy → risorsa reale** — ricerca della persona, importazione delle commesse del dummy sul suo calendario, completamento della sostituzione all'approvazione del mese, sostituzione **parziale** con le ore residue che restano sul dummy (§4.2.1).

### Fuori scope

- Ricerca avanzata per skill/capability/practice (blocco D): qui basta il filtro per tipo.
- Dashboard bench/Unchargeable e forecast hiring/subco (blocco E) — C1 produce però il numero su cui E poggerà.
- Requester Portal / codice RES (blocco F).
- Email ai responsabili alla creazione di un dummy (§4.2.2): il progetto non ha un canale di notifica esterno.

### Decisioni di requisito (approvate)

1. **C decomposto**: C1 tipi + multi-FTE, C2 sostituzione.
2. **Multi-FTE senza campo FTE persistito**: le ore/giorno restano l'unica fonte di verità; per dummy e subco il tetto giornaliero si allarga.
3. **Dummy e subco fuori dai KPI interni**, visibili come fabbisogno in una sezione dedicata.
4. **Creazione dal form risorse esistente**, con campo tipo e società condizionale.

---

## 2. Modello dati

Due colonne su `resources`, nient'altro:

```
kind      text notNull default 'internal'   -- 'internal' | 'dummy' | 'subco'
vendorId  text → vendors.id (nullable)      -- obbligatorio se kind='subco', vietato altrimenti
```

Il default `'internal'` rende la migration retro-compatibile: ogni riga esistente resta interna, nessun backfill. `vendorId` riusa il catalogo `vendors` (`schema.ts:397`) invece di un campo testo libero.

I **dummy non richiedono campi nuovi**. Il manuale li descrive come «codice dummy / struttura organizzativa / tariffa giornaliera / livello professionale» (§3.2.3.1): `organization` e `role` esistono già, la tariffa arriva dalle rate card o dall'override per-risorsa. Le **skill richieste** per la figura cercata vivono, come dice il manuale (§3.2.3), nella nota di pianificazione — cioè il `plannerNote` per-mese introdotto da B3.

Il tipo risorsa **non** è un catalogo di customizing: il codice ci fa branching (tetto giornaliero, esclusione dai KPI, ammissibilità del multi-FTE), quindi renderlo configurabile sposterebbe errori dal compilatore al runtime. Tariffa e livello dei dummy, che sono davvero parametri, restano nelle rate card.

---

## 3. Layer puro `resource-kind.util.ts`

Nuovo `src/app/services/resource-kind.util.ts` (SSR-safe, nessun orologio), accanto a `calendar.util` / `capacity.util` / `allocation-month.util`, importato sia dal server sia dalla UI perché la regola sia una sola:

- `type ResourceKind = 'internal' | 'dummy' | 'subco'`
- `MULTI_FTE_MAX = 30` — il tetto del manuale.
- `isMultiFteEligible(kind): boolean` — vero per `dummy` e `subco`.
- `dailyCapFor(kind, contractHoursPerDay): number` — `contractHoursPerDay` per gli interni, `contractHoursPerDay × MULTI_FTE_MAX` per gli altri.
- `countsTowardInternalCapacity(kind): boolean` — falso per `dummy` e `subco`; è la funzione che li tiene fuori dai KPI.

---

## 4. Logica server

### 4.1 Validazione su `/resources`

- `kind` deve essere uno dei tre valori (400 altrimenti); assente su create ⇒ `'internal'`.
- `vendorId` **obbligatorio** quando `kind='subco'`, **rifiutato** per gli altri tipi (un interno con una società è un dato incoerente), e deve referenziare un vendor esistente.
- **Cambio di tipo su una risorsa allocata**: ammesso solo se ogni giorno già allocato resta valido sotto il nuovo tetto. Trasformare in interno un dummy con 20 h/giorno prenotate lo porterebbe oltre il cap: la richiesta risponde **400** nominando il primo giorno che sfora. Nessun ricalcolo silenzioso delle ore.

### 4.2 Gate di capacità giornaliera (B1) — una riga

`PUT /assignments/:id/allocation` conserva struttura, lock e re-check TOCTOU: somma le ore di **tutti** gli assignment della risorsa in quel giorno dentro il lock `res:`. Cambia solo il tetto contro cui confronta, che passa da `contractHoursPerDay` a `dailyCapFor(kind, contractHoursPerDay)`, nel punto in cui il cap è già risolto (compreso il guard su valori 0/NaN/negativi, che resta).

### 4.3 `/capacity/monthly` — separazione capacità/domanda

`rollupMonthly` divide le risorse in due insiemi tramite `countsTowardInternalCapacity`:

- **interni** → `rows`, totali di capacità, `resourceCount` e **semaforo**, esattamente come oggi;
- **dummy e subco** → nuovo `demandRows`, stessi FTE mensili, **nessuna banda semaforo** (non hanno una capacità da saturare).

`CapacityTotals` guadagna `demandFteUncovered`, distinto da `demandFtePlanned`: la dashboard può dire «12,4 FTE pianificati sugli interni, più 3,0 FTE di fabbisogno non coperto» invece di sommare grandezze diverse. È il numero che il blocco E leggerà per il forecast hiring/subco.

### 4.4 Invarianti che NON cambiano

- Il **feed di approvazione** (`/allocation-approvals`) continua a includere i dummy: nel manuale il People Manager li vede e li decide, ed è il punto in cui C2 innesterà la sostituzione.
- L'**utilization scalare legacy** (`resources.utilization`) non viene toccata. La decisione resta questa, ma la motivazione va corretta su due punti — è il campo che C2 leggerà, quindi conta che il paragrafo dica il vero:
  - **Non** vale 250% su un dummy a 2,5 FTE: `clampUtil` (`src/server.ts`) limita lo scalare a `[0, 100]`, quindi un dummy a 2,5 FTE legge esattamente 100%, indistinguibile da un interno saturo. Lo scalare **non sa esprimere** il multi-FTE; l'unica lettura fedele del carico di un dummy è il rollup mensile (`/capacity/monthly`, `demandRows` + `demandFteUncovered`).
  - **Non** è vero che «non alimenta i KPI aggregati»: `/reporting` lo legge direttamente per la tile *Avg Resource Utilization* e per il grafico per-persona. Quei due aggregati sono quindi filtrati con `countsTowardInternalCapacity` come il rollup (senza il filtro, i dummy seminati a `utilization: 0` dimezzavano la media di portafoglio). La regola generale è: **ogni aggregato di capacità interna filtra per kind, ovunque legga i dati** — non è una proprietà che il rollup garantisce per conto degli altri.
- RBAC invariata: le mutazioni `/resources` sono già gated a `resource-manager, delivery-executive, admin`.

### 4.5 Seed

Alcuni dummy preconfigurati su practice e livelli diversi (come l'elenco che RPT pre-carica) e un subco agganciato a un `vendor` esistente, così la funzione è visibile al primo avvio. `src/db/seed.ts` resta l'unica fonte, consumata da in-memory e Postgres.

---

## 5. Frontend

- **Form risorsa** (`resources.component.ts`): selettore di tipo; campo società (select sul catalogo `vendors`) visibile e obbligatorio **solo** per i subco. Nella lista, badge di tipo e filtro per tipo — quanto basta per isolare i dummy, che è il gesto con cui il manuale apre la pianificazione di un fabbisogno.
- **Staffing**: dummy e subco sono selezionabili come qualsiasi risorsa quando si crea una proposta su una richiesta — è il gesto con cui il PM pianifica un fabbisogno non ancora coperto. Nell'elenco di selezione compaiono con il badge di tipo, così non si sceglie un dummy per errore credendolo una persona.
- **Calendario di allocazione**: accanto ai tasti 100% / 50% / Azzera, **solo su dummy e subco**, un selettore FTE (1 · 1,5 · 2 · … · 30) che scrive le ore corrispondenti sui giorni lavorabili del mese (2,5 FTE = 20 h/giorno con base 8). Sugli interni non compare. Questo rende **strutturalmente vero** il vincolo che RPT esprime come regola («multi-FTE solo se la selezione comprende esclusivamente dummy o subco»): da noi si alloca un assignment alla volta, quindi il caso della selezione mista non esiste. L'indicatore di capacità per-giorno usa il tetto del tipo, così un dummy a 20 h non viene segnalato in rosso a torto.
- **`/capacity`**: sotto la griglia degli interni, una sezione *Uncovered demand* con le stesse colonne mensili e gli FTE, senza semaforo; nella striscia KPI il fabbisogno non coperto accanto alla domanda interna.
- Pattern obbligati: standalone + `OnPush`, signal-first, control flow nativo, `rxResource` keyed su `auth.authReady()`, design system `command-*` con token `-text`, Material solo per le icone. **Copy in inglese.**

---

## 6. Migrazione

Migration Drizzle additiva: `kind` con default `'internal'` (nessun backfill necessario) e `vendor_id` nullable con FK a `vendors`. Nessuna colonna rimossa, nessun tipo modificato.

---

## 7. Testing

- **Layer puro**: ammissibilità multi-FTE, tetto per tipo, esclusione dai KPI.
- **`capacity.util`**: separazione fra `rows` e `demandRows`, totali che non mescolano capacità e fabbisogno.
- **Smoke** (`scripts/smoke-api.mjs`): subco senza società → 400; subco con vendor inesistente → 400; dummy allocato oltre 1 FTE → accettato; interno oltre il proprio cap → 400; cambio di tipo con allocazioni incompatibili → 400 con il giorno che sfora; `/capacity/monthly` che tiene separati i due insiemi.
- **Componenti**: campo società condizionale nel form, sezione *Uncovered demand* nella dashboard, selettore FTE presente sui dummy e assente sugli interni.
- Gate finali come B3: build, unit, lint, smoke live in-memory **e** su Postgres.

---

## 8. Rischi e questioni aperte

- **Il selettore FTE atterra nel calendario**, il componente che in B3 ha prodotto due difetti di reattività (un `linkedSignal` che azzerava le ore dei mesi vicini e uno che resettava il mese selezionato a ogni reload). Va trattato con la stessa cautela e coperto da spec.
- **`rollupMonthly` cambia forma per la seconda volta in due blocchi** (B3 ne ha cambiato il criterio di classificazione, C1 ne cambia la partizione). È la funzione su cui poggiano i numeri della dashboard: i consumatori sono `/capacity/monthly` e i test, entrambi da aggiornare insieme.
- **Volumi**: un dummy a 30 FTE × 8 h = 240 h/giorno produce totali mensili grandi ma non rompe alcun vincolo; i controlli restano sui `Number.isFinite`.
- **Il tetto di 30 FTE è una costante di codice**, non un parametro: è il valore del manuale e nessun percorso lo rende configurabile. Se dovesse servire per cliente, diventa un `setting`, non un catalogo.
