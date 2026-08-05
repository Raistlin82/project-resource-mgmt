# Design — Baseline di budget/PCP vs piano corrente (Blocco E)

- **Data:** 2026-08-04
- **Stato:** Design approvato — le quattro decisioni di prodotto sono chiuse (vedi §1, §3, §5). In attesa di spec review + review utente.
- **Origine:** roadmap di allineamento RPT, blocco E: "Budget/PCP baseline vs planned" — un costo di progetto a budget, **congelato mese per mese**, confrontato col piano corrente, con delta in EUR e delta %. Bozza di partenza: `.superpowers/design-drafts/e-spec-draft.md`. Fatti da codice verificati: `.superpowers/design-drafts/e-facts.md` (raccolti in sola lettura sul checkout di `feature/negotiated-sell-rates` — quel ramo è oggi già mergiato in questo, vedi la nota in §7).
- **Riferimenti:** `docs/superpowers/specs/2026-08-04-negotiated-sell-rates-design.md` (precedente diretto: stessa forma di handler bespoke, stesso schema di integrità in scrittura, e la feature — `negotiatedRates`/`sellRateFor` — che questo blocco eredita come architettura già in produzione, non come lavoro concorrente); `docs/functional/project-delivery.md:114-196` e `docs/functional/reporting-analytics.md:100-250` (la storia budget/EAC/VAC che questo blocco affianca, non sostituisce); `docs/roles-and-permissions.md` (RBAC autoritativo).

---

## 1. Il gap, con la prova

Il Project 360, il dashboard di portafoglio e il Margin & Variance report mostrano già un `budget` (rettificato dalle CR approvate), un `eac` (stima a finire) e un `varianceAtCompletion` (`budget − eac`) — tutti prodotti da `computeProjectFinancials` (`src/app/services/finance.util.ts:199-229`) e tutti **numeri live**: si muovono ogni volta che una riga di piano finanziario o una CR approvata cambia (`effectiveBudgetForProject`, `finance.util.ts:195-197`). Nessuno di questi risponde alla domanda che questo blocco introduce: **quanto ci si aspettava di spendere quando il progetto è stato pianificato, mese per mese**, confrontato con quanto si spenderà secondo il piano di oggi.

Quel numero — un budget/PCP **congelato** — non esiste in nessuna forma:

- `plannedLaborCostForProject` (`finance.util.ts:124-131`) è l'unica funzione che oggi calcola un costo "pianificato": somma `assignedHours × resource.costRate` su tutti gli assignment del progetto. Ma è **un solo numero per l'intera vita del progetto**, non mensile — `Assignment.assignedHours` è il totale ore dell'intera finestra `startDate → endDate` dell'assignment, e la funzione non fa alcun bucketing per data. Il suo unico punto di chiamata è dentro `computeProjectFinancials`, per calcolare `etc` (riga 210): non è mai stata pensata per un confronto mensile.
- Nessuna tabella tra le 31 di `src/db/schema.ts` (verificato via `grep '^export const'`) contiene una copia congelata di un budget, di un piano o di uno schedule. La colonna più simile — `assignmentMonths.replacedBaselineDays` (`schema.ts:243-253`) — non c'entra: è parte del give-back della sostituzione dummy→reale (blocco C2), una mappa ore-per-giorno transitoria e per-singolo-assignment-mese, azzerata non appena la decisione si risolve — non uno snapshot di costo di progetto.
- L'unico prima/dopo genuino nello schema è `auditLogs` (`schema.ts:899-919`): `before`/`after`/`changedKeys`, scritti dal middleware di audit append-only **solo su PUT/DELETE** (vedi §7) — una `POST` non registra nessuno snapshot dei campi. Non è comunque una tabella "budget al giorno X" interrogabile per progetto/mese: fotografa i campi cambiati da una singola mutazione API.

In breve: il Project 360 sa dire "budget attuale, dove sto arrivando (EAC), quanto scosta (VAC)" — tutti numeri che si muovono col piano di oggi. Non sa dire "cosa avevo previsto all'inizio, e quanto mi sono spostato da lì", perché quel primo numero non è mai stato congelato da nessuna parte. Una tabella di baseline è **nuova**.

## 2. Il fatto architetturale che governa il design

**Il piano non ha oggi una forma mensile in EUR — solo in ore.** `monthlyAggregateHours` (`src/app/services/allocation-month.util.ts:86-99`) sa bucketare le ore di `AssignmentDay` per mese, pesate dallo stato del mese governante (`AssignmentMonth.status`: `confirmed` = solo `Allocated`, `planned` = `Requested` + `Allocated` — righe 89-98); ma **restituisce ore**, mai un importo, e i suoi soli chiamanti sono `staffing.util.ts`/`capacity.util.ts`/`src/server.ts` — mai `finance.util.ts`. `plannedLaborCostForProject` sa moltiplicare ore per `costRate`, ma solo come totale di progetto. **Nessuna funzione fa entrambe le cose insieme.** Qualunque cosa questo blocco congeli deve prima colmare quel join, ed è esattamente ciò che serve anche per il lato "pianificato" del confronto (§4), non solo per il freeze.

Il roadmap chiede esplicitamente di riusare la forma di `recognitionSchedule` (`finance.util.ts:688-834`) per il lato pianificato. Quella forma è già generica — firma `(data, periods, opts)`, funzioni di supporto libere e riusabili verbatim (`periodOf`, `periodRange`, `clampPeriod`, righe 554-606, non metodi). Questo design introduce una nuova funzione pura, **`plannedCostSchedule`**, con la stessa firma:

```ts
// src/app/services/finance.util.ts — nuova funzione, stessa forma di recognitionSchedule
export interface PlannedCostPeriod {
  period: string;       // YYYY-MM
  plannedCost: number;  // EUR — costo pianificato di quel mese
  cumulative: number;   // EUR — Σ plannedCost dall'inizio dei periodi richiesti
}

export function plannedCostSchedule(
  data: FinanceData,
  periods: readonly string[] | { from: string; to: string },
  opts: { projectId: string },   // sempre richiesto — mai opzionale come in ScheduleOpts:
): PlannedCostPeriod[];          // il costo è sempre di UN progetto, mai di un contratto (§4)
```

