# Design — Commesse BASKET, non fatturabile e assenze (Blocco H)

- **Data:** 2026-08-06
- **Stato:** Design da rivedere (spec review + review utente). Contiene **5 domande di prodotto aperte** (§10) che muovono numeri visibili o toccano la privacy: non sono decise qui.
- **Origine:** allineamento al Lutech RPT — `docs/rpt-comparison.md` §3.6, righe 54-55 della matrice e il riquadro immediatamente sotto. È l'unico gap della comparazione classificato **bloccante perché rende falsa una metrica già a schermo**, non perché manchi una feature.
- **Riferimenti:** `docs/superpowers/specs/2026-08-04-f-bench-availability-design.md` (il bench/unchargeable che questo blocco corregge); `2026-08-02-c1-dummy-subco-multi-fte-design.md` (il pattern `notNull().default(...)` senza backfill, e la lezione delle quattro superfici dimenticate); `2026-08-03-c2-dummy-substitution-design.md` (la lezione dello sweep: la domanda giusta è «cosa CREO che altri leggeranno»); `2026-08-04-e-pcp-baseline-design.md` (i cost baseline, che questo blocco riusa per i piani annuali dei basket); `docs/roles-and-permissions.md` (i 7 ruoli e le tabelle RBAC citate al §7).

---

## 1. Il problema, con la conseguenza numerica dichiarata

### 1.1 Cosa ha RPT e noi no

Il manuale RPT (§1.3, §8.5) definisce le **commesse BASKET**: commesse dedicate, censite solo in RPT e non nel gestionale (PCP/InforLN), usate per lo staffing quando non esiste una commessa vera. Una per Practice. Il manuale ne elenca sei casi d'uso: **maternità e congedi parentali, ferie, AMS, gruppi tecnici, malattia, indisposizione**. Per SW Factory / AMS / GCC coprono anche piani annuali su base storica.

Noi non abbiamo nulla di equivalente, verificato a codice:

- **`projects` non ha né `type` né `billable` né alcun flag di fatturabilità.** Le colonne sono `id, name, location, startDate, endDate, status, description, ownerId, contractId` (`src/db/schema.ts:535-552`), e l'interfaccia client corrispondente è identica (`src/app/services/api.service.ts:543-553`). La `pick()` allow-list del server è `PROJECT_FIELDS = ['name','location','startDate','endDate','status','description','ownerId','contractId']` (`src/server.ts:4751`): non c'è nessun campo che possa esprimere «questa commessa non fattura».
- **Nessuna tabella di assenze.** Grep su `absence|leave|vacation|maternity|sickness` in `src/db/schema.ts` e `src/db/seed.ts` non produce nessun match che sia un concetto di dominio (i soli hit sono la parola inglese «leave» in commenti su altro).

### 1.2 La metrica falsa, con la riga

Il blocco F ha introdotto la tricotomia BENCH/PARTIAL/ALLOCATED (`src/app/services/bench.util.ts:25-29`) e l'anzianità B/C/D (`:43-54`). La classificazione è:

```ts
export function benchStateFor(plannedHours: number, targetHours: number): BenchState {
  if (plannedHours === 0) return 'BENCH';
  ...
}
```

Una persona in maternità, in congedo parentale o in ferie per un mese intero **non ha ore prenotate**: `plannedHours === 0`, quindi `state === 'BENCH'`. `benchRollup` (`bench.util.ts:175-238`) le costruisce `benchFlags` a `true` per quel mese (`:209`) e `monthsIdleAt` (`:43-47`) conta quel mese come mese di inattività consecutiva. Conseguenze **oggi, su dati veri**:

| Superficie | Numero falso |
|---|---|
| `dashboard.component.ts:1020,1023` — tile "In bench" | conteggia in bench chi è in maternità/ferie: **sovrastima l'inattività** |
| `bench.component.ts:232-237` — le due "% on bench" | numeratore gonfiato dagli assenti |
| `bench.util.ts:50-54` — bucket C (1-2 mesi) e D (oltre 2 mesi) | **si popolano di casi che non sono problemi di delivery**: un congedo di 5 mesi produce un D indistinguibile da una persona che nessuno riesce a staffare |
| `bench.util.ts:83-91` — `availabilityDateFor` | regola 1: «prima cella mostrata BENCH → disponibile *oggi*». Una persona in congedo risulta **disponibile oggi**: il pianificatore prova a staffarla |
| `bench.util.ts:259-270` — `notFullyAllocatedAt`, letta da `forecast.ts:576` e `what-if.ts:611,614` | il pannello "available for reallocation" **la elenca fra i riallocabili** |
| `capacity.util.ts:183` — `t.capacityFte += fteOf(employedDays.length * hoursPerDay, target)` | una persona assente per tutto il mese contribuisce **un FTE intero di capacità**: `/capacity` pubblicizza capacità che l'API rifiuterebbe di prenotare |
| `capacity.util.ts:174-175` — `targetHours: target` (mese intero) + `band: semaphoreBand(ftePlanned*100)` | chi lavora a pieno regime nei 5 giorni in cui è presente su 22 legge `ftePlanned ≈ 23%` → banda **`idle`** |

Il commento già presente in `capacity.util.ts:98-100` descrive **esattamente questo difetto** con un'altra causa (il cessato a metà mese): «*someone who left on the 15th still contributed one whole FTE of supply. The screen then advertised free capacity that the API refuses to book*». L'assenza è la stessa forma di errore con un'altra origine, e la correzione deve avere la stessa forma o le due schermate si contraddicono.

### 1.3 La seconda metrica falsa, che il riquadro RPT non nomina

AMS, gruppi tecnici, SW Factory, GCC sono commesse vere. Nel nostro modello **esistono già** come `projects` — sono solo commesse i cui costi non hanno un ricavo cliente corrispondente. Oggi, per una di queste, `computeProjectFinancials` (`finance.util.ts:365-404`) calcola `revenue = 0` (nessuna riga d'ordine, nessun billing item), `margin = 0 − actualCost = −actualCost`, e quel numero entra in:

- `projectAlerts` / `portfolioAlerts` / `marginCompressionAlerts` (`finance.util.ts:1088, 1124, 1685`) → **allarme di margine sotto target su una commessa che non ha mai avuto un target di margine**;
- `customerProfitability` (`:1505-1537`) → il progetto non ha `contractId`, quindi cade sotto il cliente sintetico `'unknown'` (`:1513`): una **riga cliente permanentemente in perdita** che in realtà è lavoro interno;
- `realizationMetrics` (`:1439-1467`) → `revenue / standardBillValue` con numeratore 0 e denominatore positivo (ore approvate × billRate) = **realization 0%**, che trascina qualunque media di portafoglio;
- `resourceBillability` (`:417-423`) → somma `assignedHours` su **tutti** gli incarichi della persona × `billRate`: le ore su una commessa non fatturabile sono contate come **valore fatturabile**. Reso a `resources.component.ts:370`.

Quindi il gap ha **due conseguenze numeriche distinte**, non una. È il fatto che decide il modello dati (§2).

---

## 2. La decisione di modellazione: due entità, non una

**Decisione: due entità separate.**

1. **`projects.billable` (+ `projects.type`)** — copre AMS, gruppi tecnici, SW Factory, GCC. Sono commesse, restano commesse, guadagnano un campo che dice la verità: *consuma costo, non produce ricavo cliente*.
2. **`resourceAbsences`** — tabella per-risorsa con intervallo di date e causale. Copre maternità, congedi parentali, ferie, malattia, indisposizione. **Non** è un progetto, **non** è un incarico, **non** passa da un'approvazione di allocazione, **non** ha un cliente.

### 2.1 Il perché decisivo

Le due metà di "BASKET" correggono **due numeri falsi diversi**, e ciascuna delle due può correggere solo il proprio:

- Una persona a tempo pieno su AMS **è già allocata**: ha ore prenotate su un progetto vero, quindi `benchStateFor` la classifica ALLOCATED. Il bench per lei **non è sbagliato**. Ciò che è sbagliato è il **margine** della sua commessa. Il flag `billable` corregge quello.
- Una persona in maternità **non ha ore prenotate**: il bench per lei è sbagliato, e il margine non c'entra nulla. La tabella assenze corregge quello.

Un modello unico costringerebbe una delle due a essere rappresentata in un modo che non può correggere il proprio numero. Questo è il criterio: **conseguenze, non eleganza.**

### 2.2 Alternativa scartata A — una sola entità: tutto come progetto non fatturabile

Modellare anche le assenze come RPT le modella: una commessa `BASKET — Ferie` per Practice, e l'assenza è un'assegnazione su quella commessa. Cosa si rompe:

1. **La privacy diventa strutturalmente impossibile.** Un'assegnazione è leggibile da tutta l'audience della READ_RULE `/assignments`: `pm, resource-manager, delivery-executive, finance, admin` (`src/server.ts:810`). Il dato sensibile **è** il riferimento al progetto: «Julie Armstrong → BASKET Maternità» è un dato di salute/famiglia (GDPR art. 9) visibile a ogni PM dell'organizzazione, e compare in `/capacity`, `/bench`, negli export CSV e nel feed di approvazione B3. **Non esiste una colonna da redigere**, perché l'informazione è la relazione. L'unica mitigazione — un unico progetto generico «BASKET — Assenza» — distrugge la distinzione stessa che il reporting richiede. Questo argomento, da solo, chiude l'alternativa.
2. **Inquinamento del workflow di approvazione.** Un'assegnazione genera `assignmentDays` + `assignmentMonths` con stato `Draft/Requested/Allocated/Rejected` e una `approvalRequest` per mese (B1/B3). Registrare una maternità creerebbe un'approvazione di allocazione che il People Manager deve *approvare*. Una maternità non è approvabile dal delivery management: è un fatto HR. E il feed `/allocation-approvals` si riempirebbe di righe di ferie.
3. **Il verso dell'errore sulla scrittura è quello sbagliato.** Il gate giornaliero (`dailyCapFor('internal', base)` = `contractHoursPerDay`, `resource-kind.util.ts:63-66`) e `bookingOutsideEmploymentError` (`src/server/operational-integrity.util.ts:580`) si applicherebbero: registrare un'assenza retroattiva su un giorno **già prenotato** verrebbe **rifiutata** dal gate di scrittura. Ma l'assenza è un fatto già avvenuto: rifiutarla è il verso sbagliato (§6.4 fissa l'asimmetria corretta).
4. **Inquinamento del margine.** Il progetto-ferie porta `plannedLaborCost`/`actualLaborCost` reali: ogni giorno di ferie diventa una riga di «commessa in perdita» in `projectAlerts` e in `customerProfitability`. Si sposterebbe il difetto del §1.2 sul difetto del §1.3, invece di correggerne entrambi.

