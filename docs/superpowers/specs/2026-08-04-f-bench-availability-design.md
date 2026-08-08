# Design — Bench dashboard e disponibilità a 6 mesi (Blocco F)

- **Data:** 2026-08-04
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Origine:** allineamento a RPT — monitoraggio delle risorse non allocate o non fatturabili (bench), con anzianità A/B/C/D, segnale "si libera il mese prossimo" e domanda di hiring/subco futura.
- **Riferimenti:** `docs/superpowers/specs/2026-08-01-b2-monthly-fte-capacity-design.md` (il rollup mensile che questo blocco riusa); `docs/superpowers/specs/2026-08-02-c1-dummy-subco-multi-fte-design.md` (lo split per kind e il difetto `2cb462b`); `docs/superpowers/specs/2026-08-04-negotiated-sell-rates-design.md` (blocco in corso su un altro branch, forma di riferimento per questo documento e superficie di collisione di merge, non di schema — vedi §9); `docs/roles-and-permissions.md` (i 7 ruoli e le regole RBAC citate al §8).

Le quattro decisioni di prodotto che seguono sono chiuse: sono scritte come design, non come opzioni.

---

## 1. Contesto: cosa manca oggi, con la prova

Il rollup mensile FTE esiste già ed è maturo: `rollupMonthly()` (`src/app/services/capacity.util.ts:70-135`), pura, senza orologio, esposta da `GET /capacity/monthly` (`src/server.ts:3541-3581`). Calcola, per risorsa e per mese, ore confermate/pianificate a partire da `assignmentDays` pesate dallo **status della riga mese** che possiede quel giorno (`assignmentMonths`, regola B3 — mai il rollup derivato dell'assignment, `capacity.util.ts:81-89`). L'handler ha **già una finestra di 6 mesi di default** (`to = from + 5` quando `to` non è passato, `src/server.ts:3563`), quindi la meccanica di finestra che questo blocco chiede ("disponibilità a 6 mesi") non va inventata, va solo riletta con un altro obiettivo.

Quello che manca, con la riga esatta:

1. **Nessuna tricotomia BENCH/PARTIAL/ALLOCATED.** `rollupMonthly` colora con `semaphoreBand()` (`capacity.util.ts:46-52`) su `SEMAPHORE_THRESHOLDS = {idle:50, under:85, healthy:105}` (`capacity.util.ts:5`) — una scala continua a 4 bande pensata per la saturazione interna, non uno stato a 3 di bench. Non è riusabile as-is.
2. **Split sbagliato per un bench.** `rollupMonthly` partiziona su `countsTowardInternalCapacity` (`resource-kind.util.ts:75-77`): dummy e subco finiscono insieme in `demandRows` con `band:'idle'` hard-coded (`capacity.util.ts:120-125`) — un subco sotto-allocato, che è bench vero, sparisce nello stesso mucchio di un dummy, che non lo è mai.
3. **Nessuna anzianità e nessun segnale "in scadenza".** Nessun equivalente di `AR_AGING_BUCKETS`/`bucketForDaysOverdue`/`arAging` (`src/app/services/finance.util.ts:348-440`) esiste per "da quanti mesi questa risorsa è ferma", né un modo di segnalare "si libera il mese prossimo".
4. **Nessuna domanda di hiring aggregata.** I dummy vengono trattati come "domanda scoperta" solo dentro `demandFteUncovered`, mai isolati da subco, mai esposti come "questi profili vanno assunti/subappaltati".
5. **Nessuna colonna di disponibilità.** Nessuna superficie oggi risponde a "da quando è libera questa persona".

Non è un problema di dati mancanti: `resources`, `assignments`, `assignmentDays`, `assignmentMonths` bastano già (verificato in dettaglio al §2). È un problema di **classificazione mancante** sopra numeri che esistono.

## 2. Derivazione pura: nessuna tabella nuova, nessuna migration

**Decisione: Blocco F è pura derivazione.**

Ogni input che serve — `resources` (kind `src/db/schema.ts:108`, capacity `:97`, hireDate `:117`, terminationDate `:118`, contractHoursPerDay `:101`), `assignments`, `assignmentDays`, `assignmentMonths` — esiste già ed è lo stesso set che alimenta `rollupMonthly`. Blocco F è la stessa classe di lavoro di `arAging()` o `rollupMonthly()`: funzioni pure su righe già persistite, zero impronta di schema.

**Conseguenza pratica:** nessuna migration, nessun ordine di seed da coordinare, nessuna collisione con la tabella `negotiated_rates` in corso sull'altro branch (quel blocco tocca `finance.util.ts` solo sul pricing as-incurred e `server.ts` solo con un blocco isolato — nessuna sovrapposizione con `capacity.util.ts` o con le righe 3541-3581). L'unica superficie di collisione reale sono i file frontend condivisi (`dashboard.component.ts`, `reporting.ts`), toccati anche dall'altro branch — è un collisione testuale di merge (stesso blocco di `forkJoin`), non semantica: si evita aggiungendo i campi di F in coda a quei blocchi, non nello stesso punto esatto.

## 3. BENCH / PARTIAL / ALLOCATED al mese

**La fonte del numero è `ftePlanned`/`plannedHours`, non una nuova somma di ore.** `rollupMonthly` già calcola, per ogni risorsa e ogni mese, `fteOf(src.planned, target)` (`capacity.util.ts:110-111,43-44`) dove `target = standardMonthlyHours(month, hoursPerDay, holidays)` e `src.planned` somma le ore il cui giorno appartiene a una riga mese con status in `PLANNED = {'Requested','Allocated'}` (`capacity.util.ts:38`). Il semaforo interno esistente colora **già** su `ftePlanned`, non su `fteConfirmed`: Blocco F segue lo stesso segnale, così le due viste non possono disaccordarsi su "quale dei due numeri descrive quanto è impegnata questa persona". Un `Requested` non ancora approvato conta già come impegno — un bench dashboard che lo ignorasse mostrerebbe disponibile chi è già in corso di staffing.

**Soglie nuove, non il semaforo esistente:**

| Stato | Condizione esatta | Cosa succede al confine |
|---|---|---|
| **BENCH** | `plannedHours === 0` nel mese (nessuna ora Requested/Allocated) | Una singola ora Requested toglie immediatamente la risorsa dal bench: deliberato, il segnale deve essere sensibile a uno staffing appena iniziato |
| **PARTIAL** | `0 < plannedHours < targetHours` del mese | — |
| **ALLOCATED** | `plannedHours >= targetHours` del mese | Include il sovra-allocato (>100%): non si introduce un quarto stato "over" — quel segnale è già di competenza del semaforo/badge esistenti (§9), duplicarlo qui creerebbe un secondo numero sulla stessa cosa |

**Punto di rigore:** la classificazione si decide sulle **ore grezze non arrotondate** (`plannedHours`, `targetHours`), mai sulla percentuale già arrotondata a 2 decimali per la UI. Una risorsa con 0,4 ore pianificate su ~160 ore standard arrotonda a "0,00%" in visualizzazione ma **non** è BENCH — ha una prenotazione reale, per quanto minuscola. Il fixture del §11 (risorsa 6, mese di aprile) pinna esattamente questo confine.

## 4. Lo split per kind: chi entra nel bench e chi no

`countsTowardDeliveryCapacity(kind)` (`resource-kind.util.ts:96-98`) è **vero per `internal` e `subco`, falso solo per `dummy`** — deliberatamente indipendente da `countsTowardInternalCapacity` (`:75-77`, doc a `:79-97`): la prima misura "quanto può consegnare l'organizzazione", la seconda "la saturazione di un dipendente". Un bench dashboard risponde alla prima domanda.

**Decisione: il predicato che entra nel bench è `countsTowardDeliveryCapacity(kindOf(r))`.** Un dummy non entra mai in una cifra di bench: non è il tempo libero di nessuno, è un buco da riempire (§6). Un subco sotto-allocato **è** bench vero, esattamente come un interno.

Questo split ha già causato un difetto reale in questo progetto: il commit `2cb462b` ha dovuto correggere `overbookedBadge` in `src/app/app.ts:659-660`, che filtrava con un `utilization > 110` senza lo split per kind. `rollupMonthly` stesso **sbaglia per uno scopo bench** — partiziona su `countsTowardInternalCapacity`, corretto per il proprio semaforo, sbagliato se riusato qui as-is. Blocco F non riusa `rows`/`demandRows` di `rollupMonthly` verbatim: riusa l'aritmetica delle ore per-cella (`capacity.util.ts:105-127`, identica per ogni kind) e ripartiziona da zero con `countsTowardDeliveryCapacity`.

**Decisione 4 — il subco ha una sezione propria, non un badge in una lista unica.** L'azione è economicamente opposta a quella su un interno — un interno idle si riallocca, un subco idle non si rinnova/estende il contratto col vendor, e il suo costo si ferma in un modo diverso — quindi un totale unico interno+subco non corrisponderebbe a nessuna azione concreta. L'opzione opposta, escludere il subco dal bench, è stata scartata: un subco pagato e non impiegato è una perdita reale che nessun'altra schermata riporta. Conseguenza sul modello dati e sulla UI (dettagliata al §8/§10): `BenchRollup` restituisce `internalRows` e `subcoRows` come due liste separate, mai una lista unica con badge di kind, e **nessuna superficie di questo blocco somma i due conteggi in un totale unico** — vedi §12.

## 5. Anzianità: le tre durate B/C/D e il segnale "si libera il mese prossimo"

Forma da rispecchiare: `AR_AGING_BUCKETS` come tupla ordinata di stringhe letterali, un classificatore puro (`bucketForDaysOverdue`), un `emptyBuckets()` pre-popolato, un aggregatore (`arAging`) — tutto in `finance.util.ts:348-440`. Differenza che conta: `AR_AGING_BUCKETS` bucketa in una sola direzione (giorni di ritardo, sempre ≥ 0); qui invece convivono una durata già trascorsa (quanto è già ferma) e un preavviso (sta per fermarsi) — due domande diverse.

**Decisione 1 (chiusa): il segnale "si libera il mese prossimo" resta strutturalmente distinto dai bucket di durata**, non un quarto bucket nella stessa tupla. Risponde a una domanda diversa — le durate dicono "da quanto è ferma questa persona", questo dice "questa persona sta per diventare ferma". Fonderli direbbe "riallocca ora" dove il segnale era "pianifica in anticipo". Sono anche **mutuamente esclusivi per costruzione**: il segnale forward-looking richiede `state(mese) !== BENCH`, i bucket B/C/D richiedono `state(mese) === BENCH` — una risorsa non può avere entrambi nello stesso mese.

### 5.1 I tre bucket di durata (retrospettivi)

```ts
export const UNALLOCATED_AGING_BUCKETS = ['B', 'C', 'D'] as const;
export type UnallocatedAgingBucket = typeof UNALLOCATED_AGING_BUCKETS[number];
```

Serve una sequenza `benchFlags: boolean[]` per risorsa, una per mese del range fetchato (§8), dove **`benchFlags[i] = isActiveInMonth(resource, months[i]) && state(months[i]) === 'BENCH'`** — la stessa guardia `isActiveInMonth()` (`capacity.util.ts:63-68`) già usata da `rollupMonthly`, applicata qui prima della verifica di stato. Questa singola definizione basta a coprire **sia** "non ancora assunta" **sia** "già terminata" senza logica speciale nel conteggio: in entrambi i casi il mese non è un mese di bench osservabile, quindi la sequenza deve leggerlo come `false`, non come "dato mancante".

```ts
export function monthsIdleAt(benchFlags: readonly boolean[], index: number): number {
  let n = 0;
  for (let i = index; i >= 0 && benchFlags[i]; i--) { n++; if (n >= 3) break; }
  return n;
}
export function bucketForMonthsIdle(monthsIdle: number): UnallocatedAgingBucket {
  if (monthsIdle <= 1) return 'B';
  if (monthsIdle === 2) return 'C';
  return 'D'; // >= 3, capped — mai chiamato con monthsIdle <= 0
}
```

| Bucket | `monthsIdle` | Cosa succede al confine |
|---|---|---|
| **B — sotto 1 mese** | `1` (BENCH questo mese, non lo era il mese prima — o il mese prima non è attivo perché la risorsa non era ancora assunta) | Una risorsa assunta proprio nel mese mostrato e già BENCH parte da B, **mai** da D — il fixture §11 (risorsa 8) lo pinna: nessuna assenza di dati precedenti alla `hireDate` si legge come "ferma da sempre" |
| **C — 1-2 mesi** | `2` | — |
| **D — oltre 2 mesi** | `>= 3` (capped: il conteggio si ferma a 3, non serve guardare oltre) | Una volta raggiunta D la risorsa ci resta finché non torna PARTIAL/ALLOCATED — nessun sotto-livello, per lo stesso motivo per cui `AR_AGING_BUCKETS` non spacca ulteriormente `'90+'` |

`bucketForMonthsIdle` non viene mai invocato con `monthsIdle === 0`: l'anzianità si calcola **solo** per un mese in cui `state === 'BENCH'` (`agingBucket` è **assente**, non un valore sentinella, sugli altri due stati — vedi §8).

### 5.2 Il segnale forward-looking

```ts
export function freeingUpNextMonth(
  activeThis: boolean, stateThis: BenchState,
  activeNext: boolean, stateNext: BenchState | undefined,
): boolean {
  return activeThis && stateThis !== 'BENCH' && activeNext && stateNext === 'BENCH';
}
```

`upcomingUnallocated` è `true` **solo** se la risorsa è attiva ed **allocata/parziale** questo mese **e** attiva e BENCH il mese successivo. La clausola `activeNext` è deliberata: una risorsa che **termina** fra questo mese e il prossimo (fine rapporto/fine contratto col vendor) non viene marcata "si libera" — quello è un offboarding, non un segnale di ricollocazione, ed è fuori scope qui (§12).

Il fixture §11 copre **entrambe** le varianti: una transizione ordinaria interamente dentro la finestra mostrata (risorsa 6, aprile→maggio) e una al **confine** che richiede il mese di look-ahead oltre la finestra (risorsa 7, settembre→ottobre — §8).

## 6. La domanda di hiring dai dummy

**Correzione necessaria alla formulazione "dummy non ancora sostituiti":** non esiste, nel modello dati, un campo che sopravvive per rispondere a questa domanda in modo storico.

`replacedFromAssignmentMonthId` (`src/db/schema.ts:250`, con `replacedDays`/`replacedBaselineDays` a `:251-252`) vive sulla riga mese della risorsa **reale** (target), non su quella del dummy. Viene scritto da `transferDummyMonth()` (`src/server.ts:2476-2679`) — ma **solo** sul ramo che richiede approvazione; sul ramo self-managed viene scritto e **cancellato nella stessa chiamata**. Viene **sempre cancellato** — approvazione, rigetto, retarget, cancellazione assignment — via `closeLink()`, sempre con `null` espliciti su tutte e tre le colonne. **Conseguenza:** il collegamento è non-vuoto solo nella finestra stretta fra richiesta di sostituzione e decisione — un "in sospeso" transitorio, non un record durevole. **"Hiring demand da dummy non ancora sostituiti" non è calcolabile da `replacedFromAssignmentMonthId`.**

**Decisione: ridefinire la domanda su ciò che sopravvive.** Hiring demand = ore ancora prenotate, oggi, sulle proprie `assignmentDays`/`assignmentMonths` di risorse `kind==='dummy'`, per ciascun mese futuro della finestra — esattamente lo stesso calcolo di `dummyMonthHours()` (`src/server.ts:2686-2691`), esteso a tutti i mesi e a tutti i dummy. Finché ore restano prenotate su un dummy, quel bisogno non è coperto — l'unico modo in cui quelle ore lasciano il dummy è un trasferimento riuscito, che le sposta fisicamente sulle righe della risorsa reale. Questo è calcolabile ora, con la stessa freschezza dei dati di prenotazione del dummy.

```ts
export interface HiringDemandRow { month: string; role: string; hours: number; }
```

**Unità: `hours` è in ORE, raw, non arrotondate.** `hiringDemandByMonth` somma, per (mese, role), le ore il cui giorno appartiene a una riga mese con status in `PLANNED` (lo stesso set di `capacity.util.ts:38`), sulle sole righe `demandRows`-equivalenti il cui `kindOf(risorsa) === 'dummy'` — mentre le righe con `kind === 'subco'` confluiscono nel bench (§3/§4), non qui. Più dummy con lo stesso `role` nello stesso mese si aggregano in **una** riga (somma delle ore) — l'headcount implicito ("quanti profili servono") si deriva a rendering, mai in salvataggio, come FTE: `fteOf(hours, standardMonthlyHours(month, hoursPerDay, holidays))`, arrotondato a 2 decimali **solo** in UI (§10).

## 7. La data di disponibilità

**Decisione 3 (chiusa): la disponibilità è calcolata su un orizzonte fisso di 6 mesi, con un marcatore quando cade oltre — e il campo non è mai vuoto.** In una tabella di bench una cella vuota si legge come "dato mancante" e nasconderebbe esattamente le persone che vanno riallocate.

```ts
export type AvailabilityDate =
  | { kind: 'date'; date: string }                    // ISO YYYY-MM-DD
  | { kind: 'beyond-horizon'; horizonEndMonth: string }; // YYYY-MM, l'ultimo mese mostrato
```

Regole, nell'ordine in cui si applicano, su `cells` (le 6 celle mostrate di una risorsa, in ordine) e `today` (parametro esplicito, mai un orologio letto dentro il layer):

1. Se la prima cella mostrata (`from`, il mese "corrente") ha `state === 'BENCH'` → `{ kind: 'date', date: today }`. Libera ora, disponibile da oggi — non dal 1° del mese, che potrebbe essere nel passato rispetto a `today`.
2. Altrimenti, il primo mese `M` (fra i 6 mostrati) con `state === 'BENCH'` → `{ kind: 'date', date: '<M>-01' }` — il 1° di quel mese. Questo resta il valore anche se la risorsa torna ALLOCATED in un mese successivo ancora dentro la finestra: il campo risponde a "quando si libera la prima volta", non a "resta libera per sempre da lì".
3. Se nessuno dei 6 mesi mostrati è BENCH → `{ kind: 'beyond-horizon', horizonEndMonth: to }` (`to` = ultimo mese mostrato), reso in UI come "Beyond \<mese abbreviato\>".

**Punto che va dichiarato esplicitamente, non lasciato implicito:** questo calcolo usa **solo** i 6 mesi mostrati — **mai** il mese di look-ahead (`to+1`) fetchato per il segnale forward-looking del §5.2, anche quando quel mese avrebbe dato una risposta più precisa. Il fixture §11 (risorsa 7) mostra il caso: la risorsa è marcata `upcomingUnallocated` a settembre (si libera in ottobre, che il server *ha* già fetchato) **e contemporaneamente** la sua `availabilityDate` è `beyond-horizon` su settembre — non una contraddizione, ma due campi con scope di dati deliberatamente diversi: estendere la data di disponibilità nel mese di look-ahead la farebbe dipendere da una finestra di fetch pensata per un altro campo, che cambierebbe se in futuro il look-ahead sparisse o si allargasse per altre ragioni.

## 8. Superficie tecnica

Nessuna tabella nuova (§2). Due file nuovi, in continuità con le convenzioni esistenti:

**`src/app/services/bench.util.ts`** — layer puro, nessun I/O, nessun orologio.

```ts
export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED';
export interface BenchCell {
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket; // presente SOLO se state === 'BENCH'
  upcomingUnallocated: boolean;
}
export interface BenchRow {
  resourceId: string; resourceName: string; kind: 'internal' | 'subco';
  monthly: Record<string, BenchCell>; // chiave: i 6 mesi mostrati
  availabilityDate: AvailabilityDate;
}
export interface BenchRollup {
  months: string[];           // i 6 mesi mostrati, ascendenti
  internalRows: BenchRow[];
  subcoRows: BenchRow[];
  hiringDemand: HiringDemandRow[];
}
```

Esporta inoltre `benchStateFor(plannedHours, targetHours): BenchState` (§3), `UNALLOCATED_AGING_BUCKETS`, `bucketForMonthsIdle`, `monthsIdleAt`, `freeingUpNextMonth`, `availabilityDateFor`, `hiringDemandByMonth`, e la funzione che le compone tutte, `benchRollup(input)`. `benchRollup` riceve lo stesso tipo di `RollupInput` di `rollupMonthly` (`capacity.util.ts:30-35`) più due liste di mesi distinte, mai una sola:

- `months: string[]` — i **9** mesi effettivamente fetchati (2 di look-back + 6 mostrati + 1 di look-ahead, vedi sotto);
- `displayMonths: string[]` — i 6 mesi da restituire come righe.

Un `round2` locale, sulla falsariga di `match.util.ts:76`/`substitution.util.ts:18` — nessun export condiviso esiste in questo progetto per un arrotondamento a 2 decimali; il round2 si applica **solo** dentro le funzioni di rendering della UI (§10), mai dentro `benchRollup`.

**`GET /bench/monthly`** in `src/server.ts` — bespoke ma sola lettura: nessun handler di scrittura, nessuna regola di integrità da validare, nessuna voce nell'audit log (niente muta). Accetta lo stesso parametro opzionale `from` di `/capacity/monthly`, con lo stesso default (prima planning period Open, altrimenti il mese corrente — `src/server.ts:3556-3563`), ma **non** accetta `to`: la finestra è fissa a `from + 5`, non configurabile dal chiamante.

**Finestra di fetch — 9 mesi, non 8.** Il segnale forward-looking (§5.2) sull'**ultimo** mese mostrato (`to`) richiede lo stato del mese successivo (`to+1`), che non è fra i 6 mostrati. La finestra di fetch di `assignmentDays`/`assignmentMonths` è quindi **`[from-2, to+1]`** — 2 mesi di look-back per l'anzianità dei primi due mesi mostrati (per un mese `from+k` con `k>=2` i due mesi precedenti sono già dentro la finestra mostrata) più 1 mese di look-ahead per il segnale forward-looking dell'ultimo mese mostrato. Nessuno dei 3 mesi extra (`from-2`, `from-1`, `to+1`) viene restituito come riga propria — servono solo a risolvere anzianità e segnale dei mesi richiesti.

**RBAC — decisione deliberata, non un default.** `/bench` copre esattamente lo stesso need-to-know di `/capacity`: **`pm`, `resource-manager`, `delivery-executive`, `finance`, `admin`** (`src/server.ts:721`, `role.guard.ts:65` `CAPACITY_ROLES`). Motivazione esplicita, non ereditata per pigrizia:

- `pm`/`resource-manager` decidono staffing e riallocazione — è il loro strumento di lavoro primario;
- `delivery-executive` ha supervisione trasversale su delivery;
- `finance` perché il costo di un dummy/subco non impiegato ha impatto diretto a conto economico — è esattamente il senso di "Unchargeable" nel nome del blocco;
- `admin` sempre;
- **`employee` escluso deliberatamente**: non è una vista self-service, è un elenco org-wide di persone (compresi colleghi) ferme — sensibile, e l'`employee` ha per definizione visibilità solo sul proprio profilo/assegnazioni (`docs/roles-and-permissions.md`);
- **`sales` escluso deliberatamente**: gestisce clienti/contratti/ordini, non ha responsabilità di staffing né need-to-know sullo stato di idle del personale interno — estendere la regola commerciale qui sarebbe uno scope creep.

Implementazione: estendere il test della regola `/capacity` esistente a `p.startsWith('/capacity') || p.startsWith('/bench')` (stessa riga 721, stesso array di ruoli), invece di duplicare l'array in una entry nuova. Lato frontend, nuova route `{ path: 'bench', title: 'Bench', canMatch: [capacityGuard], ... }` in `app.routes.ts` (accanto alla riga 58 di `capacity`), che riusa `capacityGuard`/`CAPACITY_ROLES` così come sono — zero guard nuove.

## 9. Punti di consumo

| Superficie | Verdetto |
|---|---|
| `/capacity` (`capacity.component.ts`) | **Non tocca.** Resta il semaforo di saturazione interna; guadagna solo un link di navigazione verso `/bench` |
| `/utilization` (`utilization.component.ts`) | **Consumatore.** `managedResources` (righe 351-357) **non filtra per kind** — include già internal, subco **e dummy** nella lista "My Team", non solo internal+subco come lascerebbe intendere una lettura superficiale. Il nuovo badge di stato bench (mese corrente) si applica quindi con tre esiti distinti per riga: internal/subco mostrano lo stato reale (BENCH/PARTIAL/ALLOCATED, più il bucket se BENCH); una riga **dummy** mostra un badge "Not applicable" — distinto sia dallo stato di caricamento sia da un bench vuoto — perché un dummy non entra mai nel bench (§4) e non deve leggersi come "dato mancante". `averageUtilization` (righe 367-374, filtrata su `countsTowardInternalCapacity`) **resta invariata**: KPI diversa (saturazione interna), non va confusa col bench. Il badge eredita **entrambe** le viste esistenti (`teamScope` `'direct'`/`'org'`, riga 343) automaticamente, perché si aggiunge alla stessa lista di righe che quelle viste già filtrano |
| `/dashboard` (`dashboard.component.ts`) | **Consumatore.** Nuova tile "In bench" con **due numeri separati**, mai sommati (decisione 4): conteggio interni in bench e conteggio subco in bench, entrambi per il mese corrente. Alimentata in coda allo stesso `forkJoin`/`dataRes` esistente (righe 599-600, gated su `authReady() && canViewPortfolioDashboard()`) — append, non nello stesso punto esatto dei campi `contracts`/`negotiatedRates` già aggiunti lì dall'altro branch, per evitare la collisione testuale (§2) |
| `src/app/app.ts` — `overbookedBadge` | **Non tocca.** KPI di sovra-allocazione (righe 659-660), concetto diverso dal bench — resta corretto per lo split kind fissato da `2cb462b`, non va toccato qui |
| `/reporting` (`reporting.ts`) | **Non tocca, deliberatamente.** Il grafico utilization è internal-only per scelta esplicita (didascalia riga 249: "dummy and subco are uncovered demand, not capacity") — stessa partizione di `countsTowardInternalCapacity` di `rollupMonthly`, non quella di delivery-capacity. Iniettarci le cifre di bench confonderebbe due domande diverse nello stesso grafico |
| `/forecast` + `/forecast/what-if` (`forecast.util.ts`) | **Decisione 2 (chiusa): sostituito, non affiancato.** `benchList()`/`BenchEntry` (righe 309-331, 59-67) sono **rimossi**: leggevano dallo scalare stantio `resource.utilization` whole-of-time (§1 di questo documento, sezione facts non riportata qui ma verificata a codice), non da `assignmentDays`/`assignmentMonths` mensili. Il pannello "available for reallocation" di `forecast.ts`/`what-if.ts` viene ripuntato su `bench.util.ts`: usa `benchRollup(...).internalRows.concat(subcoRows)`, filtrato su `monthly[from].state !== 'ALLOCATED'` (BENCH **o** PARTIAL — la stessa nozione di "non pienamente allocato" che il vecchio `thresholdPct=80` approssimava con una soglia continua, ora sostituita dalla tricotomia unica, non da un secondo parametro). **Costo di wiring esplicito, non nascosto:** `ForecastData` (righe 33-36) oggi porta solo `resources`/`assignments` — va esteso con `assignmentDays`, `assignmentMonths`, `holidays`, `hoursPerDay` (gli stessi quattro input aggiuntivi che `benchRollup` richiede), e il `dataRes` di `forecast.ts`/`what-if.ts` (righe 337-338/405-406, già gated su `authReady()`) deve fetcharli, sullo stesso modello di `reporting.ts`/`dashboard.component.ts`. `overAllocated()` (KPI diversa, sovra-allocazione) **non tocca** |
| `/my-profile`, `/my-assignments`, `/resource-requests`, `/staffing` | **Non tocca.** Widget di identità/candidatura a colpo d'occhio sullo scalare stantio; retrofittarli sul bench mensile è fuori scope (§12) |
| `/config/availability` (`maintain-availability-data.component.ts`) | **Non tocca — falso match.** Stub di import CSV per un feed HR esterno, non ha nulla a che fare con la disponibilità derivata di questo blocco |

## 10. UI e caricamento

Nuova route `/bench` (titolo nav "Bench", componente `src/app/bench/bench.component.ts`), accanto a `/capacity` nella stessa area di navigazione. Layout in due pannelli:

- **Bench**, **due sezioni separate** (decisione 4) — "Internal" e "Subcontractors" — mai una lista unica con badge di kind. Ogni riga: nome, stato del mese corrente (con bucket B/C/D se BENCH), badge "Freeing up next month" se `upcomingUnallocated` è vero, colonna disponibilità (§7, mai vuota: una data concreta o "Beyond \<mese\>"). Ogni sezione riporta il proprio conteggio e la propria "% on bench" (conteggio bench della sezione / conteggio eleggibile attivo nel mese corrente per quel kind, `× 100`) — **due percentuali indipendenti, mai una combinata** (§4, §12).
- **Hiring demand**, per mese, con `role` (campo già esistente sul dummy, nessun calcolo nuovo) e la conversione a FTE solo a rendering (§6).

**Caricamento — il pattern esistente si applica senza eccezioni.** La route è gated su `authReady()`: il `rxResource` che fetcha `/bench/monthly` chiave i propri `params` su `this.auth.authReady()` e restituisce un default vuoto finché non diventa `true` — mai un valore letto da `auth.userId()`/`auth.role()` snapshottato a field-init. Stesso schema per il badge aggiunto a `/utilization` (che estende il `dataResource` già gated su `authReady()`, righe 298-299) e per la tile di `/dashboard` (che estende `dataRes`, già gated su `authReady() && canViewPortfolioDashboard()`, righe 599-600) — nessuna nuova fetch di questo blocco parte prima che il bootstrap OIDC sia risolto.

**Stato di errore distinto da "vuoto".** Tre stati, mai due: caricamento (skeleton, `app-list-state` con `[loading]`, `src/app/shared/list-state.component.ts:16-41`) → errore (pannello con Retry, `[error]="res.status() === 'error'"`) → contenuto. Un 403 su `/bench/monthly` (ruolo non autorizzato) non può presentarsi qui in pratica, perché sia la route (`capacityGuard`) sia il capability-gate lato client (`canViewPortfolioDashboard()` per la tile dashboard) già impediscono la fetch a un ruolo non idoneo — ma un errore di **rete o server** (5xx, timeout) durante il caricamento **deve** mostrare lo stato di errore, mai una lista bench vuota presentata come "nessuno in bench": zero è un valore reale (BENCH vero) solo quando la fetch è risolta con successo, mai quando è fallita.

**Regola dei due decimali.** Ogni quantità mostrata porta un `digitsInfo` esplicito, mai il default di `DecimalPipe` (`1.0-3`):

| Quantità | Unità | `digitsInfo` | Precedente nel codice |
|---|---|---|---|
| FTE (hiring demand convertita) | FTE (rapporto ore/ore standard, adimensionale) | `1.0-2` | — nuovo per questo blocco |
| "% on bench" (per sezione) | percentuale di headcount eleggibile | `1.0-0` | `utilization.component.ts:44` (`averageUtilization`) |
| Ore (se mostrate in tooltip/dettaglio) | ore | `1.0-0` | `capacity.component.ts:326` (`plannedHours`) |
| `monthsIdle` | conteggio di mesi, intero 1-3 (capped) | nessun pipe — è già un intero per costruzione | — |
| `availabilityDate` (data concreta) | data di calendario | formato giorno-mese-anno esteso | analogo a `MONTH_LONG_FMT`, `capacity.component.ts:507-510` |
| `availabilityDate` (oltre-orizzonte) | mese di calendario | stesso formato breve di `monthLabel`, prefissato "Beyond " | `MONTH_FMT`, `capacity.component.ts:502-505` |

La classificazione (§3) si decide **prima** di questo arrotondamento, sui valori grezzi — l'arrotondamento è solo l'ultimo passo prima di mostrare il numero, mai un input alla logica di stato.

## 11. Verifica

**Unit sul layer puro** (`bench.util.spec.ts`): `benchStateFor` ai tre confini esatti (0, appena sopra 0, appena sotto il target, esattamente al target, sopra il target); `monthsIdleAt` a 0/1/2/3+ mesi consecutivi; `freeingUpNextMonth` sulle quattro combinazioni di `activeThis`/`activeNext`; `availabilityDateFor` sui tre rami (oggi, mese futuro dentro la finestra, oltre-orizzonte); `hiringDemandByMonth` che isola i soli dummy e aggrega per `role`; split per kind (un dummy non appare mai in bench, un subco sì).

**Il caso che conta più di tutti:** un subco sotto-allocato deve comparire in bench esattamente come un interno — se sparisce è il difetto già occorso una volta in questo progetto (`2cb462b`) su un'altra superficie.

**Fixture — ogni check accoppiato al suo gemello positivo**, perché in un seed piccolo "il bench è vuoto" è il check che passa per mancanza di dati, non per correttezza. Con anchor `from = '2026-04'` (prima planning period Open, `src/db/seed.ts:246`), finestra mostrata `2026-04..2026-09`, finestra fetchata `2026-02..2026-10`:

| # | Risorsa (da aggiungere/estendere in `src/db/seed.ts`) | Seed | Risultato atteso, verificabile per costruzione |
|---|---|---|---|
| 1 | **Risorsa `'6'` (esistente, subco)** — nuove `assignments`/`requests`: full allocation feb-mar 2026, un giorno singolo con ore minime (es. 0,1-0,5h) ad aprile, nessuna prenotazione mag-set | apr = PARTIAL (ore>0 ma arrotondano a "0,00%" — pinna il §3); mag = BENCH/**B**; giu = BENCH/**C**; lug-set = BENCH/**D** (capped); `upcomingUnallocated(apr)=true` (mag è BENCH); riga **solo** in `subcoRows`, mai in `internalRows`; `availabilityDate` = `{date:'2026-05-01'}` (primo mese BENCH, non "oggi" perché apr è PARTIAL) |
| 2 | **Risorsa `'4'` (esistente, dummy)** — nuova `assignment`/`request`: prenotazione reale (non nulla) coprente apr-set 2026 | riga presente in `hiringDemand` per ciascuno dei 6 mesi, `role='Developer'`, ore > 0; **mai** una riga in `internalRows`/`subcoRows` per la risorsa `'4'`, nonostante abbia ore prenotate reali — pinna lo split dummy/subco su dati non vacui |
| 3 | **Risorsa `'5'` (esistente, dummy)** — **non toccata deliberatamente** | nessuna prenotazione: assente da `hiringDemand`. **Non** è il check "il bench è vuoto" — è annotato esplicitamente come non-fixture, per non farlo scambiare per un test reale |
| 4 | **Nuova risorsa `'7'`, internal**, hireDate 2020, nuova `assignment`/`request`: allocazione piena apr-set 2026 (fine 2026-09-30, nessuna prenotazione oltre) | apr-set = ALLOCATED (mai in bench nella finestra mostrata); `upcomingUnallocated(set)=true` **solo** grazie al mese di look-ahead (2026-10, non mostrato) — pinna la finestra a 9 mesi del §8; `availabilityDate` = `{kind:'beyond-horizon', horizonEndMonth:'2026-09'}`, **nonostante** il flag forward-looking indichi ottobre — pinna la separazione dei due campi del §7 |
| 5 | **Nuova risorsa `'8'`, internal**, hireDate **`2026-04-01`** (= mese anchor), nessuna assignment | apr = BENCH/**B** (non D): la guardia `isActiveInMonth` tronca il look-back a feb/mar, che altrimenti si leggerebbero come "ferma da sempre" — pinna il §5.1; mag = **C**, giu-set = **D** |
| 6 | **Nuova risorsa `'9'`, internal**, hireDate storica, **terminationDate `'2026-03-15'`**, una `assignment`/`request` reale gen-mar15 2026 | **assente** da `internalRows` per **tutti** i 6 mesi mostrati (isActiveInMonth false ovunque in apr-set), nonostante abbia dati di prenotazione reali nella finestra di look-back — pinna l'esclusione per terminazione su dati non vacui, non su un'assenza di dati |
| 7 | **Risorse `'1'/'2'/'3'` (Julie/John/Alice, esistenti, invariate)** | nessuna delle tre ha prenotazioni prima di maggio 2026 nel seed attuale: sono **già** BENCH ad aprile 2026 senza alcuna modifica di questo blocco — controllo di sanità aggiuntivo, gratuito: se una delle tre non compare in `internalRows` per aprile, l'aritmetica di base è rotta indipendentemente da qualunque fixture nuova |

Le risorse `4`, `6`, `9` portano dati di prenotazione **reali** (non assignment vuote) proprio per evitare che l'esclusione/inclusione sia dimostrabile senza eseguire la classificazione — lo stesso principio del report d'impatto sul branch delle tariffe negoziate (§9 del sibling): uno zero o un'assenza dimostrabile *a priori* non è un gate.

**Smoke:** estendere `scripts/smoke-api.mjs` (o un compagno dependency-free sullo stesso modello) con una chiamata a `GET /bench/monthly` sui dati seed: verifica che ogni risorsa `internal`/`subco` attiva riceva esattamente uno stato per mese richiesto, che nessun `dummy` compaia in `internalRows`/`subcoRows`, che la finestra restituita sia sempre di 6 mesi.

**Fresh-Postgres: non è un gate nuovo.** Nessuno schema né migration (§2) — resta valido l'obbligo generale del progetto che gli stessi handler si comportino identicamente sui due adapter, da eseguire come parte della suite normale, non come gate dedicato.

**Browser:** verifica della route `/bench` (le due sezioni, il pannello hiring demand) e del badge aggiunto a `/utilization` in **entrambe** le viste (`direct` e `org`), incluso l'esito "Not applicable" su una riga dummy.

## 12. Cosa questo blocco NON fa

- **Nessun totale combinato interno+subco**, in nessuna superficie (§4, §9, §10) — un numero unico non corrisponderebbe a nessuna azione concreta.
- **Nessuna sostituzione storica ricostruibile.** Non esiste, e non può esistere senza una migration, un modo di sapere "questo dummy-mese è stato sostituito il giorno X" dopo che la decisione è stata presa (§6). Se in futuro servisse un report storico delle sostituzioni, serve un campo persistito nuovo — fuori scope qui.
- **Nessun costo/tariffa sul dashboard.** Il costo giornaliero di dummy/subco è territorio del blocco rate-card/negotiated-sell-rates in corso su un altro branch.
- **Nessuna vista scoped-per-manager su `/bench` stesso.** A differenza di `/utilization` (che ha `teamScope`), `/bench` in questo documento è portfolio-wide come `/capacity`. Un filtro di scope riusando `scopeOf`/`org-scope.util.ts` è possibile ma non richiesto qui — nominato esplicitamente per non farlo un'assunzione silenziosa.
- **Nessun matching di competenze sulla domanda di hiring.** L'aggregato del §6 espone `role` perché è già un campo esistente, non introduce uno skill-gap: quello resta territorio di `forecast.util.ts:skillGap`.
- **Nessuna gestione dell'offboarding come segnale di bench.** Una risorsa che termina fra un mese e il successivo non è marcata `upcomingUnallocated` (§5.2) — è un evento diverso, non una ricollocazione da pianificare.
- **Nessuna estensione della data di disponibilità oltre l'orizzonte di 6 mesi**, anche quando il mese di look-ahead (fetchato per altri scopi) conterrebbe già la risposta (§7) — per non far dipendere un campo da una finestra di fetch pensata per un altro.