Join, riga per riga: per ogni `AssignmentDay` il cui `assignmentId` appartiene a un assignment del progetto (stesso set di `plannedLaborCostForProject`: `requests.filter(projectId).id` → `assignments.filter(reqIds).id`), si guarda lo stato del suo `AssignmentMonth` (`monthRowId(assignmentId, monthOf(date))`, riuso diretto degli helper di `allocation-month.util.ts`); un giorno il cui mese è `'Allocated'` o `'Requested'` conta (lo stesso bucket **`planned`** che `monthlyAggregateHours` già usa altrove — non una seconda definizione di "cosa conta come piano"), un giorno il cui mese è `'Draft'`/`'Rejected'`/assente conta **0**. Il giorno che conta viene pesato per `resource.costRate` (EUR/ORA — vedi l'avvertenza critica sull'unità in §9) e sommato nel periodo (`periodOf(date)`, clampato con `clampPeriod`), con `cumulative` accumulato in un solo passaggio finale, esattamente come `recognitionSchedule` fa oggi.

**Questo richiede un'estensione a `FinanceData` che oggi non esiste**, e non è un dettaglio implementativo rimandabile: `FinanceData` (`finance.util.ts:6-53`) non porta né `AssignmentDay[]` né `AssignmentMonth[]` in nessun campo. Vanno aggiunti due campi opzionali, sullo stesso pattern di `timeEntries?`/`billingItems?`:

```ts
assignmentDays?: AssignmentDay[];
assignmentMonths?: AssignmentMonth[];
```

E **lato server non esiste alcuna via per leggerli in blocco**: `assignment-days`/`assignment-months` non hanno oggi una collezione REST propria (il commento esistente in `src/server.ts` lo dichiara: mutati solo attraverso `/assignments` e `/allocation-approvals`). Questo blocco deve aggiungere, in sola lettura, `GET /assignment-days` e `GET /assignment-months` (§5, §7) — senza queste due rotte `plannedCostSchedule` non ha modo di ricevere, lato client, l'input di cui ha bisogno, ed è esattamente il tipo di regola che non si scrive lasciando un buco nello schema/API: si scrive l'estensione richiesta, qui.

## 3. Modello dati

### 3.1 Cosa si congela (decisione chiusa)

**Si congela l'importo risolto in EUR, non gli input.** È l'unica lettura sotto cui "congelato" significa davvero congelato: se si conservassero ore × tariffa e si ricalcolasse a ogni lettura, la baseline si sposterebbe a ogni modifica di `costRate` di una risorsa — una cifra credibile ma sbagliata, che nessun test e nessun vincolo di schema intercetterebbe, perché sintatticamente è un numero valido, solo non più quello congelato. La colonna `amount` (§3.3) è quindi scritta **una volta**, al momento del freeze, e mai più ricalcolata.

### 3.2 Granularità (decisione chiusa)

**Una riga per mese**, rispecchiando la forma di `recognitionSchedule` (§2). Un totale unico di progetto direbbe "quanto", non "quando" — uno sforamento a marzo compensato a ottobre apparirebbe identico a un piano in linea. Fatto noto e dichiarato: **il costo non ha oggi alcun bucketing mensile** (§2) — quel join è lavoro nuovo di questo blocco, non un re-skin di codice esistente.

### 3.3 Tabella `cost_baselines`

Una tabella nuova, uno snapshot per progetto e mese:

| Colonna | Tipo | Semantica |
|---|---|---|
| `id` | `text` PK | come ogni altra entità |
| `project_id` | `text`, notNull, FK → `projects.id` | il progetto a cui la baseline appartiene |
| `period` | `text`, notNull | `YYYY-MM` |
| `amount` | `doublePrecision`, notNull | il costo congelato di quel mese, **in EUR** — l'importo già risolto (§3.1), mai ricalcolato |
| `frozen_at` | `text`, notNull | timestamp ISO di quando questa riga è stata scritta |
| `frozen_by` | `text`, notNull | l'attore (id utente) che ha congelato |

**Tipo di `frozen_at` — correzione rispetto alla bozza.** La bozza (`e-spec-draft.md:57`) lo tipava `timestamp` nativo Postgres. `schema.ts` dichiara però una convenzione di progetto esplicita e valida per ogni altra colonna data/ora dell'app (`createdAt`, `decidedAt`, `approvedAt`, `at` di `auditLogs`, `hireDate`, ...): **`text()` con stringa ISO**, "per evitare una conversione timestamp lossy" (commento di intestazione dello schema). Un `timestamp` nativo qui sarebbe l'unica colonna data/ora dell'intero schema a non seguirla, e romperebbe la parità tra adapter: l'adapter in-memory non ha alcuna nozione di tipo colonna, mentre Drizzle restituirebbe un oggetto `Date` da un `timestamp` reale — due forme diverse per lo stesso campo. `frozen_at` è `text()`.

**Nessuna colonna `currency`, a differenza di `negotiated_rates`.** Lì `currency` esiste perché il prezzo è un dato **inserito da un utente** e va validato. Qui l'importo è **interamente derivato server-side**: `resolveResourceRates`/`pickRateCard` (`src/server.ts`) risolvono `costRate` solo in valuta base (filtrano su `RATE_BASE_CURRENCY`, `'EUR'`), quindi `plannedCostSchedule` produce EUR per costruzione, esattamente come `plannedLaborCostForProject` fa già oggi senza mai portare una valuta. Una colonna `currency` qui sarebbe un campo forgiabile ma privo di significato, non un dato reale.