### 2.3 Alternativa scartata B — una sola entità: solo la tabella assenze, nessun campo su `projects`

Le commesse AMS/gruppi tecnici hanno bisogno di un progetto contro cui prenotare (`assignments → requests → projects`), un PM, un owner. **Nel nostro modello sono già progetti.** L'unica cosa che manca è il campo che dice «non aspettarti ricavo». Senza quel campo il difetto del §1.3 resta intero: ogni commessa interna continua a comparire come perdita in tre superfici finanziarie. Le assenze da sole non possono coprire il caso B.

### 2.4 Alternativa scartata C — `billable` derivato invece che persistito

«Un progetto è non fatturabile se non ha `contractId`». Si rompe subito: `validateProjectContract` (`src/server.ts:4759-4763`) dichiara `contractId` **opzionale** e il commento dice esplicitamente «*an internal project has none*» — quindi oggi esistono, legittimamente, progetti fatturabili in attesa di contratto e progetti mai contrattualizzati, indistinguibili. Derivare la fatturabilità da un'assenza di FK renderebbe non fatturabile ogni progetto creato prima della firma, cioè spegnerebbe gli allarmi di margine proprio nella fase in cui servono. Il flag deve essere una **dichiarazione**, non un'inferenza.

### 2.5 Cosa NON è una terza entità

I «piani annuali su base storica» che il manuale chiede per SW Factory / AMS / GCC **sono già coperti**: `costBaselines` (blocco E, `schema.ts` via migration `0018`, `finance.util.ts:244-273`) congela un importo di costo per (progetto, mese) e lo confronta con il piano vivo. Appena una commessa basket può esistere come progetto, il piano annuale è `costBaselines` sui suoi 12 mesi. Nessuna struttura nuova. Questa spec **mantiene deliberatamente attivi** `plannedCostSchedule` e `costBaselineComparison` sulle commesse non fatturabili (§5, riga finance-4) — è l'unico punto in cui la correzione «escludi il non fatturabile» sarebbe una sovra-correzione.

---

## 3. Schema, tipi, migrazione

### 3.1 Proprietà esclusiva della migrazione `0019`

Le migrazioni in `drizzle/` sono numerate in sequenza; l'ultima è `0018_lowly_lady_bullseye.sql`. Due branch che ne generano una collidono su file e su `drizzle/meta/_journal.json`. **Questo blocco dichiara la proprietà esclusiva di `0019`.** Nessun altro blocco in corso può generarne una: i branch attivi verificati (bench/disallocazione, export, staffing, allocation-approvals, rate-card inheritance, ricerca a faccette) sono tutti pura derivazione o modifiche a file TS. Se all'implementazione `0019` risulta occupata, questo blocco **rinumera la propria**, mai il contrario.

### 3.2 `projects`: due colonne additive, nessun backfill

```ts
// src/db/schema.ts, dentro pgTable('projects', { ... })
// H — commesse non fatturabili. `notNull().default(...)` è lo STESSO pattern di
// `resources.kind` (C1, migration 0011): ogni riga preesistente diventa una
// commessa di delivery fatturabile, che è esattamente ciò che è — quindi la
// migrazione non ha bisogno di alcun backfill.
billable: boolean('billable').notNull().default(true),
type: text('type').$type<ProjectType>().notNull().default('Delivery'),
```

```sql
-- drizzle/0019_<name>.sql
ALTER TABLE "projects" ADD COLUMN "billable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "type" text DEFAULT 'Delivery' NOT NULL;
```

`ProjectType = 'Delivery' | 'Basket'`. **`billable` è l'unico dei due che l'aritmetica legge; `type` è un'etichetta.** Motivo: un'unica fonte di verità per la fatturabilità (due campi che possono contraddirsi obbligano ogni consumatore a scegliere quale credere), più un'etichetta che serve al wizard RPT (riga 55) e al reporting «un basket per Practice» — una selezione che non può essere «qualunque progetto non fatturabile», perché esistono progetti interni non-basket.

**Invariante enforced server-side (§6.2):** `type === 'Basket'` ⇒ `billable === false`. Il verso opposto resta libero: `billable === false` con `type === 'Delivery'` è legittimo (progetto interno non basket).

### 3.3 `resourceAbsences`: tabella nuova

```ts
export const resourceAbsences = pgTable(
  'resource_absences',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id').notNull().references(() => resources.id),
    // ISO YYYY-MM-DD, entrambe INCLUSIVE. Un'assenza di un giorno ha start === end.
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    // Dato sensibile (§7.3). L'aritmetica NON si dirama MAI su questo campo — vedi
    // il vincolo al §3.4, che è ciò che rende sufficiente la proiezione redatta.
    reasonCode: text('reason_code').$type<AbsenceReasonCode>().notNull(),
    note: text('note'),
    // SERVER-PINNED, mai dal body: stessa classe di `createdBy`/`requestedBy`.
    recordedBy: text('recorded_by').notNull(),
    recordedAt: text('recorded_at').notNull(),
  },
  (t) => [
    index('resource_absences_resource_id_idx').on(t.resourceId),
    // La query calda è «le assenze di questa risorsa che intersecano [from,to]»:
    // stessa forma dell'indice composito (project_id, period) di cost_baselines.
    index('resource_absences_resource_start_idx').on(t.resourceId, t.startDate),
  ],
);
```

```ts
export const ABSENCE_REASON_CODES = [
  'Maternity', 'ParentalLeave', 'Vacation', 'Sickness', 'Indisposition', 'Other',
] as const;
export type AbsenceReasonCode = typeof ABSENCE_REASON_CODES[number];
```

Le sei causali sono **le sei del manuale** (§1.3), non un insieme inventato: maternità, congedi parentali, ferie, malattia, indisposizione, più `Other` come valvola. `AMS` e `gruppi tecnici` **non** sono causali di assenza — sono commesse (§2.1), ed è il criterio che tiene le due entità separate anche a livello di enum.

`note` è nullable, quindi passa da `nullsToUndefined()` sul ritorno; **mai** su un valore passato a `.set()` (`src/db/repository.ts`). Una patch tutta-`undefined` su `PUT /absences/:id` è cortocircuitata dalla parità già esistente in `PgRepository.update()`.

### 3.4 Il vincolo che rende possibile la privacy

**L'aritmetica non si dirama mai su `reasonCode`.** Ogni funzione di questo blocco (§4) consuma solo `resourceId`, `startDate`, `endDate`. Conseguenza diretta e voluta: la proiezione **redatta** delle assenze (senza `reasonCode`, senza `note`) è **numericamente completa** — basta a produrre ogni cifra di `/bench`, `/capacity`, `/forecast`, `/utilization`, `/dashboard`. Questo è ciò che rende la separazione delle audience (§7.3) implementabile e non un desiderio.

> **Questo vincolo è accoppiato alla domanda aperta Q1 (§10).** Se la politica di anzianità dovesse dipendere dalla *causale* (ferie ≠ maternità) invece che dalla *durata*, `reasonCode` entrerebbe nell'aritmetica e la proiezione redatta diventerebbe insufficiente: dovrebbe portare una classe grossolana («breve»/«lunga») al posto della causale. È l'unico modo in cui Q1 può muovere lo schema, e va deciso **prima** di T5.

### 3.5 Interfacce client e wiring dei repository

- `src/app/services/api.service.ts`: `Project` guadagna `billable: boolean` e `type: ProjectType`; nuova `ResourceAbsence` (campi come sopra) e `RedactedAbsence = Pick<ResourceAbsence,'id'|'resourceId'|'startDate'|'endDate'>`. **`RedactedAbsence` è un tipo separato, non `Partial<ResourceAbsence>`**: un `Partial` renderebbe `reasonCode` opzionale e non impedirebbe a nessuno di popolarlo per sbaglio sul percorso redatto.
- `src/db/repositories.ts`: `resourceAbsences: Repository<ResourceAbsence>` nell'interfaccia (~`:331`), `pg<ResourceAbsence>(schema.resourceAbsences)` (~`:414`), `mem<ResourceAbsence>(seed.resourceAbsences)` (~`:484`) — le tre righe che ogni collezione ha.
- `src/db/bootstrap.ts`: `await seedIfEmpty(database, schema.resourceAbsences, seed.resourceAbsences); // -> resources`, **dopo** `resources` (FK, parent-before-child), sullo stesso modello di `:215`.
- **Nessun `any` al confine.** `ResourceAbsence` è completamente tipizzata; nessun cast Drizzle nuovo è richiesto (nessuna colonna `jsonb`, nessuna chiave naturale).

---

## 4. Il layer puro

### 4.1 `src/app/services/absence.util.ts` (nuovo file — zero collisione di merge)

File nuovo, deliberatamente: `bench.util.ts` e `capacity.util.ts` sono toccati in parallelo da un altro branch, e mettere la nuova aritmetica in un file nuovo riduce la superficie di conflitto a due punti di chiamata invece di un blocco.

```ts
export interface AbsenceInterval { resourceId: string; startDate: string; endDate: string; }

/** I giorni di calendario ISO coperti da un'assenza per questa risorsa. Set, non
 *  array: due assenze sovrapposte (rifiutate in scrittura, §6.4, ma non
 *  impossibili su dati importati) non devono sottrarre due volte lo stesso giorno. */
export function absenceDaysFor(
  resourceId: string, absences: readonly AbsenceInterval[], days: readonly string[],
): ReadonlySet<string>;

/** I giorni lavorativi del mese in cui la persona era impiegata E non assente:
 *  `employedWorkingDays(...)` meno `absenceDaysFor(...)`. */
export function availableWorkingDays(
  r: { hireDate?: string; terminationDate?: string },
  month: string, holidays: ReadonlySet<string>,
  resourceId: string, absences: readonly AbsenceInterval[],
): string[];

/** Copertura del mese, per la politica di anzianità e per lo stato ABSENT. */
export type MonthAvailability = 'available' | 'partly-absent' | 'fully-absent' | 'not-employed';
export function monthAvailability(
  employedDays: readonly string[], availableDays: readonly string[],
): MonthAvailability;
```

**`employedWorkingDays` (`capacity.util.ts:102-110`) NON viene modificata.** Risponde a «era impiegata», che un'assenza non cambia; è condivisa con `forecast.util.ts`, `bench.util.ts` e il gate di scrittura del server (`bookingOutsideEmploymentError`). Iniettarci l'assenza cambierebbe silenziosamente il significato di «impiegata» in quattro posti, uno dei quali decide se una prenotazione è accettata. `availableWorkingDays` è un **sibling**, non un override.

### 4.2 La politica di anzianità, isolata in una funzione sola

