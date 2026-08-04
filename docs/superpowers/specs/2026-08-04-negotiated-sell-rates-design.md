# Design — Prezzo di vendita negoziato per contratto e progetto

- **Data:** 2026-08-04
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Origine:** osservazione dell'utente durante il brainstorming del blocco rate card: «a livello di contratto su un progetto T&M il prezzo di vendita del profilo può cambiare da progetto a progetto». Verificato: **non è gestito**.
- **Riferimenti:** `docs/superpowers/specs/2026-08-03-d-org-hierarchy-people-manager-design.md` (l'albero organizzativo), `docs/superpowers/specs/2026-08-04-org-scope-ui-consistency-design.md` (§6: l'ereditarietà delle rate card lungo l'albero era il blocco previsto, **rinviato dopo questo** — vedi §8).

---

## 1. Il difetto, con la prova

`billRate` esiste oggi in due soli posti:

- **`rateCards {role, organization, currency, costRate, billRate}`** — un listino globale per ruolo + organizzazione (`src/db/schema.ts:448-457`);
- **`resources.cost_rate` / `resources.bill_rate`** — un override per **persona**, valido su tutti i suoi progetti (`src/db/schema.ts:110-111`).

Le righe d'ordine portano solo un `amount` forfettario (`order_lines`, `src/db/schema.ts:757-769`) e gli **assignment non portano alcuna tariffa**.

La risoluzione passa tutta da un punto: `pickRateCard` → `withEffectiveRates` → `resolveResourceRates` (`src/server.ts:1468-1503`), con cinque call site, e **non persiste nulla**: le tariffe sono derivate a ogni lettura.

Il punto in cui questo diventa un errore sui ricavi: la revenue **T&M as-incurred** è `ore approvate × billRate della risorsa` (`src/app/services/finance.util.ts:681`, e la stessa regola descritta a `:623`). Quindi se lo stesso Developer è venduto a 1.200 €/giorno al cliente A e a 1.000 €/giorno al cliente B, il sistema fattura entrambi allo stesso prezzo: **il ricavo è sbagliato su uno dei due, e con esso il margine di quel progetto**.

Non è una comodità mancante: è correttezza sui ricavi.

## 2. Il fatto architetturale che governa il design

**Il prezzo di vendita non è una proprietà della persona.** `withEffectiveRates(resource, cards, hpd)` risolve `billRate` per risorsa, senza contesto di progetto, e restituisce **un** numero. Quella firma non può rispondere alla domanda nuova.

Il design separa quindi tre domande che oggi convivono in due campi:

| Domanda | Chi risponde | Dove si usa |
|---|---|---|
| Quanto **costa** questa persona | `costRate` — **invariato**: è il costo aziendale e non dipende dal progetto | margini, costi, forecast |
| Quanto **vale** in generale | `billRate` — **invariato**: override persona → rate card | billability company-wide, listino di riferimento |
| A quanto è **venduta su questo progetto** | **nuovo**: `sellRateFor(...)` | ricavo T&M as-incurred, margine di progetto |

Il costo non entra in questo blocco. Si tocca solo il lato vendita.

## 3. Modello dati

Una tabella nuova, `negotiatedRates`:

| Colonna | Tipo | Semantica |
|---|---|---|
| `id` | `text` PK | come ogni altra entità |
| `contractId` | `text`, nullable, FK → `contracts.id` | la tariffa vale per tutto il contratto |
| `projectId` | `text`, nullable, FK → `projects.id` | la tariffa vale per quel solo progetto (override) |
| `role` | `text`, notNull | il profilo: **`Resource.role`**, la stessa chiave delle rate card |
| `currency` | `text`, notNull | come `rateCards.currency` |
| `billRate` | `doublePrecision`, notNull | prezzo di vendita in **€/GIORNO**, come le card. **Il valore memorizzato NON è quello consumato**: la conversione in €/ora avviene alla risoluzione — vedi §4.2 |

**`contractId` e `projectId` sono mutuamente esclusivi**: esattamente uno dei due è presente. È un invariante di scrittura (§5), non un vincolo di schema, perché nessun `CHECK` esprime bene «xor» in modo portabile fra i due adapter di questo progetto.

**Decisione utente (aggancio):** tariffa sul **contratto**, con **override per progetto**. La negoziazione avviene sul contratto — `contracts.type` è già `'T&M' | 'Fixed Price' | 'Framework'` — ma un singolo progetto dentro un quadro può avere condizioni proprie. Un progetto senza contratto (`projects.contract_id` è nullable) ricade sul comportamento di oggi.

**Decisione utente (chiave profilo):** **`Resource.role`**. L'alternativa più fedele — `projectRole`, il profilo professionale — è impraticabile ora: **l'assignment non registra quale ruolo la persona ricopre su quel progetto**, quindi il sistema non saprebbe quale prezzo applicare. Aggiungerlo è un blocco a sé, con migration e UI di staffing da estendere; derivarlo dalla richiesta di staffing sarebbe fragile, perché una richiesta che cambia sposterebbe il prezzo sotto i piedi della fatturazione.

## 4. Risoluzione: la precedenza

Nuovo layer puro `src/app/services/sell-rate.util.ts`. Nessun I/O, nessun orologio, nessuna dipendenza Angular — la stessa forma dei layer `org-scope.util` e `resource-kind.util`.

Dato un progetto e un `role`, il prezzo di vendita è il **primo** che esiste:

1. la tariffa negoziata con `projectId` = quel progetto e quel `role`;
2. la tariffa negoziata con `contractId` = il contratto **di** quel progetto e quel `role`;
3. il `billRate` effettivo della risorsa — override persona → rate card — cioè **esattamente il comportamento di oggi**.

Il punto 3 è la garanzia di non-regressione: un progetto senza tariffe negoziate fattura come adesso, e un sistema con la tabella vuota è indistinguibile dal sistema attuale.

**L'override per persona non vince sul prezzo negoziato.** Se il cliente ha firmato 1.000, si fattura 1.000 anche se quella persona ha un override a 1.200. L'override resta ciò che è — un default aziendale — non un prezzo di vendita. Va scritto nel codice accanto alla precedenza, perché è la regola che un lettore futuro è più tentato di invertire.

### 4.2 Unità: il valore memorizzato è €/giorno, la risoluzione restituisce €/ORA

**Questa sezione corregge un errore di questa specifica.** La §3 dice — correttamente — che `billRate` si memorizza in **€/giorno**, come le rate card. Non diceva che deve essere **convertito nel punto di consumo**, e la prima implementazione ha quindi restituito il valore grezzo: `sellRateFor` tornava €/giorno quando vinceva una tariffa negoziata e €/ora quando vinceva il fallback, perché il `referenceBillRate` del punto 3 arriva da `Resource.billRate`, che `withEffectiveRates` (`src/server.ts`) ha **già** diviso per `hoursPerDay`. L'unico consumatore moltiplica quel risultato per le **ore grezze**, quindi 8 ore a un override di 1.150 €/giorno venivano prezzate **9.200 €** invece di 1.150: un'inflazione del ricavo pari esattamente a `hoursPerDay` su ogni superficie T&M, non vista da nessun gate.

Le regole, adesso vincolanti:

- **`NegotiatedRate.billRate` è €/GIORNO** — sulla colonna, nel seed, nelle due form (etichetta «Bill rate (€/day)») e nelle due tabelle. Nessuna conversione in scrittura, nessuna in lettura dall'API: `GET /negotiated-rates` restituisce il valore memorizzato, ed è quello che le tabelle mostrano.
- **`sellRateFor` restituisce €/ORA su OGNI ramo di return.** È l'unità che il suo unico consumatore moltiplica per le ore e quella in cui il fallback già si trova. Una funzione con più rami di return deve restituire una sola unità.
- **La conversione avviene dentro `sellRateFor`** (`src/app/services/sell-rate.util.ts`), ai livelli 1 e 2 della precedenza: `billRate / hoursPerDay`. Il livello 3 (`referenceBillRate`) passa **inalterato**, perché è già oraria. L'asimmetria è il punto: due unità in ingresso, una in uscita.
- **`hoursPerDay` è un PARAMETRO esplicito**, come `date`: il layer puro non legge né un orologio né un setting. Chi chiama fornisce il valore del setting `hoursPerDay` (`FinanceData.hoursPerDay`, riempito da ogni builder; `getHoursPerDay()` sul server). Un divisore inutilizzabile (0, NaN, negativo) ricade su `DEFAULT_HOURS_PER_DAY = 8`, lo stesso fallback di `getHoursPerDay()`, invece di dividere per zero.

Il costo di non averlo scritto qui la prima volta è la lezione da tenere: la specifica dichiarava l'unità del **dato** e non quella dell'**interfaccia**, e nessun fixture dei test codificava l'unità dei numeri che usava, quindi la precedenza era pinnata e l'aritmetica no.

**Valuta:** una tariffa la cui `currency` non è la valuta base viene **ignorata** dalla risoluzione, esattamente come `pickRateCard` fa oggi (`src/server.ts:1470` filtra su `RATE_BASE_CURRENCY`, che è `'EUR'` a `:1449`). Non introduciamo conversione qui.

### 4.1 La validità temporale c'è già: è quella del contratto

**Precisazione dell'utente, e correzione di una prima stesura di questa spec** che l'aveva messa fra i gap: la tariffa di vendita è legata al **periodo del contratto**, quindi ha una validità — e non va inventata, perché `contracts` porta già `startDate` e `endDate` (`src/db/schema.ts:723`).

Conseguenza concreta sulla risoluzione, non solo sulla documentazione: il ricavo as-incurred si calcola **per time entry**, e una time entry ha una data. Quindi il livello 2 della precedenza si applica **solo alle ore la cui data cade nel periodo del contratto**; fuori da quel periodo la tariffa di contratto non esiste e la risoluzione scende al livello 3. `sellRateFor` riceve perciò la **data** come parametro — un valore passato dal chiamante, mai un orologio letto dentro il layer puro.

**Decisione utente:** la validità **coincide** col periodo del contratto e non si aggiungono colonne. Una rinegoziazione si esprime come **nuovo contratto** (o nuovo ordine) col proprio periodo, che è ciò che il modello commerciale già sa fare — e ha la proprietà che conta: aggiungere il nuovo periodo **non muove il passato già fatturato**.

L'alternativa scartata era `validFrom`/`validTo` sulla tariffa, contenuti nel periodo del contratto, per esprimere «1.000 fino a giugno, 1.100 da luglio» dentro lo stesso contratto. Scartata perché trasforma la risoluzione in una ricerca a intervalli, con buchi e sovrapposizioni da validare — il punto in cui questa classe di modelli sbaglia più spesso — e perché il caso reale è già rappresentabile con un secondo contratto.

**Un override di progetto (livello 1) non ha periodo proprio:** vale nel periodo del contratto del progetto quando il progetto ne ha uno; su un progetto senza contratto vale senza limiti di data, perché non c'è nessun periodo da rispettare. Va scritto accanto al codice, perché è l'unico punto in cui i due livelli si comportano diversamente.

## 5. Integrità in scrittura

`/negotiated-rates` è una collezione con **handler bespoke**, non `crud()`: ha regole di integrità referenziale, come `/resource-organizations`.

| Regola | Esito |
|---|---|
| Né `contractId` né `projectId` | 400 |
| Entrambi presenti | 400 |
| `contractId` che non esiste | 400 |
| `projectId` che non esiste | 400 |
| `role` che non esiste nel catalogo project-roles | 400 |
| `currency` vuota (`''`) o non configurata in `/fx-rates` | 400 |
| Duplicato sulla stessa chiave (`contractId`\|`projectId` + `role` + `currency`) | 400, con l'id del record che esiste già |
| `billRate` non numerico, negativo o `null` esplicito | 400 |
| `DELETE` di una tariffa | consentito: i ricavi si ricalcolano dalla precedenza, non ci sono figli |

**Correzione (chiusura del branch):** una prima stesura di questa riga verificava `role` contro le risorse che oggi lo ricoprono (`repos.resources`), respingendo come «errore di battitura» un ruolo che nessuna risorsa possiede ancora. È sbagliato: la tariffa si negozia con il cliente **prima** che qualcuno con quel profilo sia assunto, e il contratto si firma prima dello staffing — quindi l'autorità corretta è il **catalogo `project-roles`** (lo stesso che valida `role`/`requiredRole`/`projectRoles[]` altrove nell'app, via `validateRoleRefs`), non le risorse effettivamente staffate oggi. Resta un 400 solo un ruolo assente da entrambi.