**Tipo di `amount` — `doublePrecision`, non `numeric(14,2)`.** Ogni altra colonna monetaria di questo schema (`budget`, `impact_budget`, `bill_rate`, `cost_rate`, tutti gli `amount` di ordini/righe/billing) è `doublePrecision`, per coerenza col runtime `number` di JS (nota di intestazione di `schema.ts`). Introdurre un `numeric(14,2)` isolato su questa sola colonna la renderebbe l'unica dell'intero schema con un tipo diverso: Drizzle restituisce `numeric` come **stringa** per default (a meno di una configurazione `.mode('number')` che nessun'altra colonna qui usa), e `costBaselineComparison` (§4) farebbe aritmetica diretta (`planned − baseline`) contro `plannedCostSchedule`, che restituisce sempre `number` — una sottrazione stringa-contro-numero è esattamente la classe di trappola di parità che questo progetto ha già pagato altrove. La migrazione a `numeric(14,2)` è annotata in `docs/` come cambio **futuro e sistemico** su *tutte* le colonne monetarie prima di emettere fatture reali: introdurne una isolata qui frammenterebbe quella migrazione in due generazioni incompatibili invece di farla in un colpo solo, più avanti, su tutto lo schema.

**Nessun vincolo di unicità su `(project_id, period)` — a differenza di quanto ipotizzato nella bozza.** È la conseguenza diretta della decisione sul ri-congelamento (§3.4): più righe per lo stesso `(project_id, period)` sono ammesse. Indice (non unico) su `(project_id, period)` per le letture "qual è la baseline corrente".

**Migrazione** (sul modello di `drizzle/0016_marvelous_omega_red.sql`, la migrazione di `negotiated_rates`):

```sql
CREATE TABLE "cost_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" double precision NOT NULL,
	"frozen_at" text NOT NULL,
	"frozen_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cost_baselines_project_id_idx" ON "cost_baselines" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "cost_baselines_project_period_idx" ON "cost_baselines" USING btree ("project_id","period");
```

Da seedare dopo `projects` (`src/db/bootstrap.ts`), sullo stesso principio già annotato lì per `negotiated_rates`: l'adapter in-memory non applica foreign key e non intercetterebbe un ordine di seed sbagliato — solo un boot su Postgres vuoto lo farebbe (§10).

### 3.4 Chi può congelare, e il ri-congelamento (decisione chiusa)

**Solo `finance`, `delivery-executive`, `admin`** (RBAC completo in §5). Nessun self-service PM: chi è misurato sulla varianza non deve poter riscrivere il metro che la misura, o uno sforamento diventa indistinguibile da una baseline aggiornata a metà corsa.

**Il ri-congelamento è ammesso, ma è un atto separato e tracciato — mai una `UPDATE` di una riga esistente.** Una seconda `POST /cost-baselines` per lo stesso progetto **non fallisce** e **non sovrascrive** nulla: scrive un nuovo lotto di righe con un `frozen_at` più recente. Non essendoci vincolo di unicità (§3.3), possono coesistere più righe per lo stesso `(project_id, period)`; **la baseline "corrente" di un periodo è, per definizione, la riga con il `frozen_at` più recente per quella coppia `(project_id, period)`** — mai una riga viene aggiornata o cancellata (nessuna `PUT`, nessuna `DELETE`, §3.5). Questo è ciò che rende "il target si è spostato?" una domanda sempre rispondibile: ogni congelamento, il primo e ogni successivo, resta una riga distinta, con il proprio `frozen_by`/`frozen_at`, mai nascosta da una scrittura successiva.

Questa regola è anche l'unica che rimane coerente con il caso di un progetto accorciato (§4): se un mese esce dall'orizzonte booked del piano corrente, un ri-congelamento successivo semplicemente **non scrive una nuova riga per quel periodo** (l'azione di freeze ricongela solo i mesi ancora coperti dal piano corrente, §3.5) — la riga più vecchia di quel mese resta l'unica, quindi resta "corrente" senza bisogno di alcuna logica di cancellazione o di flag di "superata". Il confronto (§4) la userà comunque, con `planned = 0` per quel mese: esattamente il caso di descoping già previsto.

### 3.5 Azione di scrittura

`POST /cost-baselines { projectId }` — handler bespoke, non `crud()`. Il body accettato è **solo** `{ projectId }`: `pick(req.body, ['projectId'])` non include affatto `amount`/`period`/`frozenAt`/`frozenBy` nell'allow-list, quindi un valore che il client invii per quei campi viene semplicemente **ignorato** (non è un 400 — lo stesso trattamento silenzioso già riservato a `status` su una nuova time entry o a `invoiceNumber`: sono campi pinnati server-side, non input utente).

L'azione: risolve l'**orizzonte di freeze** come l'unione dei mesi in cui il progetto ha almeno un `AssignmentDay` (`periodRange(min, max)` sui mesi booked dell'insieme di assignment del progetto — la stessa identica definizione di "orizzonte del piano" usata dal confronto in §4, tenute deliberatamente simmetriche), chiama `plannedCostSchedule` su quell'orizzonte **in quell'istante**, e scrive **atomicamente** una riga per periodo con quel `plannedCost` come `amount`. Nessun valore forgiabile dal client entra nella riga scritta.

**Serializzato per progetto**, a differenza di `/negotiated-rates` (che non usa alcun lock incrociato). Lì una race lascia al più una duplice riga sulla stessa chiave, comunque risolta deterministicamente in lettura. Qui una race fra due `POST` concorrenti sullo stesso progetto potrebbe produrre due righe per lo stesso `(project_id, period)` con un `frozen_at` **identico al millisecondo**, rendendo ambigua la nozione di "riga corrente" (§3.4) — un problema di integrità di governance, non solo un duplicato innocuo. L'handler avvolge lettura-del-piano + scrittura in `withLock(`cost-baseline:${projectId}`, ...)`, lo stesso meccanismo già usato altrove nel file per serializzare un read-modify-write; il costo è trascurabile perché il freeze è un'azione rara e già gated a ruoli finance-grade.

**Nessuna `PUT`, nessuna `DELETE` esposta.** Una baseline è un artefatto di governance, e il ri-congelamento (§3.4) è già il solo modo, esplicito e tracciato, di farne evolvere il valore corrente per un periodo. Una `DELETE` vanificherebbe esattamente lo scopo che l'assenza di `UPDATE` protegge.

## 4. Il confronto: pianificato, delta, e i bordi del periodo

**"Pianificato" al momento del confronto è sempre il valore live di `plannedCostSchedule` (§2) sul piano corrente, mai un altro snapshot**: se lo staffing cambia dopo il freeze, "pianificato" si muove con esso — è esattamente ciò che lo rende un termine di paragone contro un numero fisso.

```
delta(periodo)    = planned(periodo) − baseline(periodo)         // EUR — positivo = si sta spendendo più del previsto
deltaPct(periodo) = delta(periodo) / baseline(periodo) × 100      // % — vedi il caso baseline = 0 sotto
```

**Universo dei periodi:** l'unione dei mesi con almeno una riga di `cost_baselines` corrente (§3.4) per il progetto e dei mesi con almeno un `AssignmentDay` per il progetto (l'orizzonte booked di `plannedCostSchedule` — la stessa identica definizione usata per l'orizzonte di freeze in §3.5), da `min` a `max`, espansa con `periodRange`. Il totale di progetto somma `baseline` e `planned` su quest'unione, **non** sulla sola intersezione — un mese fuori baseline o fuori piano non deve sparire silenziosamente dal totale.

**Mese con baseline ma il piano non lo copre più** (progetto accorciato, assignment spostati altrove): `planned(periodo) = 0`, `delta = 0 − baseline` (negativo — si sta spendendo meno, o niente, di quanto previsto). Dato reale, mostrato normalmente: un progetto descoping o chiuso in anticipo è esattamente il caso che questo confronto deve rendere visibile, non nascondere.

**Mese nel piano ma mai congelato:** semanticamente diverso dal caso sopra — non è "baseline pari a zero", è "questo mese non è mai stato oggetto di un freeze". Per l'aritmetica del delta si tratta comunque `baseline(periodo) = 0` (altrimenti il totale non si potrebbe sommare), ma la riga porta un flag esplicito **`outOfBaselineHorizon: true`**, distinto da una baseline scritta esplicitamente a zero (`outOfBaselineHorizon: false` in quel caso) — la UI (§7) li marca diversamente, mai con lo stesso trattino muto.

**`deltaPct` quando la baseline è zero** (sia il caso "mai congelato" sia una riga di baseline scritta esplicitamente a zero): il tipo è **`number | null`**, mai `Infinity`/`NaN`. Sullo schermo e in CSV il valore `null` si rende con **`—`** (em dash) — non la stringa `"n/d"` ipotizzata nella bozza: è la stessa identica convenzione già in uso in questo esatto file per un caso analogo (`reporting.ts:139,204,1381`, `kpi.trend?.deltaPct !== null ? ... : '—'`), da riusare, non da reinventare. L'importo in EUR del delta resta comunque mostrato (`planned − 0 = planned`).

**Una variazione creata da una Change Request approvata è informazione da vedere, non da assorbire (decisione chiusa).** La baseline resta pinnata all'originale (§3.4 non prevede alcun ri-baselinamento automatico su CR); `effectiveBudgetForProject` continua a sommare l'`impactBudget` delle CR approvate esattamente come oggi, invariato da questo blocco. Una CR approvata che amplia lo scope fa quindi allargare visibilmente il delta di questo confronto — è il segnale d'allarme precoce che il blocco esiste per dare, non un difetto da correggere con un ri-baselinamento silenzioso. Se serve un nuovo metro, si congela una nuova baseline (§3.4): un atto visibile, non automatico.

Ogni importo EUR e ogni percentuale di questa sezione non supera **2 decimali** a schermo, in CSV e in ogni etichetta — regola completa in §9.

## 5. Chi può congelare, chi legge la baseline, e chi vede la card (RBAC)

**Decisione utente (quinta, chiusa dopo le prime quattro — §1): la lettura è disgiunta dal freeze.** Le quattro decisioni chiuse in apertura di questo documento coprivano solo *chi può congelare*. Chi può **leggere** la varianza è una domanda distinta, e la risposta dell'utente è: **`pm` e il People Manager possono leggere la baseline e il confronto; non possono congelare né ri-congelare.** Motivazione, perché vincola le estensioni future: chi gestisce il progetto è chi può agire su uno scostamento mentre c'è ancora tempo per farlo — riservare la lettura ai soli ruoli finance-grade renderebbe la baseline uno strumento di reporting a consuntivo invece che di controllo in corso d'opera. La segregazione dei compiti non ne risente: il motivo per cui il PM resta escluso dal *congelare* — chi è misurato sulla varianza non deve poter riscrivere il metro che la misura — vale identico a prima, perché riguarda la scrittura, non la lettura.

**Chi è il "People Manager" in questo codebase — non un ruolo a sé.** I 7 ruoli reali sono `employee`, `pm`, `resource-manager`, `sales`, `finance`, `delivery-executive`, `admin` (`UserRole`, `src/app/services/api.service.ts:351`; `ROLE_PRIORITY` e la tabella dei 7 ruoli in `docs/roles-and-permissions.md:17-42`). **"People Manager" non è una di queste stringhe: è il nome di persona per il ruolo `resource-manager`**, esattamente come il codice lo usa già altrove — la pagina di approvazione mensile B3 è descritta come "the People Manager per-month approval page" ma è gated a `resource-manager`/`delivery-executive`/`admin` (`docs/roles-and-permissions.md:87`), e la rotta `resources` ("People management") è gated agli stessi tre ruoli (riga 97). Quando lo scoping è per singola risorsa (non per capability generale), "il People Manager" è lo specifico `resource-manager` che è manager di quella risorsa nell'org chart (`docs/roles-and-permissions.md:254`). Ai fini di questa RBAC, quindi, "PM e People Manager" si traduce in due stringhe di ruolo già esistenti: **`pm` e `resource-manager`**.

**Mutazione — `POST /cost-baselines`:** invariata, `finance`, `delivery-executive`, `admin`. Nuova voce nell'array `rules` di `roleGate` (`src/server.ts:647-679`), sullo stesso schema della regola già esistente per `/project-financials`/`/project-cost-centers`/`/cost-centers` (riga 649).

**Lettura — `GET /cost-baselines`:** **disgiunta dalla mutazione.** Ruoli: `pm`, `resource-manager`, `finance`, `delivery-executive`, `admin` — cioè tutti tranne `employee` e `sales`. Questo insieme di cinque ruoli **non è nuovo**: è, ruolo per ruolo, lo stesso già usato dalla regola `READ_RULES` esistente per `/capacity` (`src/server.ts:721`, `['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin']`) — un'altra vista finanziaria/di-staffing aggregata che oggi è già letta da `pm` e `resource-manager` insieme a finance-grade. La nuova voce per `/cost-baselines` mirra quella, non ne inventa una diversa.

**Lettura — `GET /assignment-days`, `GET /assignment-months` (nuove, §2, §7):** invariata rispetto alla stesura precedente — estendere la regola `READ_RULES` **già esistente** per `/assignments`+`/requests` (riga 718: `['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin']`, lo stesso insieme di cinque ruoli di cui sopra) aggiungendo questi due prefissi all'array `.some(...)` — non crearne una nuova. Nessuna nuova regola di mutazione: queste due rotte sono **solo `GET`**, le tabelle restano mutabili solo via `/assignments`/`/allocation-approvals` come oggi.

**Scope della lettura: ogni progetto del portafoglio, non solo quelli del PM — verificato nel codice, non assunto.** L'unico punto dell'intera applicazione dove uno scoping "per-progetto-di-cui-il-PM-è-owner" esiste davvero è `globalTimeEntryPolicyContext` (`src/server.ts:3782-3803`, commento: "PM scope is project ownership; resource-manager scope reuses the canonical org chart/tree union") — ma è la policy di un'azione di **decisione** su una time entry (un confine di object-level authorization per approvare/rifiutare), non una regola di lettura di collezione. Ogni `GET` che `pm` può oggi effettuare (`/projects`, `/assignments`, `/requests`, `/capacity`, ...) restituisce **l'intera lista**, senza alcun filtro per `ownerId` (`apiRouter.get('/projects', ...)` chiama `repos.projects.list()` senza filtro, `src/server.ts:4368`; lo stesso per `/assignments`, `/requests`). Non esiste quindi, oggi, alcuno scope-per-lettura da "mirrorare" in senso stretto: la lettura di `pm` sui dati di progetto è **non ristretta** in ogni collezione paragonabile. `GET /cost-baselines` segue la stessa convenzione: **`pm` e `resource-manager` leggono la baseline di ogni progetto**, non solo dei propri. Restringerla per `ownerId` sarebbe inventare una regola di lettura che il resto dell'app non applica in nessun'altra collezione.

**Segnalato, non deciso: il People Manager potrebbe avere bisogno di uno scope più stretto di quello del PM.** Il remit di un `resource-manager` è le persone che gestisce, non il margine di un progetto — il suo bisogno di una baseline di costo di progetto è strutturalmente più debole di quello di un PM che ne risponde. L'utente ha scelto di includerlo comunque, e questa decisione resta; ma va detto esplicitamente **cosa un People Manager farebbe con questo numero**, perché un lettore futuro possa distinguere una concessione deliberata da una svista: la risposta onesta è "visibilità sulle persone che gestisce, non sul margine del progetto" — cioè un People Manager userebbe questo confronto per capire se lo sforamento di un progetto sta generando pressione (straordinari, richieste di sostituzione) sulle persone del proprio org-subtree, non per gestire il P&L del progetto. Questo argomenterebbe per uno scope **per org-subtree** (`scopeOf(resourceId, resources, orgNodes)`, lo stesso helper già usato da `globalTimeEntryPolicyContext` per lo scope di `resource-manager`, righe 3792-3798) invece che per progetto — la dimensione di scoping già propria di questo ruolo altrove nel codice, mai quella di `ownerId` che è invece la dimensione del PM. Questo blocco **non** implementa quello scoping (la decisione dell'utente è una lettura non ristretta per entrambi i ruoli, sopra); è annotato qui come l'estensione naturale se in futuro si vorrà restringere la vista del People Manager senza toccare quella del PM.