`monthsIdleAt` (`bench.util.ts:43-47`) cammina su `boolean[]` e si ferma al primo `false`. Con le assenze la sequenza diventa **a tre valori** — bench / non-bench / assente — e la domanda «un mese di assenza spezza la serie o è trasparente?» è una **domanda di prodotto aperta** (Q1, §10) con conseguenze numeriche opposte.

**Decisione di ingegneria, non di prodotto:** la politica vive in **una funzione pura sola**, così rispondere a Q1 è una modifica di una riga e non un refactor.

```ts
export type IdleFlag = 'idle' | 'busy' | 'absent';
/** Come un mese 'absent' si comporta nel cammino a ritroso di monthsIdleAt.
 *  'transparent' = salta il mese senza interrompere né incrementare;
 *  'break'       = interrompe la serie, come un mese 'busy'. */
export function absenceStreakPolicy(run: readonly IdleFlag[], at: number): 'transparent' | 'break';
```

e `monthsIdleAt(flags: readonly IdleFlag[], index: number)` la interroga. Il default **da implementare se Q1 non riceve risposta** è `'transparent'` — perché è il ramo che non introduce un secondo modo di sparire dal bench: `'break'` fa ripartire da B una persona ferma da gennaio solo perché ha preso una settimana di ferie ad agosto, cioè risolve un'inflazione di C/D creando una deflazione. Il default è dichiarato, non nascosto, e resta subordinato alla risposta.

### 4.3 `bench.util.ts`: `BenchState` guadagna `ABSENT`

```ts
export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED' | 'ABSENT';
```

Un quarto stato, non un flag a fianco. Motivo: ogni consumatore esistente filtra su `state === 'BENCH'` (`dashboard.component.ts:1020,1023`; `bench.component.ts:232,236`) o su `state !== 'ALLOCATED'` (`bench.util.ts:269`). Con un quarto valore di stato i primi si correggono **da soli** (un ABSENT non è più BENCH: è la correzione headline) e i secondi restano da correggere a mano — ed è meglio così, perché `notFullyAllocatedAt` va corretta esplicitamente: `state !== 'ALLOCATED'` include `'ABSENT'`, e sarebbe **esattamente il difetto** (elencare fra i riallocabili chi è in congedo). Un flag booleano a fianco dello stato avrebbe lasciato entrambi i gruppi silenziosamente invariati: quattro superfici verdi e sbagliate, la firma esatta di C1.

`ABSENT` è assegnato **solo** quando `monthAvailability === 'fully-absent'`. Un mese parzialmente assente resta BENCH/PARTIAL/ALLOCATED, calcolato su un **target pro-ratato** (§4.4): chi è presente 5 giorni su 22 e non ha prenotazioni **è** bench per quei 5 giorni — non un caso da nascondere.

### 4.4 Il target pro-ratato

Oggi `benchStateFor` e le celle di `rollupMonthly` usano `standardMonthlyHours(month, hoursPerDay, holidays)` — il mese intero (`capacity.util.ts:40-42`, chiamata a `:147` e `bench.util.ts:178`). Diventa:

```
availableTargetHours(month) = availableWorkingDays(...).length × (r.contractHoursPerDay ?? hoursPerDay)
```

che è la **stessa forma** già usata per la capacità pro-ratata dei giorni impiegati (`capacity.util.ts:183`, il cui commento a `:181-182` dice «*monthlyTargetHours is workingDays × contractHoursPerDay, so the pro-rated form is the same product over the employed subset*»). Non è una nuova convenzione: è la convenzione esistente estesa da «impiegata» a «disponibile».

`benchStateFor(0, 0)` — mese interamente assente — restituirebbe `'BENCH'`. **Non viene mai chiamata in quel caso**: il ramo `fully-absent` produce `'ABSENT'` prima. Questa è la guardia che va pinnata da un test dedicato (§8), perché è l'unico punto in cui la vecchia funzione, invariata, darebbe la risposta falsa.

---

## 5. Lo sweep dei consumatori

Le lezioni di C1, C2 e D sono la stessa: la regola nuova era corretta, ma **una superficie che nessuno possedeva conservava il vecchio comportamento**, e i test restavano verdi. In C1 furono quattro superfici; in C2 uno sweep di 47 consumatori concluse «0 superfici da cambiare» e la review finale trovò poi un difetto vero, perché la domanda giusta non era «chi legge i dati che tocco» ma **«cosa CREO che altre superfici leggeranno»**.

**62 superfici enumerate**: **42 cambiano** (35 consumatori + 7 produttori) e **20 sono verdetti espliciti di non-modifica** — elencati uno per uno, perché un non-verdetto è esattamente come sono nate le quattro superfici dimenticate di C1. I 20 «non tocca» sono la parte di questa sezione che costa meno scrivere e che, mancando, costa di più.

### 5.1 Bench / unchargeable — la metrica falsa

| # | File · riga | Cosa fa oggi | Cosa deve fare |
|---|---|---|---|
| B1 | `bench.util.ts:17` `BenchState` | 3 stati | 4 stati, `+ 'ABSENT'` (§4.3) |
| B2 | `bench.util.ts:25-29` `benchStateFor` | classifica su target del mese intero | invariata come **funzione**; il chiamante le passa il target **pro-ratato** (§4.4). Mai invocata su un mese `fully-absent` |
| B3 | `bench.util.ts:43-47` `monthsIdleAt` | cammina su `boolean[]` | cammina su `IdleFlag[]`, interroga `absenceStreakPolicy` (§4.2) |
| B4 | `bench.util.ts:50-54` `bucketForMonthsIdle` | B/C/D da un intero | **non tocca** — il conteggio cambia, la classificazione no |
| B5 | `bench.util.ts:65-70` `freeingUpNextMonth` | `stateThis !== 'BENCH' && activeNext && stateNext === 'BENCH'` | chi va in congedo il mese prossimo **non** è «freeing up»: cade da sé se `stateNext === 'ABSENT'` (≠ `'BENCH'`). Chi **rientra** da un congedo in un mese BENCH **sì** — è corretto e desiderato. Va **asserito in entrambi i versi**, non dedotto |
| B6 | `bench.util.ts:83-91` `availabilityDateFor` | ramo 1: prima cella BENCH → `today` | un mese `ABSENT` non è mai una data di disponibilità; la prima cella BENCH cercata a `:88` **salta** gli ABSENT. È la falsità più visibile all'utente: una tabella che dichiara disponibile oggi chi è in maternità |
| B7 | `bench.util.ts:93-130` `hiringDemandByMonth` | solo dummy, per `role` | **non tocca.** Un dummy non ha assenze. Ma va detto: un dummy prenotato su una commessa **non fatturabile** (AMS) resta in hiring demand — serve assumere anche per l'AMS |
| B8 | `bench.util.ts:132-136` `BenchCell` | `state`, `agingBucket?`, `upcomingUnallocated` | invariata di forma; `agingBucket` resta presente **solo** se `state === 'BENCH'`, quindi **assente** su ABSENT |
| B9 | `bench.util.ts:148` `EMPTY_BENCH_ROLLUP` | default vuoto | se `BenchRollup` guadagna un campo (Q3: conteggio assenti), va esteso o il default vuoto divergerà dalla forma reale — divergenza che nessun test tipizzato cattura, perché è un letterale conforme al tipo vecchio |
| B10 | `bench.util.ts:150-159` `BenchRollupInput` | estende `RollupInput` | guadagna `absences: readonly AbsenceInterval[]` |
| B11 | `bench.util.ts:175-238` `benchRollup` | `activeOf`/`stateOf` su `employedWorkingDays` (`:200`), `benchFlags` (`:209`) | usa `availableWorkingDays`; `benchFlags` diventa `IdleFlag[]`; il gate `displayMonths.some(m => activeOf.get(m))` (`:207`) **resta su employed** — una persona assente per tutti i 6 mesi deve avere una riga (ABSENT), non sparire: sparire la rimetterebbe fra i «dati mancanti» |
| B12 | `bench.util.ts:259-270` `notFullyAllocatedAt` | filtra `state !== 'ALLOCATED'` | **filtra anche `!== 'ABSENT'`.** Senza questa riga il pannello "available for reallocation" di `/forecast` e `/what-if` continua a elencare chi è in congedo: il difetto sopravvive in due schermate mentre `/bench` è corretto |

### 5.2 Capacity — i denominatori FTE e il semaforo

| # | File · riga | Cosa fa oggi | Cosa deve fare |
|---|---|---|---|
| C1 | `capacity.util.ts:30-35` `RollupInput` | 7 campi | `+ absences`. **Trappola dichiarata:** un campo opzionale con default `[]` mantiene verdi tutte le fixture esistenti esercitando zero righe nuove (§8.2) |
| C2 | `capacity.util.ts:102-110` `employedWorkingDays` | giorni impiegati | **non tocca** (§4.1) |
| C3 | `capacity.util.ts:75-80` `isActiveInMonth` | gate grossolano mese | **non tocca.** Unico chiamante residuo `forecast.util.ts` (vedi F1) |
| C4 | `capacity.util.ts:118-142` `hoursByResourceMonth` | somma ore prenotate | **non tocca.** Un'assenza non prenota ore |
| C5 | `capacity.util.ts:174,188` celle `targetHours` | target del mese intero | target **pro-ratato ai giorni disponibili**. Cambia ogni percentuale di `/capacity` per chi ha un'assenza: chi lavora a pieno regime nei giorni in cui è presente legge ~100%, non ~23% (§1.2) |
| C6 | `capacity.util.ts:183` `t.capacityFte` | `employedDays.length × hoursPerDay` | `availableDays.length × hoursPerDay`. **Risposta esplicita a «capacità zero o capacità piena non usata»: ZERO.** Stesso argomento del commento `:98-100` sul cessato — capacità che l'API rifiuterebbe di prenotare non è capacità |
| C7 | `capacity.util.ts:184` `t.resourceCount` | +1 per interno impiegato | **non tocca**: un assente è headcount (è impiegato). `capacityFte` scende, `resourceCount` no — è la differenza che rende leggibile «quante persone abbiamo» vs «quanta capacità abbiamo» |
| C8 | `capacity.util.ts:46-52` `semaphoreBand` | bande su percentuale | **non tocca** come funzione; il suo input cambia via C5 |
| C9 | `capacity.util.ts:162-167` `employedDays.length === 0 → continue` | salta la cella | **non tocca**: resta il gate di impiego. Un mese interamente assente **non** viene saltato — ha una cella con `capacityFte` 0 e target 0 |
| C10 | `capacity.util.ts:190` `t.demandFteUncovered` | dummy/subco | **non tocca**: i dummy non hanno assenze; un subco sì, e la sua domanda scoperta è calcolata sulle ore prenotate, non sul target |

### 5.3 Finance — il margine non deve leggere una commessa non fatturabile come perdita