Sulla nota `null`: `pick()` inoltra un `null` letterale (filtra solo `undefined`), e su una colonna `notNull` questo produce una riga corrotta in-memory e un 500 opaco su Postgres. Il blocco D ha chiuso questa classe per `/resource-organizations` dichiarando i campi obbligatori **una volta** in una lista e rifiutandoli in un solo loop; qui si fa lo stesso dal primo giorno, non dopo tre round di review. La stessa lista tratta ora una stringa vuota esplicita (`''`) allo stesso modo di `null` per `role` e `currency`: è la stessa corruzione "svuotato a niente" su una colonna `notNull`, e per `currency` ha una conseguenza concreta — una tariffa con `currency: ''` supera ogni regola sopra e produce una riga che sembra salvata ma che `sellRateFor` (`src/app/services/sell-rate.util.ts`) non legge mai, perché risolve solo tariffe nella valuta base.

**RBAC:** riusare la regola esistente che copre `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` (`src/server.ts:526` per le mutazioni, `:582` per le letture) — `sales`, `finance`, `delivery-executive`, `admin`. Un delivery manager non negozia prezzi. Aggiungere `/negotiated-rates` a **entrambe** quelle liste, non crearne una nuova.

## 6. Punti di consumo

Due, entrambi in `src/app/services/finance.util.ts`:

- **il ricavo as-incurred** (`:681`, regola descritta a `:623`) — oggi `ore × billRate della risorsa`, diventa `ore × sellRateFor(progetto, role)`. È il punto che rende corretti i ricavi T&M e i margini di progetto. **Entrambi i fattori sono orari** (§4.2): `sellRateFor` restituisce €/ora, quindi il builder di `FinanceData` deve passare `hoursPerDay` — senza di esso si prezza con la giornata di default (8h) invece di quella configurata;
- **la billability company-wide** (`:208-214`) — **resta** sul `billRate` di riferimento. Non ha un progetto: è una misura aziendale «quanto vale il nostro tempo», non una fattura. Va commentato nel codice, altrimenti qualcuno la "correggerà" credendo di aver trovato un'incoerenza.

Il layer puro riceve le tariffe come dato: chi lo chiama fornisce la lista, come già accade per le rate card.

## 7. UI

Vive in `src/app/commercial`, dove si gestiscono contratti e ordini.

- Nel dettaglio del **contratto**: una tabella profilo → prezzo/giorno, con aggiunta, modifica e cancellazione.
- Nel dettaglio del **progetto**: la stessa tabella come override, e la riga **ereditata dal contratto** mostrata in grigio quando non è sovrascritta.

Quel grigio è il requisito che conta: mostra *da dove viene* il prezzo applicato, che è la prima domanda di chi controlla un margine. Testo in inglese; classi `command-*` e token esistenti, nessun token nuovo; le `<select>` con opzioni da `@for` usano `[selected]` per opzione e mai `[value]` sul `<select>`.