**I tre stati che la card deve distinguere, e quali ruoli ricadono in quale — dettaglio completo in §8:** (1) **il ruolo può leggere** (`pm`, `resource-manager`, `finance`, `delivery-executive`, `admin`) → il confronto si renderizza normalmente; (2) **il ruolo non può leggere** (`employee`, `sales`) → la card è **assente**, mai vuota, mai a zero; (3) **la lettura è fallita o non ancora risolta** (qualunque ruolo autorizzato, durante il caricamento o dopo un errore di rete) → "Non disponibile" più un retry, mai un numero. Il bottone "Freeze baseline" resta comunque visibile solo per `finance`/`delivery-executive`/`admin` (gated su `auth.canApproveFinancials()`, invariato) — un `pm`/`resource-manager` vede il confronto ma non il bottone.

## 6. Integrità in scrittura

| Regola | Esito |
|---|---|
| `projectId` mancante o non stringa non vuota | 400 |
| `projectId` che non esiste (`existsRepo(repos.projects, projectId)`) | 400 |
| Il progetto non ha alcun `AssignmentDay` (orizzonte di freeze vuoto, §3.5) — niente da congelare | 400 |
| `amount`/`period`/`frozenAt`/`frozenBy` presenti nel body | ignorati — non nell'allow-list di `pick()` (§3.5), non un errore |
| Una seconda `POST` sullo stesso `projectId` | **non rifiutata** — è il ri-congelamento stesso (§3.4); nessun vincolo di unicità da violare |
| `PUT`/`DELETE` su `/cost-baselines/:id` | nessuna rotta registrata — non esposto (§3.5) |

