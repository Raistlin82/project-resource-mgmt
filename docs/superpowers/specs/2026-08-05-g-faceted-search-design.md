# Design — Ricerca a faccette (Blocco G)

- **Data:** 2026-08-05
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Origine:** allineamento al Lutech RPT — dopo E (budget/PCP baseline) e F (bench/disponibilità), G è la ricerca a faccette: un'unica superficie che trova record fra tipi di entità diversi, con facce di filtro, invece dei filtri locali reinventati schermo per schermo.
- **Riferimenti:** `.superpowers/design-drafts/g-facts.md` (ricognizione a codice — ogni citazione file:line di questo documento è stata riverificata leggendo il file sul commit `f2b6edd`, non ereditata dal draft); `docs/roles-and-permissions.md` (RBAC, da aggiornare — §12); `docs/superpowers/specs/2026-08-04-f-bench-availability-design.md` (forma di riferimento per questo documento); `src/server/authz-policy.util.ts` (il primitivo di autorizzazione già esistente che questo blocco riusa, non re-implementa).

Le quattro decisioni di prodotto che seguono sono chiuse: sono scritte come design, non come opzioni. La sezione "Domande aperte" del draft è stata risolta e non compare più in questo documento.

---

## 1. Contesto: cosa manca oggi, con la prova

Non esiste, oggi, un solo posto in cui filtrare/cercare sia stato risolto una
volta e riusato. `g-facts.md` §1, riverificato riga per riga sul codice
corrente, mostra **7 schermi con un filtro cablato indipendentemente**
(`resources.component.ts`, `staffing.component.ts`, `projects.ts`,
`resource-requests.component.ts`, `allocation-approvals.component.ts`, il suo
`approval-modal.component.ts`, `billing.ts`) più **6 schermi di
configurazione quasi identici** (`manage-cost-categories.component.ts:121`,
`manage-cost-centers.component.ts:171`, `manage-vendors.component.ts:142`,
`manage-industries.component.ts:121`, `manage-partner-roles.component.ts:121`,
`manage-rate-cards.component.ts:223` — ciascuno un `search = signal('')`
byte-per-byte simile) — **13 implementazioni indipendenti** in totale, non le
9 stimate nel brief originale (si veda la nota di riconciliazione in fondo a
questa sezione).

Delle quattro entità che questo blocco mette in perimetro (§2), la situazione
è disomogenea:

- **Risorse** (`resources.component.ts`) — il filtro più ricco dell'app: sei
  predicati ANDati (`filteredResources`, riga 626) — testo libero, un
  `activeOnly` booleano, un `kindFilter`, e tre `<select>` capability/
  practice/competence più un filtro People Manager, tutti derivati via
  `dimensionsOf` (`org-scope.util.ts:69`).
- **Progetti** (`projects.ts`) — un solo box di testo (`searchControl`, riga
  335, un `FormControl` letto via `toSignal`), nessun `<select>`.
- **Richieste** — **non esiste, in nessuno schermo, un filtro sulla LISTA
  delle richieste.** `resource-requests.component.ts:510`'s `searchValue`
  filtra `filteredAvailability` (riga 519) — la lista di risorse CANDIDATE
  per la tab "Availability" di una richiesta aperta — non le richieste
  stesse; `myRequests` (la lista richieste dell'utente corrente) non ha
  nessun filtro testuale. Correzione rispetto al draft: questo non è "un
  quarto idioma di ricerca da migrare", è un **buco**, non una reinvenzione —
  la sezione Richieste di questo blocco introduce una capacità che oggi non
  esiste da nessuna parte, non ne sostituisce una esistente.
- **Cliente/Contratto/Ordine** — **zero filtro, in tutti e tre.**
  `customers.ts`, `contracts.ts`, `orders.ts`: ogni `<select>`/`<input>`
  trovato appartiene al form di creazione/modifica (`formControlName`), mai a
  un filtro sulla lista (verificato: nessun `search`/`filter` fuori dai form).

Il box `command-nav-search` nella sidebar (`app.ts:167`, `navFilter` riga 597,
`filteredGroups` riga 631) ha il vocabolario visivo di una ricerca globale —
icona lente, placeholder, tasto clear — ma filtra `navGroups` (riga 476), una
lista **statica** di etichette di navigazione: digitare "Julie" o "Globex" lì
restituisce "No matches" a prescindere da cosa esista nei dati (`g-facts.md`
§2). Parte del punto di questo blocco è dare a quel box, o a un'affordance
distinta accanto ad esso (§9), un significato che oggi non ha.

**Riconciliazione dei numeri.** Il brief di questo blocco cita "9 schermi con
filtro, 3 senza" come sintesi approssimativa di `g-facts.md`. Il conteggio
verificato a codice è **13 schermi con filtro reinventato** (7 singolarmente
cablati + 6 cataloghi di configurazione quasi identici) e **3 schermi
nell'esatto perimetro di questo blocco con zero filtro** (`customers.ts`,
`contracts.ts`, `orders.ts` — la lettura più probabile del "3" del brief,
dato che sono gli UNICI tre esplicitamente descritti in `g-facts.md` con la
frase "no search box and no dropdown filter of any kind"). Il "9" del brief
non corrisponde a un conteggio letterale di file distinti; questo documento
usa da qui in avanti i numeri verificati (13/3), non li forza a "9/3" — si
veda anche §8 per come questo conteggio guida la decisione di migrazione.