| # | File · riga | Cosa fa oggi | Cosa deve fare |
|---|---|---|---|
| F-1 | `finance.util.ts:31` `FinanceData.projects` | commento: «*used only to label portfolio-level alert rows*» | il commento diventa **falso**: `projects` diventa load-bearing per la fatturabilità. **Trappola dichiarata:** un chiamante che omette `projects` legge tutto come fatturabile (`?? true`), cioè il comportamento di oggi, cioè ogni test esistente resta verde (§8.2) |
| F-2 | `finance.util.ts:365-404` `computeProjectFinancials` | `margin = revenue − actualCost` | `ProjectFinancials` guadagna `billable: boolean`, risolto da `d.projects`. **L'aritmetica non cambia**: il costo è reale e deve restare visibile. Cambia **chi consuma** quel margine |
| F-3 | `finance.util.ts:1088,1124,1685` `projectAlerts`/`portfolioAlerts`/`marginCompressionAlerts` | allarme margine sotto target | **non emettono allarme di margine** su un progetto non fatturabile. È la traduzione letterale del requisito «il margine non deve leggerla come progetto in perdita». Gli allarmi di **burn/budget** restano: una commessa basket ha un budget e può sfondarlo |
| F-4 | `finance.util.ts:174-207,244-273` `plannedCostSchedule`/`costBaselineComparison` | costo mensile per progetto | **non tocca — deliberatamente.** È il punto in cui il non fatturabile **deve** funzionare: sono i piani annuali su base storica del manuale (§2.5). «Escludi il non fatturabile da tutta la finanza» è la sovra-correzione tentante |
| F-5 | `finance.util.ts:1505-1537` `customerProfitability` | progetto senza contratto → cliente `'unknown'` (`:1513`) | **esclude i progetti non fatturabili.** Oggi generano una riga cliente `Unknown` permanentemente in perdita che in realtà è lavoro interno |
| F-6 | `finance.util.ts:1564-1599` `customerConcentration` | su `customerProfitability` | segue F-5 per costruzione; **da asserire**, non da assumere (il denominatore `totalRevenue` cambia) |
| F-7 | `finance.util.ts:1439-1467` `realizationMetrics` | `revenue / standardBillValue` | su non fatturabile: numeratore 0, denominatore positivo → **realization 0%** che trascina ogni media. Escluso dal reporting di realization; `revenuePerFte`/`revenuePerHead` idem |
| F-8 | `finance.util.ts:417-423` `resourceBillability` | `Σ assignedHours × billRate` su **tutti** gli incarichi | **esclude gli incarichi il cui `request.projectId` è un progetto non fatturabile.** Superficie non nominata dal brief e trovata dallo sweep: oggi le ore su una commessa interna sono contate come valore fatturabile. Richiede il join `assignments → requests → projects`, entrambi già su `FinanceData`. Il commento a `:407-416` (che difende l'uso del `billRate` di riferimento) **resta valido**: è una questione diversa |
| F-9 | `finance.util.ts:1179-1252` `portfolioTotalsInBase` | totali di portafoglio | **domanda di prodotto aperta Q2** (§10): il margine di portafoglio include il costo del lavoro interno? Muove la % di margine di portafoglio in entrambi i versi |
| F-10 | `finance.util.ts:863+` `recognitionSchedule` | riconoscimento per periodo | non ha nulla da escludere **se** nessun billing item può esistere su un progetto non fatturabile — che è esattamente ciò che i due gate di scrittura del §6.3 garantiscono. **Il gate va sul write, non qui**: mettere il filtro qui lascerebbe le righe a database, visibili in `/commercial/billing`, e invisibili solo nel riconoscimento |
| F-11 | `finance.util.ts:1329-1391` `recognitionJournal`/`journalTotals` | scritture GL | segue F-10 per costruzione (nessun item = nessuna scrittura). Verdetto di non-modifica **esplicito** |
| F-12 | `finance.util.ts:458-527` `billedToDate`/`recognizedRevenue`/`unbilledWip`/`deferredRevenue` | rollup su billing items | idem F-11: non-modifica **conseguenza** del gate di scrittura, non una scelta indipendente |
| F-13 | `finance.util.ts:622-694` `arAging`/`arAgingByCustomer` | A/R su billing items | non-modifica, stessa catena |

### 5.4 Utilizzo, reporting, forecast, dashboard

| # | File · riga | Cosa fa oggi | Cosa deve fare |
|---|---|---|---|
| U1 | `utilization.component.ts:516-520` `benchBadge` | 3 esiti: dummy → `'Not applicable'`, riga → stato, nessuna riga → `''` | **quarto esito `ABSENT`.** Punto critico: oggi `''` significa «non attiva nella finestra». Un assente **è** attivo, quindi deve rendere `ABSENT`, mai `''` — altrimenti si legge come «dato mancante», che è il difetto che il commento a `:514-524` si dà cura di evitare per gli altri casi |
| U2 | `utilization.component.ts:578-586` `countedForAverage`/`averageUtilization` | media dello scalare `utilization`, solo internal | una persona in congedo ha `utilization: 0` e abbassa la media di squadra. `benchRollup` **è già** una gamba required del forkJoin (`:462`), quindi lo stato ABSENT è disponibile senza nuove fetch. Correzione: escludere gli ABSENT del mese corrente dal **denominatore** |
| U3 | `utilization.component.ts:588-589` `hasUncountedRows` | avviso «righe non contate» | deve coprire anche le righe escluse per assenza, o la didascalia sotto-dichiara cosa la media omette |
| U4 | `reporting.ts:1325-1340` `utilizationData`/`utilizationChart*` | barra per persona, internal only | un assente mostra una barra a 0% **visivamente identica** a «ferma e nessuno l'ha staffata». Va marcata distintamente o esclusa (Q4, §10 — è un cambio visibile) |
| U5 | `reporting.ts:260` didascalia del grafico | «*dummy and subco are uncovered demand, not capacity*» | deve dichiarare anche il trattamento degli assenti, o resta una spiegazione incompleta di ciò che il grafico omette |
| U6 | `reporting.ts:1178-1197` `internalResources` + media org-wide | media su `utilization` | stessa correzione di U2, altra superficie: è la coppia esatta che C1 ha già dovuto correggere due volte |
| U7 | `dashboard.component.ts:1020` `internalBenchCount` | `state === 'BENCH'` | **si corregge da sé** con il quarto stato — è la correzione headline. **Va asserito**, non dedotto: un ABSENT non deve comparire nella tile |
| U8 | `dashboard.component.ts:1023` `subcoBenchCount` | idem | idem. Un subco può essere assente (malattia): il caso non è teorico |
| U9 | `dashboard.component.ts:1003-1013` `currentBenchMonth` | mese corrente se nella finestra | **non tocca** |
| U10 | `bench.component.ts:232-237` conteggi e due "% on bench" | `benchCount / activeCount` | **domanda di prodotto aperta Q3** (§10): l'assente sta nel denominatore? La % può **salire** mentre il bench assoluto scende. Vincolo di design che ne deriva: il pannello **deve** mostrare il conteggio degli assenti accanto alle due percentuali, altrimenti il blocco reintroduce un numero fuorviante mentre ne corregge un altro |
| U11 | `bench.component.ts:74-140` righe e celle | 3 stati resi | rendering distinto per ABSENT — distinto da BENCH, da ALLOCATED **e** da «nessuna riga». Nessuna causale a schermo (§7.3) |
| U12 | `forecast.ts:576` `notFullyAllocatedAt(input, ...)` | pannello riallocabili | l'`input` deve portare le assenze; il filtro corretto viene da B12 |
| U13 | `what-if.ts:611,614` conteggi baseline vs scenario | due `notFullyAllocatedAt` | le assenze devono passare **in entrambi** attraverso `baseData()`/`scenario()`, o i due conteggi differiscono per la ragione sbagliata e lo scenario sembra migliorare |
| U14 | `forecast.util.ts` `capacityForecast` | orizzonte **settimanale**; la supply usava il gate mensile e lo scalare `capacity` mai pro-ratato | ~~fuori scope~~ **FATTO il 2026-08-07**: il numeratore della supply passa per `availableWorkingDays`, il divisore resta l'intero conteggio di giorni lavorabili del periodo. Il gate mensile che questa riga citava non esiste più — è stato rimosso quando è rimasto senza chiamanti |
| U15 | `forecast.util.ts` `skillGap` | supply per ruolo | ~~fuori scope~~ **FATTO il 2026-08-07**: un detentore assente **tutto il mese** non copre più la sua skill; un assente parziale sì. Verso del rischio scelto di proposito: la restrizione è monotona e può solo **far emergere** una carenza, perché una carenza nascosta costa il solo segnale che quella tabella esiste per dare, mentre una falsa costa una conversazione |
| U16 | `forecast.util.ts:469-503` `overAllocated` | soglia su ore prenotate | **non tocca**: le ore prenotate non cambiano |
| U17 | `app.ts:659-660` `overbookedBadge` | sovra-allocazione | **non tocca** (già corretto per lo split kind da `2cb462b`) |
| U18 | `resources.component.ts:604-611,370` `billability` | rende `resourceBillability` | segue F-8; la cifra a schermo **scende** per chiunque abbia ore su commesse non fatturabili. Da asserire su una fixture con entrambi i tipi di ore |
| U19 | `export.util.ts` e i suoi chiamanti | CSV/JSON, SSR-safe, formula-injection guarded | lo stato ABSENT entra negli export di bench/capacity; **`reasonCode` e `note` non entrano in NESSUN export, mai**. Un export lascia l'applicazione e viene inoltrato per posta: è il percorso di fuga classico. Divieto esplicito, non una conseguenza sperata |
| U20 | `my-assignments.component.ts`, `my-profile`, `staffing.component.ts` | viste di identità/candidatura sullo scalare stantio | **non tocca** — stesso verdetto del blocco F (§9 di quella spec). Nominato perché sono file toccati in parallelo |

### 5.5 Ciò che questo blocco CREA e che altri leggeranno — la domanda di C2

| # | Produttore | Consumatori che ne dipendono | Vincolo |
|---|---|---|---|
| P1 | `POST/PUT/DELETE /absences` | `/bench/monthly`, `/capacity/monthly`, `/forecast`, `/what-if`, `/utilization`, `/dashboard` — **sei** consumatori | ogni scrittura muove sei superfici. Il write path è l'unico punto dove validare l'intervallo: nessun consumatore può recuperare da un'assenza che esce dalla finestra di impiego |
| P2 | `PUT /projects/:id/classification` (§6.2) | otto funzioni di `finance.util.ts` (F-2, F-3, F-5, F-6, F-7, F-8, + i due gate del §6.3) | flippare un progetto a non fatturabile **rimuove un ricavo atteso e spegne allarmi di margine**: è un'azione finanziaria, non un'anagrafica (§7.2) |
| P3 | `POST /assignments`, day-replace, `transferDummyMonth` (`server.ts:2476-2679`) | `/bench`, `/capacity`, il calendario, il feed B3 | una prenotazione **nuova** su un giorno coperto da assenza va rifiutata (§6.4); se non lo è, i due numeri diventano veri e contraddittori (allocata **e** assente) |
| P4 | `src/db/seed.ts` | l'adapter in-memory **e** il seeder Postgres (fonte unica di verità) | senza righe seed la feature è invisibile al primo avvio **e** i test sono ciechi (§8.3) |
| P5 | il middleware di audit append-only | `GET /audit-logs` (admin, delivery-executive) | `/absences` va registrata in `auditTargetRef` (`operational-integrity.util.ts:421`), altrimenti `auditRegistryGaps` (`:452`) la segnala come buco — e il diff conterrebbe `reasonCode`, verso un'audience che non è quella della causale: **è la domanda aperta Q5** (§10) |
| P6 | `docs/roles-and-permissions.md` | è dichiarato «kept in sync with the code» ed è il posto dove si cerca «chi può fare cosa» | va aggiornato nello stesso blocco, non dopo |
| P7 | `docs/rpt-comparison.md` righe 54-55 + riquadro + riga di sintesi 167/181/218 | il documento di gap analysis | lo stato passa da **MANCA**; il riquadro «unico gap con conseguenza numerica immediata» va riscritto, non lasciato a contraddire il codice |

---

## 6. Superficie server

`src/server.ts` è **7678 righe** e ha un solo proprietario per task (§9). Tutte le modifiche server di questo blocco sono **un unico task**.

### 6.1 `/absences` — due letture, una scrittura

- **`GET /absences`** — righe complete, `reasonCode` e `note` inclusi. Audience ristretta (§7.3).
- **`GET /absences/calendar?from=YYYY-MM&to=YYYY-MM`** — proiezione **redatta**: `{ id, resourceId, startDate, endDate }`, nessuna causale, nessuna nota. È il feed che alimenta le sei superfici di derivazione. La redazione è una **proiezione costruita nell'handler**, non un `delete` sull'oggetto letto: un `delete` lascia il campo raggiungibile se un giorno la forma cambia.
- **`POST` / `PUT /absences/:id` / `DELETE /absences/:id`** — bespoke, **non** `crud()`: `crud()` non può esprimere né i campi server-pinned né le regole di integrità sotto. `pick()` allow-list = `['resourceId','startDate','endDate','reasonCode','note']`. **`recordedBy` e `recordedAt` sono server-pinned** dall'attore verificato — mai dal body, stessa classe di `createdBy`/`requestedBy` per la SoD.
- Validazioni: `resourceId` esiste (`existsRepo(repos.resources, ...)` → 400); `startDate`/`endDate` ISO con `end >= start` (`validateDateFields`, come `/projects`); `reasonCode ∈ ABSENCE_REASON_CODES` (400); l'intervallo **dentro la finestra di impiego** della risorsa (`employmentWindowError`/`bookingWindowOutsideEmploymentError`-shaped, `operational-integrity.util.ts:561,598`); **nessuna sovrapposizione** con un'altra assenza della stessa risorsa (409).
- **`withLock('res:' + resourceId, ...)`** sulla scrittura: il controllo di sovrapposizione è un read-modify-write sull'insieme delle assenze della risorsa, e gli handler Express girano concorrenti. Chiave `res:` — la stessa famiglia già usata; se un giorno un handler prendesse sia `res:` sia un altro lock, vale l'ordinamento lessicografico documentato da C2 (§5.3 di quella spec).

### 6.2 Classificazione di un progetto

**`billable` e `type` NON entrano in `PROJECT_FIELDS`** (`server.ts:4751`). Se ci entrassero, la modifica ordinaria di un progetto da parte di un `pm` potrebbe flipparli, e `pick()` — la guardia contro il mass-assignment — li ammetterebbe come qualunque altro campo. Restano server-pinned al default (`billable: true`, `type: 'Delivery'`) su `POST /projects`, esattamente come `status` su una nuova time entry e `invoiceNumber` su una fattura.

- **`PUT /projects/:id/classification`** — body `{ billable: boolean, type: ProjectType }`, audience ristretta (§7.2). Enforced: l'invariante `type === 'Basket' ⇒ billable === false` (400); i due gate del §6.3.
- **`POST /projects` e `PUT /projects/:id` rifiutano con 403** se il body grezzo porta `billable` o `type`, invece di lasciarli cadere in silenzio. Motivo: un wizard che «funziona» e produce un progetto fatturabile è peggio di un wizard che restituisce un errore. `pick()` è silenzioso per progetto — qui serve il rumore.

### 6.3 I due gate che impediscono una fattura da zero euro

Il requisito è che il riconoscimento e i billing item **rifiutino** una commessa non fatturabile, non producano una fattura da zero euro. Serve un gate su **entrambi** i lati, o l'invariante è enforced a metà:

1. **`POST /billing-plan-items` e `PUT /billing-plan-items/:id`** → **400** quando `projectId` risolve a un progetto `billable === false`. Il punto d'inserimento è accanto a `validateBillingPlanReferences` (`server.ts:5911`), che già risolve le FK del progetto.
2. **`PUT /projects/:id/classification`** → **409** quando si flippa a `billable: false` un progetto che ha **già** billing plan item. Senza questo, la sequenza «crea fatturabile → crea billing item → flippa a non fatturabile» aggira il gate 1 e produce esattamente la fattura da zero euro che si voleva impedire. Il messaggio nomina quanti item bloccano il flip.

Conseguenza: `recognitionSchedule`, `recognitionJournal`, `arAging` e i rollup di billing (F-10 … F-13) **non hanno nulla da filtrare**, perché le righe non possono esistere. È il motivo per cui il gate va sul write e non nella derivazione (F-10).

### 6.4 Il gate di prenotazione, e la sua asimmetria deliberata

- **Una prenotazione NUOVA su un giorno coperto da assenza è rifiutata** (400, messaggio che nomina la data e la risorsa, **mai** la causale) — stessa forma di `bookingOutsideEmploymentError` (`operational-integrity.util.ts:580`) e nello stesso punto di chiamata dei percorsi di scrittura giornaliera.
- **Un'assenza NUOVA su giorni già prenotati è ACCETTATA e riporta il conflitto**: la risposta elenca gli `assignmentDays` interessati e le ore, così il pianificatore sa cosa disprenotare. Non è rifiutata: l'assenza è un fatto già avvenuto, e rifiutarla lascerebbe il sistema a dichiarare presente chi non lo è.

L'asimmetria è deliberata ed è la stessa inversione motivata di C2 (§4: «*un cap non utilizzabile restituisce tutto: l'inverso deliberato della convenzione di planSubstitution*»). Il verso sicuro dipende da quale delle due cose è già vera nel mondo.