## 7. Punti di consumo

Le cinque superfici che oggi mostrano un costo/budget di progetto, con una decisione esplicita per ciascuna:

| Superficie | Decisione | Perché |
|---|---|---|
| **`project-details.ts`** (Project 360) | **Sì — superficie primaria.** Card "Baseline vs Planned" accanto a `eac`/`etc`/`varianceAtCompletion`, visibile a `pm`/`resource-manager`/`finance`/`delivery-executive`/`admin` (§5), con drill-down alla tabella mensile per tutti loro e il bottone "Freeze baseline" visibile solo per `finance`/`delivery-executive`/`admin` (`auth.canApproveFinancials()`, §5). | È dove oggi vive già la storia budget/EAC/VAC — l'estensione naturale, e l'unico punto dove un drill-down mensile ha senso in un solo colpo d'occhio; è anche la superficie dove un PM osserva per primo il proprio progetto. |
| **`dashboard.component.ts`** | **Sì, ma solo il totale di portafoglio**, accanto ai footer `eac`/`varianceAtCompletion` già esistenti — **non** una colonna per-progetto nella tabella progetti (già densa). | Coerente con come le altre superfici di portafoglio riassumono un KPI per riga; una vista per-progetto è un'estensione futura (§11). |
| **`reporting.ts`** (Margin & Variance) | **Sì.** Colonne `Baseline`/`Planned`/`Delta €`/`Delta %` nella tabella esistente, footer di portafoglio, e le stesse colonne nell'export CSV (che già include `eac`/`vac`). | È il report che già aggrega `computeProjectFinancials` per tutti i progetti — il posto naturale per un confronto a portafoglio. |
| **`contract-details.ts`** | **No, non in questo blocco.** | La baseline è un costrutto di progetto, non di contratto: mostrarla qui duplicherebbe `project-details.ts` senza aggiungere informazione. |
| **`financial-plans.ts`** | **No.** | Questa schermata gestisce righe di `projectFinancials` inserite a mano per categoria (budget/actual manuali, non derivati da assignment). Una baseline di costo del lavoro (derivata da ore × costRate) è una fonte dati diversa da un budget di categoria digitato; mescolarle confonderebbe un numero derivato con uno inserito a mano. |