## 8. Rapporto con l'ereditarietà delle rate card lungo l'albero

Quel blocco — deciso, progettato e **rinviato dopo questo** — fa sì che una card su una capability si applichi alle practice sottostanti. È ortogonale a questo (organizzativo contro commerciale) ma toccherebbe **la stessa funzione**: `pickRateCard` dentro `withEffectiveRates`.

L'ordine è stato deciso così deliberatamente: questo blocco fissa la forma definitiva della catena di risoluzione, e l'ereditarietà si innesta poi **come un livello dentro il punto 3** della precedenza di §4 (il `billRate` di riferimento), senza ridiscutere ciò che sta sopra.

## 9. Report d'impatto — il gate prima del merge

`scripts/negotiated-rate-impact.mjs`, dependency-free, sulla falsariga di `scripts/smoke-api.mjs`: interroga un server avviato, ricalcola il ricavo as-incurred **con** e **senza** le tariffe negoziate, e stampa solo i progetti il cui totale cambia — progetto, ricavo prima, ricavo dopo, delta in euro.

**Su un sistema senza tariffe inserite deve stampare zero righe.** Se stampa qualcosa a tabella vuota, la non-regressione di §4 punto 3 è rotta.

**Ma quello zero, da solo, non è un gate** — ed è il secondo errore di questa specifica. A tabella vuota le due chiamate sono la stessa funzione pura sugli stessi argomenti, quindi i due totali sono identici *per costruzione*: zero righe è dimostrabile senza eseguire alcuna risoluzione. Il gate vero richiede **anche** il caso positivo: **una time entry approvata sul progetto che porta la tariffa negoziata**, nel seed, così che la risoluzione venga davvero eseguita e il report stampi un delta **non nullo e aritmeticamente verificabile**. Senza quella riga di seed il difetto di §4.2 è passato attraverso ogni gate verde del branch: il report diceva zero perché nessun dato esercitava il codice, non perché il calcolo fosse giusto.