### 6.5 Threading nei due endpoint computati

`GET /capacity/monthly` (`server.ts:3847-3887`) e `GET /bench/monthly` (`:3896-3934`) aggiungono `repos.resourceAbsences.list()` al `Promise.all` esistente e passano `absences` a `rollupMonthly`/`benchRollup`. **Entrambi restituiscono solo aggregati**: la causale non attraversa mai il filo su questi due percorsi, che è la proprietà che rende la separazione delle audience (§7.3) reale e non nominale.

---

## 7. RBAC, SoD, privacy

I 7 ruoli sono `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `sales`, `admin` (`docs/roles-and-permissions.md`).

### 7.1 Chi registra un'assenza

In RPT il dato arriva da Zucchetti (HR). Noi non abbiamo quel feed, quindi qualcuno deve registrarlo a mano.

**Mutazione `/absences`: `resource-manager`, `admin`.** Nuova regola nella tabella `rules` (`server.ts:729-772`).

- **`pm` escluso deliberatamente.** Un PM non deve poter dichiarare un collega assente: rimuoverebbe una persona dal bench e dalla disponibilità di staffing, cioè muoverebbe una metrica di cui è misurato, e comunque è un fatto HR di cui non è titolare.
- **`employee` escluso in scrittura.** Non abbiamo un workflow di richiesta ferie; una creazione self-service permetterebbe a chiunque di togliersi dal bench. Se un giorno servirà, sarà un workflow di approvazione, non una scrittura diretta.
- **`delivery-executive`** in scrittura: **no** per default (non è il titolare del dato HR), **ma vedi Q5** — è in lettura di `/audit-logs`, che è il percorso per cui la decisione va coordinata con la privacy.
- **`finance`, `sales` esclusi**, in scrittura e in lettura della causale: nessun need-to-know.

### 7.2 Chi classifica una commessa

In RPT la commessa Basket la creano **WFM / Delivery Excellence, non il PM**. Traduzione: `PUT /projects/:id/classification` → **`delivery-executive`, `finance`, `admin`**.

- `delivery-executive` = la Delivery Excellence del manuale;
- `finance` perché il flag **spegne un'aspettativa di ricavo e degli allarmi di margine**: è un'azione finanziaria, e la stessa audience già proprietaria di `/rate-cards`, `/settings` e `/cost-baselines` (`server.ts:741,746,748`);
- **`pm` escluso**, benché possa mutare `/projects` (`server.ts:752`): chi è misurato sul margine di una commessa non deve poter dichiarare che quella commessa non ha margine. È lo stesso argomento, verbatim, del commento su `/cost-baselines` a `server.ts:742-744` («*must not be able to rewrite the metric they are measured against*»).

Nuova regola di mutazione **prima** della regola coarse `/projects`, altrimenti quella coarse (che ammette `pm`) la intercetta e la regola narrow diventa codice morto che continua a leggersi come una guardia — il difetto che il commento a `server.ts:730-734` documenta per la slice commerciale.

### 7.3 La privacy del dato di assenza — tre livelli, non due

**La maternità di una persona è un dato di categoria particolare (GDPR art. 9). Non deve essere leggibile da chiunque.** Tre livelli di lettura, non uno:

| Livello | Cosa espone | READ_RULE |
|---|---|---|
| **Causale** — `GET /absences` | `reasonCode`, `note`, `recordedBy` | `resource-manager`, `admin`. **`employee` solo sulle proprie righe** — filtro nell'handler sul `resourceId` risolto dal principal, non nella regola (una READ_RULE è per-path, non per-riga) |
| **Disponibilità** — `GET /absences/calendar` | solo `{id, resourceId, startDate, endDate}` | la stessa audience di `/capacity` e `/bench`: `pm, resource-manager, delivery-executive, finance, admin`. Implementata **estendendo** il test esistente a `server.ts:816` — `p.startsWith('/capacity') || p.startsWith('/bench') || p.startsWith('/absences/calendar')` — non duplicando l'array, come già fatto per `/bench` |
| **Aggregato** — `/bench/monthly`, `/capacity/monthly` | solo lo stato `ABSENT` e i numeri | invariata. La causale non attraversa il filo su questi percorsi (§6.5) |

**Ordine delle regole:** `/absences/calendar` deve essere testata **prima** di `/absences`, o il prefisso più corto la intercetta e la proiezione redatta erediterebbe l'audience della causale — cioè la redazione servirebbe a nulla. Nota che il test `p.startsWith('/absences')` è **più permissivo di quanto sembri**: le READ_RULE lavorano su `normalizeApiPath(req.path)` (`server.ts:707`) proprio per il difetto già occorso su `GET /api/Audit-Logs`.

Lo stato `ABSENT` **rivela che la persona è via**, alla platea CAPACITY_ROLES. È il minimo necessario per lo staffing e non è eludibile: un pianificatore deve sapere che non può prenotarla. Non rivela **perché**, che è la distinzione che conta.

### 7.4 SoD

**L'attore che registra un'assenza non può esserne il soggetto.** `recordedBy` è server-pinned; una `POST` in cui `resourceId` coincide con la risorsa risolta dal principal è **rifiutata** (403). Stessa forma della regola approvatore ≠ richiedente già enforced negli handler sopra l'RBAC.

Conseguenza operativa, dichiarata e non scoperta dopo: **un `resource-manager` non può registrare la propria assenza** — serve un altro `resource-manager` o un `admin`. È lo stesso compromesso che la SoD sulle approvazioni già accetta oggi.

---

## 8. Strategia di test, con i gate verdi ciechi già intercettati

Il difetto ricorrente di questo progetto è la verifica verde che nessun dato esercita. Le tre forme già occorse qui: (a) un campo di input opzionale con default vuoto; (b) una fixture che dimostra un'esclusione senza che esista una riga da escludere; (c) un report d'impatto che stampa zero perché niente attraversava il codice (il commento in `src/db/seed.ts:222-230` sul blocco tariffe negoziate: «*the impact report printed zero because nothing exercised the code, which is how a ~8x revenue defect passed every green gate*»).

### 8.1 Ogni asserzione di presenza, e dove sta la sua gemella di assenza

| Asserzione di presenza | Asserzione di assenza accoppiata |
|---|---|
| La cella di giugno di Marco è `ABSENT` | la sua cella di **maggio** è ancora `BENCH` — l'assenza ha cambiato **un** mese, non la riga |
| Il bucket post-assenza è quello previsto dalla politica | una risorsa **senza** righe di assenza (Julie/John/Alice) ha la **stessa** sequenza di bucket di prima del blocco |
| Un `ABSENT` sparisce dalla tile bench di `/dashboard` | il conteggio della tile per un mese **senza** assenze è **byte-identico** a prima |
| Un'assenza fuori dalla finestra mostrata non ha effetto | la **stessa** assenza spostata **dentro** la finestra cambia la cella — stessa riga, due posizioni |
| Un progetto non fatturabile non genera allarme di margine | i progetti `'1'`/`'2'` hanno allarmi, margine, realization e riga cliente **invariati al centesimo** |
| Il **costo** del progetto non fatturabile resta riportato in `plannedCostSchedule` | …e **non** compare in `customerProfitability` — esclusione dagli allarmi ≠ cancellazione dal costo |
| `POST /billing-plan-items` è rifiutata sul progetto non fatturabile | è **accettata** su `'1'`/`'2'` — il rifiuto riguarda la fatturabilità, non un blocco generale |
| Il flip a non fatturabile è rifiutato quando esistono billing item | è **accettato** su un progetto che non ne ha — il 409 riguarda gli item, non il flip |
| `PUT /projects/:id/classification` è 403 per `pm` | è **200** per `delivery-executive` — il 403 riguarda il ruolo, non un endpoint rotto |
| `reasonCode` è **assente** da `/absences/calendar` | è **presente** su `/absences` per il ruolo autorizzato — la redazione è una proiezione, non una colonna mancante |
| `reasonCode` è **assente** da ogni CSV/JSON esportato | l'export contiene comunque le righe e lo stato `ABSENT` — l'omissione è del campo, non dei dati |
| `resourceBillability` scarta le ore non fatturabili | il valore fatturabile **sulle commesse fatturabili** della stessa persona è invariato |
| Una prenotazione nuova su un giorno di assenza è rifiutata | la **stessa** prenotazione il giorno prima/dopo è accettata — il gate è l'intervallo, non la risorsa |
| Un'assenza nuova su giorni già prenotati è **accettata** | …e la risposta **nomina** gli assignmentDays in conflitto (non è un successo silenzioso) |
| `freeingUpNextMonth` è **falso** per chi va in congedo il mese prossimo | è **vero** per chi **rientra** da un congedo in un mese BENCH |
| `availabilityDateFor` salta i mesi ABSENT | restituisce comunque una data (o `beyond-horizon`) — **mai** un campo vuoto (regola §7 del blocco F) |

### 8.2 I due test differenziali, contro «zero righe impattate»

Due input opzionali di questo blocco sono trappole strutturali, e vanno neutralizzate con test **differenziali**, non con test di valore:

1. **`RollupInput.absences` con default `[]`** (C1 dello sweep). Test: la **stessa** fixture, una volta con e una volta senza righe di assenza, deve produrre risultati **diversi** su almeno una cella e su `capacityFte`. Un test che asserisce solo il valore corretto con le assenze resta verde anche se il parametro non viene mai letto.
2. **`FinanceData.projects` omesso ⇒ tutto fatturabile** (F-1). Test: la stessa fixture con e senza `projects`, con almeno un progetto `billable: false`, deve produrre `customerProfitability`, `realizationMetrics` e `resourceBillability` **diversi**. Senza questo, ogni test finanziario esistente (che omette `projects`) resta verde e certifica il vecchio comportamento.

### 8.3 Le fixture seed minime — perché la feature sia visibile al primo avvio e i test non ciechi

`src/db/seed.ts` è la fonte unica di verità, consumata sia dall'in-memory sia dal seeder Postgres. Con anchor `from = '2026-04'` (prima planning period Open, `seed.ts:330+`), finestra mostrata `2026-04..2026-09`, finestra fetchata `2026-02..2026-10`.

**Vincolo su cosa NON toccare:** le risorse `'6'`, `'7'`, `'8'`, `'9'` e le request/assignment `'7'`-`'11'` sono fixture **pinnate** dal blocco F, con asserzioni esistenti su stato e `availabilityDate`. Le assenze **non** vanno messe su `'7'` (Priya) né su `'9'` (Elena): romperebbero asserzioni di un altro blocco. `'8'` (Marco Belli) è l'eccezione voluta — è già il caso bench puro, ed è precisamente il caso falso da correggere; le sue asserzioni B/C/D **devono** cambiare, ed è il punto.

| # | Fixture | Seed | Cosa dimostra, verificabile per costruzione |
|---|---|---|---|
| S1 | **Assenza lunga sul caso bench puro.** Risorsa `'8'` Marco Belli (hireDate `2026-04-01`, nessuna prenotazione ⇒ oggi B/C/D su apr-set) | `resourceAbsences`: `ParentalLeave`, `2026-06-01`..`2026-08-31` | giu/lug/ago = `ABSENT`, **non** BENCH/C/D. È **la** correzione della metrica falsa: tre mesi lasciano il bench e il bucket D si svuota di un caso che non è un problema di delivery. Il bucket di settembre dipende dalla risposta a **Q1** — ed è per questo che Q1 va risposta: la fixture rende la differenza fra le due risposte visibile e misurabile |
| S2 | **Assenza parziale con ore prenotate sugli stessi giorni.** **Nuova** risorsa internal (id da riverificare sul seed vivo: `'10'`-`'12'` sono liberi fra le risorse ma occupati fra request/assignment, `'13'` è preso su un altro branch ⇒ **`'14'`**, con la stessa motivazione dichiarata al commento di `'13'`), allocazione piena apr-set + assenza `Vacation` di una settimana a maggio | assignment + assignmentDays + assignmentMonths `Allocated`; una riga assenza | maggio: le ore prenotate **non** cambiano, il target **sì** (pro-ratato) ⇒ `ftePlanned > 100%` e banda `over`. Pinna sia il target pro-ratato (C5) sia la regola «assenza su giorni già prenotati accettata **con** conflitto riportato» (§6.4). Il segnale è **visibile**, non silenzioso |
| S3 | **Assenza interamente fuori dalla finestra mostrata.** `Sickness` a `2026-02` sulla stessa risorsa `'14'` | una riga assenza | **nessun** effetto su nessuno dei 6 mesi mostrati. È l'asserzione di assenza-di-effetto, gemella di S1 (§8.1). Insieme a S1 dimostra che la finestra è rispettata in entrambi i versi |
| S4 | **Assenza su un subco.** Risorsa `'6'` (subco Mediolanum) — `Sickness` breve in un mese in cui è già BENCH per il blocco F | una riga assenza | il quarto stato vale anche per i subco, che sono in bench per decisione 4 del blocco F. Se ci si limitasse agli internal, la tile `subcoBenchCount` (`dashboard.component.ts:1023`) resterebbe falsa e verde |
| S5 | **Commessa non fatturabile CON costo reale.** Nuovo progetto `'3'` «BASKET — Engineering Practice», `type: 'Basket'`, `billable: false`, **nessun `contractId`**; più una request, un assignment, assignmentDays/Months `Allocated`, e **time entry approvate** | progetto + request + assignment + giorni/mesi + 2-3 `timeEntries` con `status: 'Approved'` | senza le time entry approvate, `realizationMetrics`, `actualLaborCostForProject` e `customerProfitability` non vedono nulla e «0 righe impattate» non significa niente — la trappola (c), il difetto documentato a `seed.ts:222-230`. Con esse: cade sotto il cliente `'unknown'` (`finance.util.ts:1513`) ⇒ **pinna F-5**; ha `standardBillValue > 0` e `revenue === 0` ⇒ **pinna F-7**; le sue ore entrano in `resourceBillability` ⇒ **pinna F-8**; ha un `plannedCostSchedule` non nullo ⇒ **pinna F-4** (il costo resta riportato) |
| S6 | **Cost baseline sulla commessa non fatturabile.** Una riga `costBaselines` su progetto `'3'` | una riga | pinna esplicitamente il verdetto di non-esclusione F-4: il piano annuale su base storica del manuale **funziona** su una commessa basket (§2.5). È l'asserzione contro la sovra-correzione |
| S7 | **Nessun billing plan item sul progetto `'3'`** | (assenza deliberata) | annotata **come non-fixture**, con il rinvio all'asserzione negativa dello smoke (`POST /billing-plan-items` su `'3'` → 400). Il commento serve a impedire che l'assenza di righe venga scambiata per un test |
| S8 | **Dummy prenotato sulla commessa non fatturabile.** Risorsa `'4'` (dummy) o un secondo dummy, con ore su una request del progetto `'3'` | assignment + giorni/mesi | pinna B7: la hiring demand **conta** anche le ore di una commessa non fatturabile (serve assumere anche per l'AMS), e quel dummy **non** compare in bench. Pinna l'interazione fra le due metà del modello |
| S9 | **I due progetti fatturabili restano fatturabili.** Progetti `'1'`/`'2'`, invariati (default `billable: true`, `type: 'Delivery'`) | (nessuna modifica) | il controllo di regressione: margine, allarmi, realization e righe cliente **non si muovono di un centesimo**. Senza un controllo intatto, «abbiamo corretto il margine» non dimostra nulla |
| S10 | **Assertion di livello seed.** Una spec (`bench.util.spec.ts` o una spec di coerenza del seed) asserisce che `seed.resourceAbsences` è **non vuoto** e che almeno una risorsa ha una cella `ABSENT` nella finestra di default di `/bench/monthly` | — | senza questa, cancellare le fixture del seed lascia verdi tutti gli unit test (le loro fixture sono inline). È la lezione del blocco D: **una fixture che mente sull'identità certifica una feature inerte** |

### 8.4 Gli altri gate

- **Unit sul layer puro** (`absence.util.spec.ts` nuovo, `bench.util.spec.ts`, `capacity.util.spec.ts`, `finance.util.spec.ts`): `absenceDaysFor` con intervalli sovrapposti (nessuna doppia sottrazione), adiacenti, di un giorno, fuori dai giorni lavorativi, che scavalcano il mese; `availableWorkingDays` ai confini di `hireDate`/`terminationDate` **incrociati** con l'assenza; `monthAvailability` sui quattro esiti; `absenceStreakPolicy` su entrambi i rami di Q1 (il test parametrizzato sulla politica, così rispondere a Q1 non riscrive il test); `benchStateFor(0, 0)` **mai raggiunta** su un mese `fully-absent` (§4.4).
- **Smoke** (`scripts/smoke-api.mjs`, dependency-free): `GET /absences/calendar` senza causale; `GET /absences` con causale per `resource-manager` e **403 per `pm`**; `POST /absences` self-referenziale → 403 (SoD); sovrapposizione → 409; `POST /billing-plan-items` su progetto `'3'` → 400 e su `'1'` → 200; `PUT /projects/3/classification` con `pm` → 403 e con `delivery-executive` → 200; flip a non fatturabile su un progetto con item → 409; `GET /bench/monthly` con almeno una cella `ABSENT` e nessun `reasonCode` in tutta la risposta (asserzione sul **corpo intero**, non su un campo — è il modo in cui una fuga si trova).
- **Parità dev↔prod:** i gate consueti (build, unit, lint, smoke live in-memory **e** su Postgres fresco). Questo blocco **ha** una migrazione, quindi il giro su Postgres fresco è un gate reale, non formale: verifica che `notNull().default(...)` non richieda backfill e che una riga `projects` preesistente si legga `billable: true`. Verifica anche `nullsToUndefined()` su `note` assente (deve tornare `undefined`, non `null`) e la parità della patch tutta-`undefined` su `PUT /absences/:id`.
- **Browser:** `/bench` con la resa distinta di `ABSENT`; `/utilization` in **entrambe** le viste (`direct` e `org`) con il quarto badge; la tile di `/dashboard`; il grafico di `/reporting`; e la verifica che **nessuna schermata** mostri una causale.

---

## 9. Piano in task ordinati, con dipendenze e proprietà dei file

Un file, un proprietario. I file toccati in parallelo da altri branch (`bench.util.ts`, `export.util.ts`, `staffing.component.ts`, `allocation-approvals`, `server.ts`) sono sequenziati esplicitamente.

| T | Cosa | File posseduti | Dipende da |
|---|---|---|---|
| **T1** | Schema + migrazione `0019` + wiring repository/seeder + tipi client | `src/db/schema.ts`, `drizzle/0019_*.sql`, `drizzle/meta/*`, `src/db/repositories.ts`, `src/db/bootstrap.ts`, `src/app/services/api.service.ts` (soli tipi) | — |
| **T2** | Fixture seed (S1-S9) | `src/db/seed.ts` | T1 |
| **T3** | Layer puro nuovo + `capacity.util.ts` (pro-ratazione, `RollupInput`) | `src/app/services/absence.util.ts` (nuovo), `src/app/services/capacity.util.ts`, i rispettivi `.spec.ts` | T1 |
| **T4** | `bench.util.ts`: quarto stato, politica di anzianità, `availabilityDateFor`, `notFullyAllocatedAt` | `src/app/services/bench.util.ts`, `bench.util.spec.ts` | T3 · **deve partire dopo il merge del branch parallelo su `bench.util.ts`** (disallocazione + storico mensile): la spec dice *cosa* cambiare, non presume il contenuto riga per riga |
| **T5** | `finance.util.ts`: `billable` su `ProjectFinancials`, esclusioni F-3/F-5/F-6/F-7/F-8 | `src/app/services/finance.util.ts`, `finance.util.spec.ts` | T1, T2 · indipendente da T3/T4 (**può correre in parallelo**) |
| **T6** | Server: `/absences` (2 letture + 3 scritture), classificazione, i due gate del §6.3, il gate di prenotazione, threading in `/capacity/monthly` e `/bench/monthly`, regole RBAC, registro audit | `src/server.ts`, `src/server/server-logic.spec.ts` | T1, T3, T4, T5 · **unico proprietario di `server.ts`; da sequenziare contro il branch parallelo su quel file** |
| **T7** | Frontend consumatori: U1-U3, U4-U6, U7-U8, U10-U11, U12-U13, U18-U19 | `utilization.component.ts`, `reporting.ts`, `dashboard.component.ts`, `bench.component.ts`, `forecast.ts`, `what-if.ts`, `resources.component.ts`, `export.util.ts` + spec | T4, T5, T6 · `export.util.ts` **dopo** il merge del branch parallelo |
| **T8** | UI di registrazione assenza + classificazione progetto (schermate ristrette per ruolo) | nuovo componente sotto `src/app/`, `src/app/app.routes.ts`, `src/app/guards/role.guard.ts` | T6 |
| **T9** | Smoke + documentazione | `scripts/smoke-api.mjs`, `docs/roles-and-permissions.md`, `docs/rpt-comparison.md` (righe 54-55, riquadro, sintesi) | T6, T7 |

**Il camminamento critico è T1 → T3 → T4 → T6 → T7.** T2 e T5 si agganciano presto e in parallelo. Le cinque domande di prodotto sono state **decise il 2026-08-07** (§10): nessun task è bloccato da una decisione. Due note del piano che le decisioni cambiano: **T4 conta giorni lavorativi, non mesi** (Q1), e **T6 non deve costruire la redazione per campo** nell'audit (Q5).

---

## 10. Domande di prodotto — DECISE dall'utente il 2026-08-07

**Tutte e cinque risposte. Nessun task è più bloccato da una decisione di prodotto.** Le risposte sono qui sotto in testa a ciascuna domanda; il testo originale delle opzioni resta come contesto del perché.

| Q | Decisione | Effetto sul piano |
|---|---|---|
| **Q1** | **Giorni lavorativi esatti**, non mesi interi | Sblocca T4 e **cancella la variante che toccava lo schema**: contando i giorni, la causale non entra mai nell'aritmetica, quindi la proiezione oscurata del §3.4 resta sufficiente così com'è. T1 non cambia |
| **Q2** | Margine **fully loaded** (include il costo non fatturabile) | Sblocca T5 |
| **Q3** | Assente **fuori dal numeratore, dentro il denominatore** | Sblocca T7 |
| **Q4** | Assente **marcato in modo distinto** sul grafico di `/reporting` | Sblocca T7 |
| **Q5** | `delivery-executive` **entra nell'audience** della causale | Sblocca T6, **senza** costruire la redazione per campo |

### Q1 — DECISO: giorni lavorativi esatti

**La domanda posta era mal impostata, e l'utente l'ha smontata.** Chiedeva se un mese di assenza spezzasse la serie, dando per scontata l'unità **mese** — eredità delle etichette di RPT (A/B/C/D come «dal mese successivo / <1 mese / 1-2 mesi / >2 mesi») e dell'unità di pianificazione (`assignment_months`, `planning_periods`). Le tre opzioni che ne derivavano erano tutte cattive: una gonfia i bucket C/D con le ferie, una li deflaziona, la terza chiede di inventare una soglia.

Sono cattive perché la premessa era sbagliata. **Il dato a giorni esiste già**: `unallocatedDays` per risorsa-mese è atterrato su `main` il 2026-08-07 (commit `23ffe08`).

Contando i giorni il dilemma svanisce: **un giorno di assenza contribuisce zero giorni di inattività**, perché la persona non era staffabile. Non gonfia e non spezza. Ferma da gennaio più 20 giorni di ferie ad agosto ⇒ i 20 giorni semplicemente non contano, e la serie continua da dove era. Chi rientra da un congedo lungo riparte dai giorni di inattività che aveva accumulato **prima** del congedo — zero, se era allocata.

Conseguenze per T4:
- I bucket restano etichettati A/B/C/D (è il linguaggio che gli utenti RPT riconoscono) ma sono calcolati su **giorni lavorativi consecutivi di inattività**, non su mesi consecutivi `BENCH`.
- Le soglie vanno espresse in giorni lavorativi come **costanti nominate e documentate**, ancorate a «circa un mese lavorativo»: B fino a ~21, C 21-42, D oltre 42. Da fissare leggendo come `employedWorkingDays` conta un mese tipico, **non** hardcodando 21 senza derivarlo.
- Contare **giorni** e non **ore** gestisce il part-time da sé: chi lavora 4 ore al giorno e non è staffato è inattivo quel giorno quanto un full-time.
- `reasonCode` **non** entra nell'aritmetica. La variante schema è chiusa.

### Q2 — DECISO: fully loaded

Il costo del lavoro non fatturabile **entra** nel margine di portafoglio. Il margine scende e riflette il costo vero dell'azienda.

**Conseguenza da gestire in T5, non da scoprire dopo:** il numero non è più confrontabile con il margine di delivery dei singoli progetti, e qualcuno farà quel confronto. La tile deve dire *fully loaded* nell'etichetta, non solo nella didascalia, e il documento di reporting va aggiornato di conseguenza.

### Q3 — DECISO: fuori dal numeratore, dentro il denominatore

La correzione è monodirezionale: la percentuale di bench **scende sempre**, che è facile da spiegare.

**Il vincolo del §8 resta valido e obbligatorio:** il pannello deve mostrare il **conteggio degli assenti** accanto alle percentuali. Con questa scelta il denominatore include persone che non potevano essere staffate, quindi senza quel numero a fianco la percentuale è più difficile da giustificare, non più facile.

### Q4 — DECISO: marcato in modo distinto

Ogni persona resta sul grafico, con barra distinta e motivo leggibile dello 0%.

**Conseguenza accettata:** la platea di `/reporting` (`canViewPortfolioDashboard()`) vede **chi** è via. Non perché — la causale non compare qui. La didascalia va aggiornata.

### Q5 — DECISO: `delivery-executive` entra nell'audience della causale

Coerenza fra i due percorsi senza costruire meccanismi nuovi: nessuna redazione per campo nel middleware di audit.

**Va registrato come decisione consapevole, non come dimenticanza.** L'accesso a un dato di categoria particolare si allarga deliberatamente da `admin` a `admin` + `delivery-executive`. T6 deve scriverlo in `docs/roles-and-permissions.md` accanto alla regola, con la data e il fatto che è una scelta di prodotto — così una revisione futura trova il perché e non un buco.

---

### Testo originale delle cinque domande (contesto delle decisioni sopra)

### Q1 — Un mese di assenza spezza la serie di inattività, o è trasparente?

Blocca **T4**. Riguarda `monthsIdleAt` / `absenceStreakPolicy` (§4.2) e la popolazione dei bucket C e D.

| Opzione | Conseguenza |
|---|---|
| **A — trasparente (default proposto)** | Ferma da gennaio, in ferie ad agosto, ancora ferma a settembre ⇒ settembre resta **D**. Il congedo non azzera un problema di delivery reale. Ma una maternità di 6 mesi produce, al rientro, un **D immediato**: la persona è «ferma da 8 mesi» il giorno in cui torna |
| **B — spezza la serie** | Il rientro da un congedo parte sempre da **B**, che è giusto per una maternità e **sbagliato** per una settimana di ferie: chi è fermo da gennaio riparte da B per aver preso 5 giorni ad agosto. Corregge un'inflazione di C/D creandone una deflazione |
| **C — ibrido a soglia** | Trasparente per assenze ≤ N mesi, spezza oltre. Cattura entrambe le intuizioni. **Richiede di fissare N** (1? 2?), che è un secondo numero da decidere, ed è la sola opzione che non produce un caso ovviamente sbagliato |

**Variante che tocca lo schema:** se la risposta dovesse dipendere dalla **causale** (ferie ≠ maternità) invece che dalla durata, `reasonCode` entra nell'aritmetica e la proiezione redatta del §3.4 diventa **insufficiente** — dovrebbe portare una classe grossolana `short|long` invece della causale. È l'unico modo in cui Q1 muove lo schema, e va saputo prima di T1.

### Q2 — Il margine di portafoglio include il costo del lavoro non fatturabile?

Blocca **T5**. Riguarda `portfolioTotalsInBase` (`finance.util.ts:1179-1252`, F-9).

| Opzione | Conseguenza |
|---|---|
| **A — include il costo** (margine *fully loaded*) | Il margine di portafoglio **scende**, e riflette il costo vero dell'azienda (AMS, gruppi tecnici, presidi interni sono costo reale). Ma il numero non è più confrontabile con il margine di delivery per progetto |
| **B — esclude il costo** (margine di delivery) | Il margine di portafoglio è la somma coerente dei margini di progetto fatturabili. Ma **nasconde** una voce di costo reale, e il portafoglio sembra più redditizio dell'azienda |
| **C — due numeri** | Entrambi, etichettati. Costa una tile e una didascalia in più, e nessuna delle due cifre è ambigua |

In ogni caso la % di margine di portafoglio **si muove il giorno del rilascio**: va deciso, non ereditato.

### Q3 — Un assente sta nel denominatore della "% on bench"?

Blocca **T7**. Riguarda `bench.component.ts:232-237` (U10).

| Opzione | Conseguenza |
|---|---|
| **A — fuori da numeratore e denominatore** (proposto) | La domanda diventa «delle persone che potremmo staffare, quante sono non staffate». Coerente. Ma la **percentuale può salire mentre il bench assoluto scende**, che a un lettore appare come un peggioramento nel momento in cui la metrica viene corretta |
| **B — fuori dal numeratore, dentro il denominatore** | La percentuale scende sempre (correzione monodirezionale, facile da spiegare). Ma il denominatore include persone che **non** potevano essere staffate: la ragione della percentuale si annacqua |

**Vincolo di design che vale con qualunque risposta:** il pannello deve mostrare il **conteggio degli assenti** accanto alle due percentuali. Senza quel numero a fianco, il blocco corregge una metrica e ne rende un'altra inspiegabile.

### Q4 — Sul grafico utilizzo di `/reporting`, un assente si esclude o si marca?

Blocca **T7**. Riguarda `reporting.ts:1325-1340` + la didascalia a `:260` (U4/U5).

| Opzione | Conseguenza |
|---|---|
| **A — escluso dal grafico** | Nessuna barra ambigua. Ma il grafico ha **meno barre** di quante siano le persone, e chi conta le teste sul grafico trova un numero che non torna con l'headcount |
| **B — marcato distintamente** (barra tratteggiata/colore dedicato) | Ogni persona resta visibile e il motivo dello 0% è leggibile. Ma **rivela alla platea di `/reporting` chi è via** (non perché) — l'informazione che il §7.3 accetta di esporre a CAPACITY_ROLES, che qui è `canViewPortfolioDashboard()` |

La didascalia va aggiornata in **entrambi** i casi.

### Q5 — La causale di assenza nel registro di audit

Blocca **T6**. Privacy. Il middleware append-only fa il diff dell'entità su PUT/DELETE; `GET /audit-logs` è leggibile da **`admin` e `delivery-executive`** (`server.ts:794`), ma `delivery-executive` **non** è nell'audience della causale (§7.3).

| Opzione | Conseguenza |
|---|---|
| **A — `delivery-executive` entra nell'audience della causale** | Coerenza fra i due percorsi, nessun meccanismo nuovo. Ma **allarga** deliberatamente l'accesso a un dato di categoria particolare |
| **B — `reasonCode`/`note` redatti nel diff di audit** | L'audit registra **che** il campo è cambiato, non i valori. Richiede un concetto nuovo — la **redazione per campo** nel middleware, che oggi non esiste — quindi è lavoro reale, riusabile per ogni futuro dato sensibile |
| **C — le assenze non entrano nell'audit** | Nessuna fuga. Ma un dato sensibile diventa **modificabile senza traccia**, e `auditRegistryGaps` (`operational-integrity.util.ts:452`) segnalerebbe correttamente il buco: la scelta va allora dichiarata in quel registro, non nascosta |

---

## 11. Cosa questo blocco NON fa

- **Nessun wizard «Crea Nuova Commessa Basket»** (RPT riga 55). L'endpoint di classificazione più il form progetto esistente bastano a creare una commessa basket. Il wizard è ergonomia, non correttezza di un numero — e `type: 'Basket'` gli lascia la porta aperta.
- **Nessuna notifica email** ai responsabili alla creazione di dummy/subco/basket (RPT riga 43). Non esiste alcun canale email nel prodotto (`docs/rpt-comparison.md:95`): sarebbe un blocco intero, non una riga.
- **Nessun vincolo «un basket per Practice».** Le nostre `resourceOrganizations` modellano l'albero capability/practice/competence, ma `projects` non ha un campo di organizzazione: il vincolo di unicità del manuale non è esprimibile senza aggiungerne uno. Nominato per non farlo passare per un'assunzione silenziosa.
- **Nessun workflow di richiesta ferie.** Le assenze sono **registrate** da `resource-manager`/`admin` (§7.1), non richieste da un dipendente e approvate. Un flusso self-service è un blocco di approvazione a sé.
- ~~**Nessuna correzione della supply del forecast settimanale.**~~ **CHIUSO il 2026-08-07**, dopo il blocco. `capacityForecast` e `skillGap` sono ora consapevoli delle assenze: la supply restringe il **numeratore** da giorni impiegati a giorni disponibili lasciando il divisore sull'intero conteggio di giorni lavorabili del periodo (la stessa forma che `rollupMonthly` usa per `capacityFte`), e in `skillGap` un detentore smette di coprire **solo** se assente per tutto il mese — la stessa soglia di `BenchState = 'ABSENT'`, non una seconda inventata. La regola è **monotona**: può solo far passare `shortage` da falso a vero, mai il contrario, quindi nessuna riga di assenza può zittire una carenza che esiste oggi.

  Misurato: 40 h/settimana → 16 con tre giorni di assenza, → 0 con la settimana intera, e **zero variazione** quando l'assenza cade solo nel weekend o su un festivo — il gemello che distingue «legge il calendario» da «sottrae giorni a caso». `employedWorkingDays` **non è stata toccata**: i due gate compongono, e per questo un'assenza su giorni che un cessato aveva già superato non sottrae niente e il gate di scrittura del server continua a significare ciò che significava.

  Conseguenza che vale registrare: le tile **Bench** e **Avg Utilization** di `/what-if` ora concordano sulla stessa persona. Prima si contraddicevano **nella stessa riga di tile** — la prima la escludeva perché assente, la seconda la contava come capacità disponibile.

  `committed`, `pipeline`, `demand` e `overAllocated` restano **deliberatamente** invariati (U16 in piedi), così una prenotazione che collide con un congedo resta visibile come `gap` negativo invece di sparire.
- **Nessuna integrazione HR.** RPT prende le assenze da Zucchetti; noi le registriamo a mano. L'adapter è un blocco di integrazione (`docs/rpt-comparison.md` §3.7), e la tabella di questo blocco è precisamente la destinazione che quel feed avrebbe.
- **Nessuna retroattività sui numeri storici.** La correzione vale dal momento in cui le assenze sono registrate. Un bucket D calcolato su mesi passati senza righe di assenza resta quello che era: non esiste alcun dato da cui ricostruire chi era in ferie nel 2025.
- **Nessun cambio della matematica del margine.** `computeProjectFinancials` continua a calcolare `revenue − actualCost` anche per una commessa non fatturabile (F-2): il costo è reale e deve restare visibile. Cambia **chi consuma** quel margine, non il margine.
- **Nessuna capacità pro-ratata nel `capacity` scalare della risorsa** né nello scalare `utilization`. Entrambi restano valori di profilo whole-of-time; questo blocco lavora sul rollup mensile derivato, come il blocco F.