**Nota sull'integrazione con le tariffe di vendita negoziate — correzione rispetto ai fatti raccolti.** `.superpowers/design-drafts/e-facts.md` §6 analizza un rischio di collisione di merge con `feature/negotiated-sell-rates`, un ramo **non ancora mergiato** al momento in cui quell'analisi fu fatta. Nel checkout corrente quel ramo **è già mergiato** (`negotiatedRates`/`sellRateFor` sono già in `src/db/schema.ts`, `src/app/services/finance.util.ts`, `src/server.ts`, con la tab "Rates" già presente in `project-details.ts`/`contract-details.ts`). Non c'è quindi più alcun ordine di merge da coordinare: la card "Baseline vs Planned" di questo blocco si aggiunge in modo puramente additivo accanto a quell'infrastruttura già spedita, senza alcuna finestra di collisione da gestire.

## 8. Stato di caricamento

Questo progetto ha già spedito, due volte nell'ultima settimana, una lettura fallita o vietata renderizzata come uno zero contabile credibile — una volta come Margine = Ricavo con Margine % 100.0 — la lezione che questo design non deve ripetere una terza. Ci sono **due assi indipendenti**, e vanno tenuti distinti: **chi può vedere la card** (un fatto di ruolo, noto subito, non asincrono) e **se i dati di chi può vederla sono arrivati** (un fatto temporale, asincrono). Nessuno dei due può sostituire l'altro.

**Asse 1 — il ruolo (§5), valutato per primo, sempre sincrono.** `pm`, `resource-manager`, `finance`, `delivery-executive`, `admin` → si procede all'asse 2. `employee`, `sales` → **la card non viene montata affatto**: nessuna fetch parte, nessun elemento DOM esiste per lei, su nessuna delle tre superfici di §7. Un'assenza dichiara "questo dato non ti riguarda"; una card vuota o a zero dichiarerebbe, falsamente, "qui non c'è nulla da vedere" — la stessa differenza già tracciata in §5 fra "non può leggere" e "ha letto zero".

**Asse 2 — il caricamento, solo per un ruolo che ha superato l'asse 1.** Il confronto interroga **sei fonti asincrone indipendenti**: `resources`, `requests`, `assignments` (già esistenti in ogni `financeData()`), più le due nuove `assignmentDays`/`assignmentMonths` (il lato "pianificato" live), più `costBaselines` (il lato congelato, la cui fetch a sua volta non parte affatto per un ruolo che ha fallito l'asse 1). Né la card né la tabella renderizzano un numero finché **tutte e sei** non sono risolte **con successo**:

```ts
comparisonReady = computed(() =>
  resourcesRes.hasValue() && requestsRes.hasValue() && assignmentsRes.hasValue()
  && assignmentDaysRes.hasValue() && assignmentMonthsRes.hasValue()
  && costBaselinesRes.hasValue(),
);
comparisonErrored = computed(() =>
  resourcesRes.error() || requestsRes.error() || assignmentsRes.error()
  || assignmentDaysRes.error() || assignmentMonthsRes.error() || costBaselinesRes.error(),
);
```