## 2. Perimetro: ricerca di record trasversale su quattro entità, l'ordine per le prossime

**Decisione 1 (chiusa): ricerca trasversale su risorse, progetti, richieste e
la catena commerciale (clienti/contratti/ordini) — v1, non tutto il
gestionale.** Un termine come "Julie" trova la risorsa Julie Armstrong, non
solo filtra un'unica lista già caricata: questo è il punto — `resources.
component.ts` ha già sei filtri combinabili su una lista sola (§1); quello
che manca è trovare un record a prescindere da QUALE schermo lo possiede.

| Entità | In perimetro v1 | Motivazione |
|---|---|---|
| Risorse (`/resources`) | Sì | cardinalità più alta, già cercata localmente, il caso d'uso più citato |
| Progetti (`/projects`) | Sì | leggibile da QUALSIASI principal autenticato (§4) — il caso RBAC più semplice |
| Richieste (`/requests`) | Sì | nessun filtro esiste oggi sulla lista (§1) — capacità nuova, non sostituzione |
| Clienti/Contratti/Ordini (`/customers`, `/contracts`, `/orders`) | Sì | oggi zero filtro locale — la ricerca è il PRIMO modo di trovarli per nome |
| Assignment/giorni/mesi (`/assignments`, `/assignment-days`, `/assignment-months`) | **No** | righe derivate/tecniche (una per giorno di calendario, `assignment_days`, `g-facts.md` §3), non un "record" cercato per nome; raggiungibili indirettamente tramite la risorsa/richiesta proprietaria |
| Cataloghi di configurazione (vendor, cost-center, cost-category, industry, partner-role, rate-card) | **No** | già piccoli e già cercabili localmente (§1); il payoff è basso e il costo RBAC (letture `admin`/`delivery-executive`-only per alcuni) non lo giustifica |
| `/audit-logs` | **No, mai** | log di sistema con la propria pagina paginata (`g-facts.md` §3) — non un record applicativo che un utente "cerca" |

**Ordine dichiarato per l'estensione futura, non un'assunzione silenziosa:**
1. Assignment/richieste-derivate — solo DOPO che una vera indicizzazione
   testuale (§7) giustifichi il volume, dato che sono le collezioni a
   crescita più rapida del progetto (`assignment_days`: una riga per giorno,
   `g-facts.md` §3).
2. Cataloghi di configurazione — bassa priorità dichiarata: già cercabili
   localmente ai loro volumi attuali (§1), payoff marginale.
3. Mai `/audit-logs` — ha già la propria pagina, e "cercare un log" non è la
   stessa azione di "trovare un record applicativo".

## 3. Architettura di trasporto: zero nuovi endpoint, sei letture esistenti estese

**Punto di rigore, la decisione tecnica più importante di questo documento.**
Il draft (§3, Domanda 2 originale) ipotizzava "un endpoint di ricerca" al
singolare, sul modello di `/audit-logs`. Verificando `/audit-logs`
(`server.ts:6521-6548`) fino in fondo, il suo precedente non è "un endpoint
che aggrega più collezioni" — è **un endpoint bounded/paginato PER UNA
collezione**. Applicato letteralmente a quattro entità, il precedente giusto
non è "inventare un endpoint combinato nuovo" ma **applicare la stessa forma
sei volte**, una per collezione già esistente:

| Collezione | Handler GET oggi (verificato) | Cambia in |
|---|---|---|
| `/resources` | `server.ts:1701` — `res.json(await resolveResourceRates(await repos.resources.list()))` | accetta `q`/`limit`/`offset` opzionali |
| `/projects` | `server.ts:4436` — `res.json(await repos.projects.list())` | idem |
| `/requests` | `server.ts:2156` — `res.json(await repos.requests.list())` | idem |
| `/customers` | mount generico `crud(apiRouter, 'customers', repos.customers, ['name','industry','country'], [], validate)` (`server.ts:4693`) | `crud()` guadagna un 6° parametro opzionale `searchable` |
| `/contracts` | `server.ts:4739` — `res.json(await repos.contracts.list())` | accetta `q`/`limit`/`offset` opzionali |
| `/orders` | `server.ts:4793` — `res.json(await repos.orders.list())` | idem |

**Perché questo è meglio del singolo endpoint combinato che il draft
ipotizzava, non solo diverso:** ciascuna delle sei letture è **già** gated
dalla propria regola `READ_RULES` esistente (`server.ts:703-744`, tabella
completa al §4) — un `employee` che chiama `GET /resources?q=Julie` riceve
**già oggi**, senza nessuna riga di codice nuova, lo stesso 403 che riceve
per `GET /resources` senza parametri, perché `roleGate` (`server.ts:610`)
valuta `req.path`, non la query string. **Zero nuova superficie di
autorizzazione da scrivere o testare** — si veda §4 per il contrasto
esplicito con l'alternativa scartata.

**Vincolo di compatibilità, non negoziabile.** `getResources()`,
`getProjects()`, `getRequests()`, `getCustomers()`, `getContracts()`,
`getOrders()` sono oggi chiamati **senza parametri** da `resources.
component.ts`, `staffing.component.ts`, `dashboard.component.ts`,
`utilization.component.ts`, `reporting.ts`, `forecast.ts`, `billing.ts`,
`allocation-approvals.component.ts`, e altri — tutti si aspettano l'**intera
collezione**, non paginata. **`q`/`limit`/`offset` sono strettamente
opt-in: la chiamata senza parametri deve continuare a restituire l'array
completo, non filtrato, non paginato, esattamente come oggi.** Non è un
default "silenzioso" da tarare con attenzione — è un contratto che, se
rotto, rompe simultaneamente più schermi già in produzione. Il task che
tocca ciascun handler deve portare un test di regressione esplicito su
questo (§13).

**Nessuna riga `crud()` esistente cambia comportamento.** `crud()`
(`server.ts:772`) ha 12 chiamate (`server.ts` — cities, industries,
cost-categories, partner-roles, vendors, rate-cards, project-partners,
project-documents, work-packages, project-financials, project-tasks,
project-issues, cost-centers, **customers**); il nuovo parametro
`searchable` è opzionale con default `[]` — le altre 11 chiamate non lo
passano e restano bit-per-bit identiche.

## 4. RBAC: zero nuova superficie, il gate esistente basta

`g-facts.md` §6 mostra che ogni collezione in perimetro ha un `READ_RULES`
diverso:

| Collezione | Ruoli in lettura | `READ_RULES` riga |
|---|---|---|
| `/resources`, `/users` | pm, resource-manager, delivery-executive, finance, admin | 713 |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items`, `/negotiated-rates` | sales, finance, delivery-executive, admin | 705 |
| `/assignments`, `/requests` | pm, resource-manager, delivery-executive, finance, admin | 720 |
| **`/projects`** e le sue sotto-risorse | **nessuna regola — qualunque principal autenticato** (`docs/roles-and-permissions.md`, sezione "Open reads"; la sola regola su `/projects` è quella di SCRITTURA, `server.ts:662`) | — |