Con tariffe inserite, il report è ciò che si guarda **prima** di attivarle su dati reali.

## 10. Verifica

- **Unit sul layer puro** (`sell-rate.util.spec.ts`): progetto batte contratto batte persona; un progetto senza contratto; un `role` senza tariffa; una tariffa in valuta non base ignorata; una tabella vuota che restituisce esattamente il `billRate` di riferimento.
- **Le unità vanno pinnate una contro l'altra** (§4.2): i test di precedenza da soli non bastano, perché ognuno esercita **un** ramo isolato e un errore di unità per-ramo resta invisibile. Serve un caso che, **sullo stesso fixture**, confronti il ramo negoziato con il ramo di fallback e verifichi che siano nella stessa unità e nel rapporto atteso — sotto il difetto quel rapporto era sbagliato esattamente di `hoursPerDay`. E ogni fixture deve rendere visibile l'unità dei suoi numeri (una tariffa negoziata è €/giorno, un `Resource.billRate` è €/ora), altrimenti certifica l'aritmetica sbagliata.
- **Il caso che conta più di tutti:** un **override per persona più alto** del prezzo negoziato **non** deve alzare la fattura. Va pinnato sia nel layer puro sia nello smoke, perché è il difetto che si scoprirebbe solo a fine mese, su una fattura sbagliata.
- **Smoke live**: inserire una tariffa di contratto e vedere il ricavo T&M di quel progetto cambiare del delta atteso; un override di progetto che vince sul contratto; le sette regole di integrità di §5, ognuna **rossa prima** del fix.
- **Gate completi** su entrambi gli adapter, con il run su **Postgres fresco** obbligatorio: c'è una migration, e questo progetto ha già spedito una volta un server che non si avviava su un database vuoto.
- Verifica in browser delle due tabelle, incluso il grigio dell'eredità.

## 11. Gap noti e fuori scope

- **Nessuna rinegoziazione dentro un contratto senza aprirne un altro.** La validità è quella del contratto (§4.1), quindi «1.000 fino a giugno, 1.100 da luglio» **dentro lo stesso contratto** non è esprimibile: va aperto un secondo contratto o ordine col proprio periodo. È la scelta dell'utente, e ha il vantaggio di non muovere il passato già fatturato; se in futuro servisse la granularità infra-contratto, `validFrom`/`validTo` contenuti nel periodo del contratto sono l'estensione, con la risoluzione a intervalli che ne consegue.
- **Il profilo resta `Resource.role`.** Il `projectRole` per assignment è il blocco che lo renderebbe possibile (§3).
- **Nessuna conversione valutaria** nella risoluzione (§4).
- **La billability company-wide non diventa per-progetto** (§6), deliberatamente.
- **`Fixed Price` e `Milestone` non sono toccati:** il loro ricavo non passa da `ore × billRate`, quindi una tariffa negoziata non li influenza. Va detto, perché un utente potrebbe inserirne una su un contratto Fixed Price e aspettarsi un effetto.