Finché `comparisonReady()` è falso e `comparisonErrored()` pure, la card mostra lo stesso skeleton/placeholder già usato dalle altre card KPI dello stesso schermo (`eac`, `etc`, `varianceAtCompletion`) — nessun nuovo trattamento di caricamento da inventare, e nessun valore intermedio calcolato da una sola fonte (mai "Baseline: 50.000 / Planned: in caricamento…"). Se una qualunque fonte fallisce (`comparisonErrored()` vero), la card mostra **"Non disponibile"** con un retry — mai un numero, mai lo stato "vuoto legittimo" sotto, con cui non va confusa.

**Riassunto per ruolo, i quattro stati che ne risultano:**

| Ruolo | Dati non ancora risolti | Una fonte è fallita | Nessuna baseline mai congelata | Dati pronti |
|---|---|---|---|---|
| `employee`, `sales` | — (card non montata) | — | — | — |
| `pm`, `resource-manager`, `finance`, `delivery-executive`, `admin` | skeleton/placeholder | "Non disponibile" + retry | testo "Nessuna baseline registrata per questo progetto", nessun numero, nessun delta | confronto renderizzato con i numeri |

Il terzo stato ("nessuna baseline mai congelata") resta uno stato **vuoto legittimo**, non un errore né uno zero contabile: `costBaselinesRes` risolve con successo, con una lista vuota per quel progetto. Questa griglia vale identica su tutte e tre le superfici di §7.

## 9. Formattazione e unità

Ogni grandezza introdotta da questo blocco, con la propria unità dichiarata esplicitamente — non implicita in nessun punto:

| Grandezza | Unità | Nota |
|---|---|---|
| `AssignmentDay.hours` (input di `plannedCostSchedule`) | ore | invariato, esistente |
| `resource.costRate` **consumato da `plannedCostSchedule`** | **EUR/ORA** | il valore **risolto** (override ?? rate card, già diviso per `hoursPerDay` da `withEffectiveRates`) — **mai** la colonna grezza `resources.cost_rate` (che è EUR/GIORNO). Vedi l'avvertenza sotto. |
| `PlannedCostPeriod.plannedCost` / `.cumulative` | EUR | base currency, per costruzione (§3.3) |
| `CostBaseline.amount` | EUR | congelato, mai ricalcolato (§3.1) |
| `CostBaselineComparisonRow.delta` | EUR | `planned − baseline` |
| `CostBaselineComparisonRow.deltaPct` | % (`number \| null`) | `null` quando `baseline = 0` (§4) |

**L'avvertenza che conta più di tutte, perché questo esatto progetto ha già spedito un difetto di questa identica forma (l'inflazione di ricavo ~8× di `sell-rate.util.ts`, EUR/giorno scambiato per EUR/ora):** l'handler di freeze **non deve** assemblare il proprio `FinanceData` riusando verbatim `loadFinanceData()` (`src/server.ts:6529-6547`). Quella funzione alimenta gli export GL/BI e il suo campo `resources` è, per una **inconsistenza nota e già deliberatamente non corretta** (documentata nel commento a `server.ts:6517-6527`), la riga **grezza** (`repos.resources.list()`), il cui `costRate`/`billRate` è **EUR/GIORNO**, non EUR/ORA. Riusarla qui moltiplicherebbe `AssignmentDay.hours` (ore) per un tasso in EUR/giorno, gonfiando ogni baseline di un fattore `hoursPerDay` (8× con la configurazione di seed) — esattamente la stessa classe di difetto, sulla stessa base di codice. L'handler di freeze deve assemblare le proprie risorse chiamando **`resolveResourceRates(await repos.resources.list())`** — la stessa risoluzione che `GET /api/resources` applica già e che il client consuma sempre (`project-details.ts` ottiene `resources` da `this.api.getResources()`, mai da una lista grezza) — così che `plannedCostSchedule` riceva ovunque lo stesso `costRate` orario che `plannedLaborCostForProject` già consuma oggi, senza introdurre una seconda unità per lo stesso campo. **Test obbligatorio (§10):** un caso che pinna che `plannedCostSchedule`, eseguita lato server (nel percorso di freeze) e lato client (nel percorso di confronto live), produca lo stesso numero sullo stesso fixture — se le due differiscono di un fattore `hoursPerDay`, il test fallisce.

**Precisione a schermo — mai più di 2 decimali.** Ogni cella EUR di questo blocco usa `currency:'EUR':'symbol':'1.0-0'`, la stessa pipe già in uso sulla colonna `eac`/`varianceAtCompletion` adiacente su ciascuna delle tre superfici di §7 — nessuna nuova utility di formattazione. Ogni cella `deltaPct` usa un `digitsInfo` esplicito con `maxFractionDigits ≤ 2` (mai il default di `DecimalPipe`/`CurrencyPipe`, che è `1.0-3` e viola il vincolo), e renderizza `—` quando il valore è `null` (§4) — mai una stringa diversa inventata per questo blocco. L'export CSV di `reporting.ts` riusa la stessa convenzione già in vigore per le colonne `eac`/`vac` (`.toFixed(2)`), con `—` per un `deltaPct` nullo — mai una cella vuota, mai `NaN`.

## 10. Verifica

**Unit sul layer puro** (`finance.util.spec.ts`):
- `plannedCostSchedule`: stessa forma di `recognitionSchedule` — periodo esplicito non contiguo, `{from,to}` espanso, clamping a inizio/fine lista, riuso verbatim di `periodOf`/`periodRange`/`clampPeriod` (comportamento di clamping identico a quello già testato per `recognitionSchedule`); un giorno il cui `AssignmentMonth` è `'Requested'` conta nel piano, uno `'Draft'`/`'Rejected'`/assente no; risorsa mancante trattata come `costRate` 0 (coerente con `plannedLaborCostForProject`); arrotondamento a 2 decimali.
- **Il test di unità (§9):** stesso fixture, stesso progetto, confrontare l'output di `plannedCostSchedule` costruito con `resources` risolte (`resolveResourceRates`) contro un fixture con `resources` grezze — il rapporto atteso è esattamente `hoursPerDay`; il test deve fallire se qualcuno inverte l'ordine.
- Confronto: un mese in baseline assente dal piano (delta negativo, `outOfBaselineHorizon: false`); un mese nel piano assente dalla baseline (`outOfBaselineHorizon: true`, `deltaPct: null`); una baseline esplicitamente a zero dentro l'orizzonte (delta = planned intero, `deltaPct: null`, ma **senza** il flag di fuori-orizzonte — i due casi non vanno confusi); un ri-congelamento con due righe sullo stesso `(projectId, period)` — il confronto deve usare quella con `frozenAt` più recente, mai la prima trovata.