**Alternativa scartata, per mostrare la due-diligence:** un unico endpoint
combinato (`GET /search?q=...`) avrebbe richiesto reimplementare, dentro
quell'handler, esattamente questa tabella — una chiamata per sezione a
`authorizeRead()` (`src/server/authz-policy.util.ts:76`, già pura ed
esportata: `authorizeRead({isPublic, authenticated, roles, allowedRoles})`)
con l'array di ruoli di ciascuna collezione copiato o ri-derivato a mano.
Questo è esattamente il tipo di superficie di autorizzazione nuova che un
difetto potrebbe attraversare inosservato. **Estendendo le sei letture
esistenti (§3) invece di combinarle, questa tabella non viene mai
duplicata: il gate che già esiste per ciascuna collezione resta l'UNICO
gate**, e non c'è nessuna riga di `authorizeRead()` da scrivere per questo
blocco.

**Disclosure del conteggio di faccetta — risolta dalla stessa architettura.**
Se un ruolo non può leggere `/customers` affatto, `GET /customers?q=...`
risponde **403**, lo stesso status che riceverebbe oggi con qualunque altra
query su quel path. Lato client (§5), un 403 su UNA delle sei chiamate
parallele è il segnale che quella sezione va **omessa interamente** — mai
resa come "Clienti (0)". Un conteggio "Clienti (3)" mostrato a un ruolo senza
`/customers` non può mai accadere, perché quella chiamata non arriva mai a
restituire dati a quel ruolo — non per un controllo aggiunto in questo
blocco, ma perché è già così che `/customers` si comporta oggi per
qualunque lettura.

**Le letture self-scoped restano fuori.** `/self/assignments`,
`/self/requests` (`api.service.ts:957,961`) non passano da `READ_RULES` — un
`employee` con un proprio assignment su un progetto trovato dalla ricerca
non lo vede tramite questo meccanismo in v1 (§14, fuori scope esplicito).

## 5. Quattro stati per sezione: risultati, vuoto vero, fallito, non permesso

Questo progetto ha già, nel proprio codice, la formulazione quasi verbatim
del vincolo che una ricerca deve rispettare. `utilization.component.ts:372-375`:

> `// REQUIRED leg, deliberately no catchError: ... a failed bench read must`
> `// surface as an error, never silently degrade to "nobody is on bench"`
> `// (Global Constraint — a failed/forbidden read must never render as a`
> `// confident zero).`

e `dashboard.component.ts:651-653`: *"the Global Constraint this codebase
keeps re-fixing."* Due precedenti di un pattern a tre stati già scritto:
`contract-details.ts:1491` (`moneyFiguresState`) e, più recente,
`what-if.ts:481` (`dataState`), che **piega anche `!authReady()` dentro
`loading`** (`!this.auth.authReady() || this.dataRes.isLoading() || ...`).

**Su uno schermo di ricerca il rischio è più acuto che altrove: una lista
vuota per un termine senza risultati e una lista vuota perché la query non è
mai partita sono, per costruzione, indistinguibili** — non c'è una riga
"mancante" che salti all'occhio come su una tabella normalmente popolata.
Per questo il layer non usa tre stati (come `dataState`) ma **quattro**, per
sezione:

| Stato | Segnale | Cosa mostra |
|---|---|---|
| **Caricamento** | `!authReady()` OPPURE la chiamata di quella sezione non si è ancora risolta | `app-list-state [loading]="true"` → skeleton (`command-skeleton-row`) |
| **Fallito** | la chiamata di quella sezione risponde con un errore DIVERSO da 403 (rete, 5xx) | `app-list-state [error]="true"` → pannello con Retry — MAI un conteggio "0" |
| **Non permesso (assente)** | la chiamata di quella sezione risponde **403** | l'intera `<section>`, header e conteggio inclusi, non compare — `@if` che avvolge l'intera sezione, non un input nuovo su `ListStateComponent` |
| **Vuoto vero** | la chiamata risolve con `status 200` e un array vuoto | "Nessun risultato per «…» in {entità}" dentro il template già proiettato in `app-list-state` (lo stesso pattern `@for {...} @empty {...}` di `bench.component.ts`) |

**Perché "non permesso" non è un quarto `@Input` su `ListStateComponent`.**
`list-state.component.ts` espone oggi esattamente `loading`, `error`,
`label`, `skeleton`, `rows`, `columns` (righe 120-139) — nessun input
"unavailable". Aggiungerne uno costringerebbe OGNI consumatore esistente di
`ListStateComponent` (Reporting, Bench, Capacity, …) a considerare un caso
che non li riguarda. La soluzione più semplice è anche la più corretta:
"non permesso" non è uno STATO di una sezione visibile — è l'ASSENZA della
sezione stessa, decisa da un `@if` che avvolge l'intero blocco `<section>`
(header, conteggio, `app-list-state`), sulla base dello status HTTP
osservato per quella specifica chiamata (non su una capacità lato client
ri-derivata: si veda §6 per il perché).

**Perché una singola sezione fallita non deve azzerare le altre.** Le sei
chiamate (§3) sono composte in **un solo `forkJoin`**, ciascuna avvolta in
un proprio `catchError` che mappa l'errore a un sentinella per-sezione
(`{status: 'error'} | {status: 'forbidden'}`), esattamente l'idioma già
stabilito da `dashboard.component.ts`/`utilization.component.ts` per
"gambe" (`forkJoin` legs) che possono fallire indipendentemente — non un
meccanismo nuovo, la stessa forma applicata a sei gambe invece di due.

## 6. `authReady`, testo live vs invio esplicito: la mappa per entità

**Decisione 4 (chiusa).** Ogni sezione tiene il proprio testo di ricerca; la
domanda è SE quel testo genera una chiamata a ogni carattere (con debounce)
o solo all'invio esplicito. Non esiste oggi, in questo progetto, nessuna
utility di debounce condivisa (`grep -rn "debounceTime\|debounce("
src/app --include="*.ts"` restituisce zero risultati) — la ricerca aggiunge
la prima. La mappa, decisa per cardinalità prevista, non lasciata
all'implementatore:

| Entità | Modalità | Perché |
|---|---|---|
| **Risorse** | **Invio esplicito** | la collezione a cardinalità più alta del progetto — centinaia di righe in produzione, non le 9 del seed; un debounce a ogni battitura resta comunque una richiesta per pausa di digitazione |
| **Richieste** | **Invio esplicito** | `g-facts.md` §2 la definisce esplicitamente "alta cardinalità", stessa audience di `/assignments` |
| **Progetti** | Live con debounce (300ms) | bassa cardinalità nel dominio (poche decine di progetti concorrenti anche in produzione, contro centinaia di risorse) |
| **Clienti/Contratti/Ordini** | Live con debounce (300ms) | primo filtro mai avuto (§1) — cardinalità tipicamente più bassa delle risorse in un dominio PSA; costo per digitazione accettabile |