**Seed fixture positiva — necessaria perché la non-regressione da sola non basta a dimostrare che il calcolo sia giusto** (la lezione ricorrente di questo progetto: un report che stampa zero perché nessun dato lo esercita, non perché il calcolo sia corretto). Aggiunte a `src/db/seed.ts`:
- **Request `'7'` + Assignment `'7'`**, resourceId `'2'` (John Miller, `costRate` override 720 EUR/GIORNO → risolto **90 EUR/ORA** con `hoursPerDay = 8`), projectId `'1'`, `startDate = endDate = '2026-10-05'` (un lunedì, non festivo, nessun'altra prenotazione di John in ottobre) — 8 ore assegnate, `allocationPct: 20`. `AssignmentDay`/`AssignmentMonth` derivati come per ogni altro assignment del seed (mese `'2026-10'`, stato `'Allocated'`). **Pianificato live atteso per il periodo `2026-10`: 8h × 90 EUR/h = 720 EUR esatti** — hand-verificabile.
- **`cost_baselines` `'CB1'`**: `projectId: '1'`, `period: '2026-10'`, `amount: 600`, `frozenAt` antecedente, `frozenBy: '4'` (Finance Controller). **Delta atteso: 720 − 600 = +120 EUR, deltaPct = +20.00%** — il progetto ha speso più del previsto quel mese, esattamente il caso che questo blocco deve segnalare.
- **`cost_baselines` `'CB2'`**: `projectId: '1'`, `period: '2026-11'`, `amount: 500`, nessun `AssignmentDay` di progetto `'1'` in novembre nel seed. **Delta atteso: 0 − 500 = −500 EUR, `deltaPct: null` (reso `—`)** — il caso "baseline congelata, piano che non la copre più" (descoping), senza bisogno di alcuna nuova prenotazione.
- **Gratis, dai dati di seed già esistenti:** gli assignment `'1'`/`'2'` del progetto `'1'` (maggio–agosto 2026) non hanno alcuna riga `cost_baselines` — esercitano il caso "`outOfBaselineHorizon: true`" per quei quattro mesi senza bisogno di alcuna nuova riga.

**Smoke** (`scripts/cost-baseline-impact.mjs`, dependency-free, modellato su `scripts/negotiated-rate-impact.mjs`): congela una baseline sul progetto fixture via `POST`, verifica che una seconda lettura restituisca esattamente le righe scritte (nessuna deriva), ricalcola il confronto e verifica il totale contro i valori attesi sopra (+120/+20% su ottobre, −500/`—` su novembre), verifica il rifiuto RBAC 403 per un ruolo `pm` su `POST /cost-baselines`. **Dichiarazione esplicita, sulla scia della lezione della spec sorella:** una tabella `cost_baselines` vuota che produce un confronto tutto a zero è vera per costruzione, non evidenza di correttezza — il gate reale è il caso non-nullo sopra, con un delta calcolabile a mano.

**Postgres fresco: obbligatorio.** C'è una migration nuova (`cost_baselines`, §3.3) con una FK verso `projects`; l'adapter in-memory non applica foreign key e non intercetterebbe un ordine di seed sbagliato — solo un avvio su database vuoto lo farebbe (lo stesso incidente già documentato in `bootstrap.ts` per `negotiated_rates`).

**Verifica in browser:** la griglia di stati di §8 (card assente, skeleton di caricamento, "Non disponibile" + retry, vuoto legittimo, pronto con numeri) su tutte e tre le superfici di §7; il confronto renderizzato normalmente per una sessione `pm` e per una `resource-manager` (§5); la card assente (non vuota, non a zero) per una sessione `employee` o `sales`; lo stato "Non disponibile" più retry per un errore di rete simulato su un ruolo autorizzato; il rendering `—` per un `deltaPct` nullo; il bottone "Freeze baseline" visibile solo per `finance`/`delivery-executive`/`admin`, assente (non disabilitato) per `pm`/`resource-manager`.

## 11. Cosa questo blocco NON fa

- **Solo costo del lavoro** (ore × `costRate` risolto), non `externalCost` — lo stesso perimetro di `plannedLaborCostForProject` oggi.
- **Nessuna conversione valutaria** — l'importo congelato è sempre EUR (valuta base), come ogni altro calcolo di costo in questo file.
- **La baseline non si sposta con una Change Request approvata** — resta pinnata all'originale (§3.4, §4); `effectiveBudgetForProject` continua a esistere e a rettificarsi con le CR esattamente come oggi, invariato da questo blocco. `Baseline` e `Budget` restano due numeri distinti sullo schermo, mai un sinonimo l'uno dell'altro.
- **Nessun freeze self-service per il PM** — solo `finance`/`delivery-executive`/`admin` possono congelare (§3.4, §5), e solo loro vedono la card (§5).
- **Nessuna colonna per-progetto nella tabella portafoglio del dashboard** (§7) — solo il totale aggregato.
- **Nessuna baseline in `contract-details.ts` o `financial-plans.ts`** in questo blocco (§7).
- **Nessun allarme automatico** sulla soglia di sforamento — il confronto è un dato mostrato, non ancora un trigger per gli alert esistenti di `reporting.ts`.
- **Nessuna `PUT`/`DELETE` esposta** su `/cost-baselines` — solo `GET` e `POST` (il ri-congelamento, §3.4).