**`authReady` — un altro consumatore del pattern generale, non
`authGatedResource()` tal quale.** Il termine di ricerca è un parametro che
deve entrare nei `params` di `rxResource` insieme alla readiness — la nota
di `auth-gated-resource.util.ts:29-32` lo dice esplicitamente ("use the
explicit `rxResource` form instead when the read is keyed on anything more
than readiness... a selected filter"). Il resource della pagina di ricerca
tiene `params: () => ({ ready: auth.authReady(), q: this.submittedQuery() })`
(dove `submittedQuery` è o il valore live-debounced o il valore
dopo-invio, a seconda dell'entità) e non fa fuoco alcuno finché `ready` è
`false` — la stessa piega che `projects.ts` già usa per `/contracts`, citata
nella stessa nota.

## 7. Server-side senza indice: cosa cambia, perché la parità è quasi gratis

**Decisione 2 (chiusa): filtro/paginazione server-side dal primo rilascio,
nessun indice testuale (nessuna migration, nessun `tsvector`/GIN/`pg_trgm`).**

**Perché l'indice è deliberatamente rimandato.** Un indice testuale reale
(`pg_trgm` o `tsvector`) esisterebbe **solo** sul path Postgres — l'adapter
in-memory non ha, e non può avere, un indice Postgres. Per mantenere le due
letture identiche (il vincolo di parità di questo progetto, CLAUDE.md
"dev↔prod parity switch"), l'adapter in-memory dovrebbe REPLICARE il
comportamento dell'indice (fuzzy matching, ranking per rilevanza) con
codice JS puro — e la replica non sarebbe MAI byte-identica a ciò che
`pg_trgm` produce (soglie di similarità, tokenizzazione, stemming sono
implementazioni Postgres-specifiche). I due adapter divergerebbero
esattamente nel modo che questo progetto vieta. **Costo esplicito di questo
rinvio:** nessun ranking per rilevanza (i risultati non sono ordinati per
"quanto bene combaciano", solo per l'ordine naturale della collezione), e
nessuna tolleranza a refusi (un `ILIKE`/`.includes()` case-insensitive non
perdona "Grobex" per "Globex").

**La soluzione per v1 rende la parità banale per costruzione, non un
rischio da gestire.** Ogni handler esteso (§3) chiama `repos.X.list()`
**senza modifiche** — la stessa chiamata già fatta oggi da OGNI lettura
esistente di quella collezione, su ENTRAMBI gli adapter — e poi applica un
filtro/paginazione **in JavaScript, dopo il fetch, identico a prescindere
da `DATABASE_URL`**. Non c'è un ramo `if (db) { SQL } else { in-memory }`
come in `/audit-logs` (`server.ts:6532-6547`) perché non c'è nessun
operatore SQL-specifico da eseguire: il match testuale e la sua
paginazione sono PURA logica JS, eseguita una volta sola, sullo stesso
array (`Resource[]`, `Project[]`, …) che l'adapter Postgres e l'adapter
in-memory producono già identico dal loro stesso contratto
(`Repository<T>.list(): Promise<T[]>`, `repository.ts:202`, zero parametri
oggi). **La parità non è un secondo path da testare uguale al primo — è lo
stesso path, chiamato due volte da due adapter che già garantiscono
`list()` identico.**

**Nessuna nuova scansione completa introdotta.** Le sei collezioni sono
GIÀ interamente fetchate in memoria del server da ogni lettura esistente
(`res.json(await repos.resources.list())` oggi, senza filtro) — filtrare
DOPO quel fetch non aggiunge un costo che non esisteva già; il guadagno
reale è che il CLIENT non riceve più, né deve più filtrare, l'intera
collezione, e la risposta è delimitata da `limit` (§8's forma).

**Segue la forma di `/audit-logs`, non ne inventa una nuova.**
`AUDIT_LOG_DEFAULT_LIMIT = 200`/`AUDIT_LOG_MAX_LIMIT = 1000`
(`server.ts:6521-6522`) clampano `limit`/`offset`; questo blocco applica lo
stesso clamp (soglie diverse, più basse — §11) sei volte, una per
collezione, tramite lo stesso layer puro (§11). **Nessun conteggio
totale nella risposta** — `/audit-logs` stesso non lo restituisce
(`res.json(page)`/`res.json(sorted.slice(...))`, nessun campo `total`);
questo blocco non inventa una convenzione di risposta che il precedente
non ha già stabilito. Una sezione che mostra esattamente `limit` righe
suggerisce "affina il termine per risultati più precisi", non dichiara un
totale che non ha (coerente con l'assenza di ranking, sopra).

## 8. Il componente condiviso e la migrazione mirata

**Decisione 3 (chiusa).** Un componente condiviso nuovo,
`src/app/shared/search-filter-bar.component.ts` — box di testo + N faccette
parametrizzate (`{id, label, options: {value,label}[], value}`), riusando
`.command-input`/`.command-select` (`styles.css:921-922`, già esistenti) più
un elenco di chip per i filtri attivi (`.command-chip`, `styles.css:871`,
con un modificatore "rimovibile" nuovo — verificato: nessuno dei modificatori
esistenti, `is-neutral`/`is-info`/`is-positive`/`is-caution`/`is-critical`
righe 886-910, copre "chip con una X", e nessun altro screen ne ha mai avuto
bisogno) e un pulsante "Cancella tutto" (oggi esiste solo per il filtro di
navigazione, `command-nav-clear`, `app.ts:178`).

**"Migrare solo gli schermi che il perimetro di v1 copre davvero" — la lista
nominata, non una nota vaga.** Delle 13 implementazioni indipendenti (§1),
solo quelle il cui SOGGETTO primario è una delle quattro entità in
perimetro (§2) migrano in v1:

| Schermo | Trattamento | Perché |
|---|---|---|
| `resources.component.ts` | **Migrato** (sostituzione integrale: testo + `activeOnly` + `kindFilter` + capability/practice/competence/manager) | soggetto primario = Risorse, in perimetro |
| `projects.ts` | **Migrato** (sostituzione del solo box di testo) | soggetto primario = Progetti, in perimetro |
| `customers.ts`, `contracts.ts`, `orders.ts` | **Adottato per la prima volta** (non una migrazione — non esisteva nulla da sostituire, §1) | soggetto primario = catena commerciale, in perimetro |

**Follow-up dichiarato esplicitamente, elenco nominato — non un TODO
generico:**

- `staffing.component.ts` — stesso quartetto capability/practice/competence/
  manager di `resources.component.ts`, ma il soggetto primario dello
  schermo è lo staffing/assignment, non la lista Risorse in sé.
- `resource-requests.component.ts` — il suo `searchValue`/`availabilitySearch`
  (riga 510) filtra la lista CANDIDATI per una richiesta aperta, non la
  lista Richieste — un concetto distinto da questo blocco, non toccato.
- `allocation-approvals.component.ts` e il suo `approval-modal.component.ts`
  — un quinto e sesto filtro sulle stesse quattro dimensioni org, sullo
  schermo di approvazione, non sulla lista Risorse/Richieste.
- `billing.ts` — `typeFilter`/`statusFilter`/`contractFilter` su
  billing-plan-items, un'entità distinta da clienti/contratti/ordini per
  quanto imparentata (stessa `READ_RULES`, `server.ts:705`).
- I sei schermi di configurazione (`manage-cost-categories`,
  `manage-cost-centers`, `manage-vendors`, `manage-industries`,
  `manage-partner-roles`, `manage-rate-cards`) — già esclusi dal perimetro
  stesso (§2), quindi esclusi anche dalla migrazione per lo stesso motivo.

**Perché "migrare nessuno" era scartato esplicitamente.** Introdurre il
componente condiviso e usarlo SOLO nella nuova pagina di ricerca, lasciando
`resources.component.ts`/`projects.ts` come sono, avrebbe aggiunto
un'implementazione in più (la 14ª) invece di sostituirne una: il difetto
che questo blocco esiste per correggere si sarebbe aggravato, non
migliorato. Migrando `resources.component.ts` e `projects.ts` (i due
schermi il cui filtro copre esattamente un'entità in perimetro), il
componente condiviso ha, dal primo giorno, **tre consumatori reali** oltre
alla pagina di ricerca stessa (`resources.component.ts`, `projects.ts`, e
`customers.ts`/`contracts.ts`/`orders.ts`) — non un componente costruito e
mai riusato, il destino toccato ad `authGatedResource()` per un anno
(`g-facts.md` §4, verificato: 28 schermi lo usano oggi, ma non
`resources.component.ts`/`staffing.component.ts`/`resource-requests.
component.ts`/`allocation-approvals.component.ts`/`reporting.ts`/
`utilization.component.ts`/`dashboard.component.ts`/`app.ts` — lo stesso
elenco di schermi "ricchi" che questo blocco lascia esplicitamente non
toccati, salvo i due che migra).

## 9. L'affordance d'ingresso: perché non riusa `command-nav-search`

`g-facts.md` §2: il box `command-nav-search` (`app.ts:167-184`) ha già
l'icona lente e il vocabolario visivo di una ricerca globale, ma filtra solo
`navGroups` (etichette statiche). **Decisione: la nuova ricerca a faccette
vive dietro una route dedicata (`/search`), con un'affordance d'ingresso
visivamente distinta** (non la stessa icona-lente-più-posizione del filtro
di navigazione) — riusarne l'aspetto esatto farebbe leggere la nuova ricerca
come un duplicato di quella esistente, esattamente il rischio che
`g-facts.md` §2 segnala esplicitamente ("a false match on the word
search"). La route `/search` non porta **nessuna** `canMatch` guard — segue
lo stesso precedente di `/projects` (`app.routes.ts:19`, nessun `canMatch`),
dato che ogni ruolo autenticato deve poter raggiungere la pagina (anche un
`employee`, che vedrà solo la sezione Progetti popolata, §4/§5).

## 10. La regola dei due decimali

Ogni cifra che un risultato di ricerca porta con sé (valore totale di un
contratto, giorni/FTE su una richiesta, percentuale di utilization su una
risorsa) segue la stessa regola già in vigore altrove
(`resources.component.ts:160` — `{{ r.capacity | number:'1.0-2' }}`,
`bench.component.ts:55,89,141`): mai più di due decimali, `digitsInfo`
esplicito, mai il default `1.0-3` di `DecimalPipe` senza `digitsInfo`.
L'arrotondamento resta l'ultimo passo di rendering, mai un input al
matching testuale o alla decisione di quale sezione mostrare.

## 11. Superficie tecnica

**Layer puro nuovo — `src/app/services/search.util.ts`** (nessun I/O,
nessun orologio, sulla falsariga di `bench.util.ts`):

```ts
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

export interface SearchPage<T> { rows: T[]; }

/** Clamp identico a AUDIT_LOG_*_LIMIT (server.ts:6521-6522), soglie proprie. */
export function clampSearchPage(raw: { limit?: unknown; offset?: unknown }): { limit: number; offset: number };

/** Case-insensitive substring match su uno o più campi di T. */
export function matchesQuery<T>(record: T, fields: readonly (keyof T)[], q: string): boolean;

/** Filtra (se q non è vuoto) e pagina — identico su entrambi gli adapter (§7). */
export function searchPage<T>(
  records: readonly T[],
  fields: readonly (keyof T)[],
  q: string | undefined,
  page: { limit: number; offset: number },
): SearchPage<T>;
```

**Sei handler estesi in `src/server.ts`** (§3's tabella per le righe
esatte) — forma comune:

```ts
apiRouter.get('/resources', async (req, res) => {
  const all = await resolveResourceRates(await repos.resources.list());
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  if (q === undefined) { res.json(all); return; } // invariato: nessun parametro, nessun cambiamento (§3)
  const { limit, offset } = clampSearchPage(req.query);
  res.json(searchPage(all, ['name', 'role', 'organization', 'location'], q, { limit, offset }).rows);
});
```

Campi di match per collezione (lo stesso livello di sofisticazione già
offerto client-side oggi, `g-facts.md` §1, non un motore nuovo):

| Collezione | Campi | Nota |
|---|---|---|
| Risorse | `name`, `role`, `organization`, `location` | identico a `resources.component.ts`'s filtro attuale |
| Progetti | `name`, `location` | `id` escluso (già un match esatto via URL, non un termine di ricerca) |
| Richieste | `name`, `description` | nessun precedente locale (§1) — i due campi testuali propri dell'entità |
| Clienti | `name` | |
| Contratti | `name` | |
| Ordini | `invoiceNumber` (quando presente) | **`Order` non ha un campo `name`** (`api.service.ts:660-672`) — un ordine non combacia mai per nome del cliente/contratto padre: nessun join, per restare nella stessa forma "un filtro per collezione" di §3. Cercare "Globex" trova il cliente C1 e il contratto CT1, MAI l'ordine O1 che vi appartiene — verificato nel fixture §13 |

**Client — sei metodi estesi in `api.service.ts`** (righe esatte:
`getResources()` 921, `getRequests()` 979, `getProjects()` 1255,
`getCustomers()` 1320, `getContracts()` 1325, `getOrders()` 1330), stessa
forma di `getBenchMonthly()`:

```ts
getResources(opts?: { q?: string; limit?: number; offset?: number }): Observable<Resource[]> {
  let params = new HttpParams();
  if (opts?.q) params = params.set('q', opts.q);
  if (opts?.limit !== undefined) params = params.set('limit', opts.limit);
  if (opts?.offset !== undefined) params = params.set('offset', opts.offset);
  return this.http.get<Resource[]>(`${this.baseUrl}/resources`, { params });
}
```

**`crud()` (`server.ts:772`) guadagna un 6° parametro opzionale:**

```ts
function crud<T extends { id: string }>(
  router: Router, path: string, repo: Repository<T>,
  allowed: readonly string[], numericFields: readonly string[] = [],
  validate?: (data: Record<string, unknown>, ctx?: { id?: string }) => Promise<string | null>,
  searchable: readonly (keyof T)[] = [],  // NUOVO, default [] — le altre 11 chiamate invariate
) { /* router.get aggiorna la stessa forma del blocco di codice sopra, se searchable.length > 0 */ }
```

## 12. `docs/roles-and-permissions.md` — cosa cambia e cosa no

**Nessuna riga di `READ_RULES` cambia valore** (§4) — ma il documento va
comunque aggiornato, per lo stesso motivo per cui due blocchi precedenti
hanno aggiunto regole senza aggiornarlo e una riga vicina è silenziosamente
diventata falsa: la sezione "(a) READ_RULES" deve annotare, sulle sei righe
già esistenti per `/resources`, `/projects` (in "Open reads"), `/requests`,
`/customers`, `/contracts`, `/orders`, che ora accettano anche `q`/`limit`/
`offset` senza cambiare i ruoli ammessi — e la sezione "Route access" deve
guadagnare la riga `/search` (nessuna guard, §9). Questo blocco NON
aggiunge, rimuove o restringe nessuna regola RBAC esistente — l'aggiornamento
è puramente descrittivo della nuova forma delle sei letture.

## 13. Verifica

Il difetto ricorrente di questo progetto è un check verde che nessun dato
esercita (memoria di progetto: 7 istanze prima di questo blocco). Per la
ricerca la trappola è la più diretta possibile: *"cercare un termine senza
senso restituisce zero risultati"* passa identico che la ricerca funzioni o
sia rotta del tutto. Ogni riga sotto è quindi accoppiata al suo gemello
positivo, con la riga seed esatta (`src/db/seed.ts`, verificata dopo il
merge di Blocco F — nessuna nuova fixture richiesta per questo blocco, §14):

| Check "restituisce esattamente queste righe" | Riga seed | Gemello "restituisce niente/assente" |
|---|---|---|
| `q=Julie` su Risorse → esattamente `id:'1'` (Julie Armstrong, `seed.ts:116`), nessun'altra | `seed.ts:116` | `q=zzznonsense123` su Risorse → array vuoto con **stato risolto (200)**, mai "errore" — altrimenti il check passerebbe anche con la ricerca rotta e sempre in errore |
| `q=Julie` con ruolo `employee` → sezione Risorse **assente** (403, `g-facts.md` §6: employee non legge `/resources`) | — (comportamento RBAC, non seed) | `q=Julie` con ruolo `pm` → sezione Risorse **presente** con esattamente la riga `'1'` — il gemello positivo prova che l'assenza sopra è RBAC, non un bug che nasconde sempre la sezione |
| `q=Globex` con ruolo `sales` → sezione Clienti presente con esattamente `C1` (`seed.ts:719`) e sezione Contratti con esattamente `CT1` (`seed.ts:724`) | `seed.ts:719,724` | `q=Globex` con ruolo `pm` → sezioni Clienti e Contratti **assenti** (403) — asserire l'assenza del blocco, non solo "zero righe dentro", altrimenti un bug che restituisce "0 finti" invece di omettere la sezione passerebbe comunque |
| `q=Globex` (qualunque ruolo con accesso) → sezione Ordini **non contiene** `O1` (appartiene al contratto CT1 ma non ha "Globex" nel proprio `invoiceNumber`) | `seed.ts:748-756` | `q=INV-2026-0001` → sezione Ordini contiene esattamente `O1` — il gemello prova che il match sugli ordini funziona sul proprio campo, non che è rotto |
| `q=Alpha` con ruolo `employee` → sezione Progetti presente con esattamente `id:'1'` "Project Alpha" (`seed.ts:620`) | `seed.ts:620` | `q=Alpha` con ruolo `employee` → sezione Risorse **assente** (stesso termine, ruoli diversi di need-to-know per sezione diversa) |
| `GET /resources` **senza** `q` → l'array completo, invariato (regressione di compatibilità, §3) | tutte le righe resources | `GET /resources?q=Julie&limit=1` → esattamente 1 riga — il gemello prova che il parametro, quando presente, filtra davvero |
| Una sola sezione in errore di rete/500 (mock forzato) mentre le altre cinque rispondono 200 → SOLO quella sezione mostra il pannello Retry, le altre mostrano il proprio contenuto | nessuna riga seed — test di comportamento della composizione `forkJoin`, non dei dati | — non ha un gemello "restituisce righe": è la prova diretta del §5, e va scritto esplicitamente perché nessun test "righe corrette" lo eserciterebbe per caso |

**Rischio di permutazione, esplicito.** Su una lista di risultati raggruppata
per sezione, uno scambio fra il conteggio di due sezioni (es. "Risorse (3)"
e "Progetti (1)" scambiati fra loro) lascerebbe entrambe le cifre presenti
sullo schermo — un test che asserisce solo "il testo contiene 3 e contiene
1" passerebbe comunque. I test di conteggio devono leggere il conteggio
DENTRO l'elemento della sezione corretta (query DOM scoperta all'elemento
`data-test="resources-section"`, non un `querySelector` globale sulla
pagina), non il testo intero della pagina.

## 14. Cosa questo blocco NON fa

- **Nessuna fixture seed nuova.** A differenza di Blocco F, ogni check del
  §13 è risolvibile con righe già presenti in `src/db/seed.ts` dopo il merge
  di F (Julie `'1'`, subco `'6'`, dummy `'4'`/`'5'`, Elena Rossi `'9'`
  terminata, Globex `C1`/`CT1`, Project Alpha `'1'`). **Se un'implementazione
  scopre di averne bisogno**, gli id `'1'`-`'11'` sono già occupati in
  `requests`/`assignmentsBase` (Blocco F li ha portati a `'11'`, verificato
  su questo albero) e i blocchi E/rate-card in corso su altri worktree
  prendono `'12'` e `'13'` in su — una nuova fixture di questo blocco deve
  partire da **`'20'`**, verificando comunque l'id massimo live al momento
  dell'implementazione, non fidandosi di questo numero.
- **Nessun ranking per rilevanza, nessuna tolleranza a refusi** (§7) — costo
  esplicito del rinvio dell'indice testuale.
- **Nessuna ricerca su `/assignments`/`/assignment-days`/`/assignment-months`**
  in v1 (§2) — dati derivati, non record cercati per nome.
- **Nessuna ricerca sui cataloghi di configurazione** (§2/§8) — già cercabili
  localmente ai loro volumi.
- **Nessuna migrazione retroattiva di `staffing.component.ts`,
  `resource-requests.component.ts`, `allocation-approvals.component.ts` +
  `approval-modal.component.ts`, `billing.ts`** — follow-up dichiarato
  esplicitamente al §8, non silenzioso.
- **Nessun accesso alle letture self-scoped** (`/self/assignments`,
  `/self/requests`) dal meccanismo di ricerca — un `employee` non vede un
  proprio assignment tramite questa ricerca in v1 (§4).
- **Nessun conteggio totale nella risposta di ricerca** (§7) — mai
  "137 risultati, ne mostriamo 20"; solo le righe della pagina corrente,
  come `/audit-logs`.
- **Nessun secondo asse di scope organizzativo** (`teamScope`
  `'direct'`/`'org'`, come su `/utilization`) sopra il need-to-know RBAC
  già applicato per sezione (§4) — nominato esplicitamente per non
  diventare un'assunzione silenziosa.
