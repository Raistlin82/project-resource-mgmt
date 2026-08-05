# Design — Eredità delle rate card lungo l'albero organizzativo

- **Data:** 2026-08-05
- **Stato:** Design approvato — tutte le decisioni prodotto sono prese, pronto per l'implementazione.
- **Origine:** la terza delle tre domande di prodotto sollevate a chiusura del gap **D**, esplicitamente rinviata sia da
  `docs/superpowers/specs/2026-08-04-org-scope-ui-consistency-design.md` (§"Fuori scope", riga 19: «l'ereditarietà delle rate card lungo l'albero — blocco successivo, tocca importi fatturabili») sia da
  `docs/superpowers/specs/2026-08-04-negotiated-sell-rates-design.md` (§8, righe 139-143: «l'ereditarietà si innesta poi **come un livello dentro il punto 3** della precedenza… senza ridiscutere ciò che sta sopra»). L'utente ha scelto la regola di risoluzione (nodo proprio → antenati → card generica, il più specifico vince) e ha posto una condizione sulla consegna: report d'impatto prima/dopo, perché il blocco muove importi già fatturabili in **entrambe** le direzioni. Le quattro domande aperte lasciate dal draft precedente sono ora **decise** — questo documento le incorpora come regole, non come opzioni.
- **Riferimenti:** `docs/superpowers/specs/2026-08-03-d-org-hierarchy-people-manager-design.md` (l'albero); i due documenti citati sopra; `docs/superpowers/specs/2026-08-04-negotiated-sell-rates-design.md` (la catena `sellRateFor`, §3-4, con cui questo blocco non interferisce — §3); `docs/roles-and-permissions.md` (RBAC, §11).

> **Nota sulla verifica.** Ogni riferimento `file:riga` in questo documento è stato riletto sul codice live del worktree (branch `feature/rate-card-inheritance`, base `89351f2`) al momento della stesura, non copiato dal draft precedente. Il draft di partenza (`.superpowers/design-drafts/rate-inheritance-spec-draft.md`) citava `negotiated-sell-rates-design.md:126-130` per il §8 di quel documento; il testo è corretto ma la citazione di riga era sbagliata — il §8 vive oggi a **righe 139-143**. Corretto qui; non è l'unico caso di deriva dei numeri di riga rispetto al draft, ma è l'unico che cambiava un fatto citato altrove (gli altri sono spostamenti dovuti a commit intermedi sulla stessa area di `server.ts`, elencati sezione per sezione sotto).
>
> **Aggiornamento post-rebase (stesso giorno).** Il branch è stato successivamente rebasato dal coordinatore su un `main` avanzato di un intero blocco (**F**, bench/disponibilità — merge a `f2b6edd`), che questo documento non poteva conoscere al momento della prima stesura. Ogni citazione `file:riga` di `src/server.ts` è stata riverificata dopo il rebase e corretta dove il file (cresciuto di centinaia di righe) l'aveva spostata — nessun fatto **sostanziale** è cambiato in quelle righe, solo la loro posizione. Un'eccezione sostanziale, non solo di riga: §6 citava `what-if.ts::dataState()` come inesistente, verificato con un grep pulito sull'albero pre-blocco-F — grep onesto, conclusione sbagliata sul progetto, perché `dataState()` è proprio ciò che il blocco F ha introdotto. Corretto in §6 con la citazione verificata sul codice post-rebase.

---

## 1. Il difetto, con le cifre del seed

`pickRateCard` (oggi `src/server.ts:1625-1630`, funzione privata) risolve la rate card di una risorsa in due passi: match **esatto** sul nome dell'organizzazione, altrimenti la card generica (senza organizzazione). Da quando l'albero D è arrivato (Capability > Practice > Competence, `resourceOrganizations.parentId`), quel match esatto ha una conseguenza che l'utente considera un difetto: **una card configurata su una capability non si applica alle practice o competence sottostanti**.

Il seed lo dimostra con due numeri concreti (`src/db/seed.ts:545-556`):

- `RC_DEV` — card generica, `Developer`, **600/1120** €/giorno (costo/vendita);
- `RC_DEV_ENG` — card su `organization: 'Engineering'`, stesso ruolo, **640/1200** €/giorno.

L'albero (`src/db/seed.ts:423-429`) è `Engineering` (`id:'2'`, capability) → `Platform` (`id:'5'`, practice, `parentId:'2'`) → `Backend` (`id:'6'`, competence, `parentId:'5'`). Oggi, una risorsa `Developer` con `organization: 'Engineering'` risolve correttamente 640/1200 (match esatto, invariato da questo blocco). Ma la stessa persona attaccata a `Platform` o a `Backend` — cioè più vicina al lavoro reale che l'albero D rappresenta — perde silenziosamente quella card e ricade sulla generica 600/1120: costruire l'albero **abbassa** il costo/prezzo di chi ci viene collocato, senza errore, senza notifica, senza motivo di business.

Il difetto è bidirezionale per costruzione della regola (una card su una practice per **alzare** un prezzo non si applicherebbe alle sue foglie), ma il seed committato oggi non lo esibisce per nessuna risorsa esistente: ogni `organization:` seedata (`src/db/seed.ts`, risorse `'1'`-`'6'`) è `'Engineering'`, `'Consulting'` o `'Design'` — tutte capability, nessuna su `Platform`/`Backend`. Il difetto è reale e riproducibile immediatamente attaccando un `Developer` a `Backend` (verificato: nessun cambiamento è ancora avvenuto in questa parte del seed rispetto al draft). Questo è rilevante per il report d'impatto (§9): sul seed **come committato prima di questo blocco**, un report onesto stampa zero righe non perché "nessuna card sta su un nodo non-foglia" (`RC_DEV_ENG` sta su `Engineering`, che ha un figlio — quindi è non-foglia), ma per la ragione più debole "nessuna risorsa sta oggi sotto quel nodo". Le due condizioni non sono la stessa cosa (dettaglio in §9) — motivo per cui questo blocco **aggiunge** una riga di seed che rende visibile la condizione forte, invece di limitarsi a descriverla in prosa.

Non è una comodità mancante: è correttezza sui costi e sui margini, esattamente nello stesso senso in cui il blocco delle sell rate negoziate lo era sui ricavi.

## 2. La regola di risoluzione (nodo proprio → antenati, il più vicino vince)

La regola è: nodo proprio, poi ogni antenato salendo per `parentId`, poi la card generica; il match più specifico (il più vicino nell'albero) vince sempre su uno più generico.

`ancestorChain(nodeId, nodes)` (`src/app/services/org-scope.util.ts:50-61`, verificata live) restituisce **esattamente** questo ordine: parte dal nodo stesso e sale verso la radice, il più vicino per primo (doc comment a riga 46-48: «innermost first»). Guarantita da un `visited` set più `MAX_CHAIN_DEPTH = 64` (riga 28), quindi termina anche su un ciclo nei dati. Questo semplifica il design:

1. "nodo proprio" non è un caso separato: è il primo elemento di `ancestorChain`. Un solo ciclo, non un `if` più un ciclo.
2. "il più vicino vince" è garantito dall'ordine dell'array, non da un calcolo di distanza scritto ad hoc.

La funzione (estratta e generalizzata da `pickRateCard`, vedi §5 per dove vive):

```ts
export const RATE_BASE_CURRENCY = 'EUR';

export function pickRateCard(
  cards: readonly RateCard[],
  role: string | undefined,
  organization: string | undefined,
  nodes: readonly OrgNode[],
): RateCard | undefined {
  if (!role) return undefined;
  const forRole = cards.filter(c => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  // Match esatto — invariato rispetto a oggi, e l'unico passo che gira anche
  // quando `organization` non risolve a nessun nodo reale (dato legacy, §4).
  const own = forRole.find(c => c.organization && c.organization === organization);
  if (own) return own;
  const node = nodeByName(organization, nodes);
  if (node) {
    // .slice(1): il nodo stesso è già stato provato sopra come match esatto;
    // qui si sale SOLO verso gli antenati veri, il più vicino per primo.
    for (const ancestor of ancestorChain(node.id, nodes).slice(1)) {
      const hit = forRole.find(c => c.organization === ancestor.name);
      if (hit) return hit;
    }
  }
  return forRole.find(c => !c.organization);
}
```

Questa firma è una **generalizzazione stretta** di quella di oggi: a parità di `cards`/`role`/`organization`, se nessuna card sta su un antenato proprio di `organization`, il valore restituito è **identico bit per bit** a quello di oggi — il ciclo su `ancestorChain(...).slice(1)` non trova nulla e si cade sulla card generica, esattamente come ora. Cambia risultato **solo** quando esiste davvero una card su un antenato che prima veniva ignorata. Questa proprietà — dimostrabile, non solo osservata — è il test che conta più di tutti (§13).

## 3. Dove si innesta rispetto a `sellRateFor`

Il blocco delle sell rate negoziate ha già fissato, per iscritto, dove questo si deve innestare — `negotiated-sell-rates-design.md:143`: «l'ereditarietà si innesta poi **come un livello dentro il punto 3** della precedenza… senza ridiscutere ciò che sta sopra». Questo blocco rispetta quella decisione alla lettera: **non si tocca `sell-rate.util.ts`**.

Verificato sul codice live (oggi più avanzato del draft, che descriveva una versione pre-fix): `sellRateFor` (`src/app/services/sell-rate.util.ts`) ha già la sua precedenza a tre livelli corretta per unità (€/ora su ogni ramo, §12) e per validità (l'override di progetto è bound al periodo del contratto del progetto, se ne ha uno — un fix successivo al draft). Il punto 3 della sua precedenza arriva già come **numero risolto** (`resource?.billRate`, passato dal chiamante — `src/app/services/finance.util.ts:799`, dentro `recognitionSchedule`): `sellRateFor` non sa e non deve sapere se quel numero viene da un match esatto o da un antenato. L'intera modifica di questo blocco vive quindi **a monte**, dentro `withEffectiveRates`/`resolveResourceRates` (`src/server.ts:1639-1660`), e `sellRateFor` non cambia una riga. Una tariffa negoziata continua a battere qualsiasi card, ereditata o no: la precedenza 1/2/3 di quel blocco è invariata, cambia solo **come si calcola** il numero al punto 3.

## 4. Organizzazione senza nodo (dati legacy), e antenati in conflitto

**Dato legacy (`organization` non risolve a nessun nodo):** il ramo `own` in §2 gira comunque, con lo stesso confronto letterale di oggi. Se `nodeByName(organization, nodes)` non trova nulla, il ramo dell'albero è saltato del tutto e si cade dritti sulla card generica — esattamente il comportamento di oggi, bit per bit. `Resource.organization` è validato contro il catalogo `resourceOrganizations` a ogni scrittura (`validateCatalogValue`, chiamato da `crud('resources', ...)`), quindi un valore realmente orfano può nascere solo da dati pre-esistenti la validazione o da un nodo cancellato — la cancellazione di un nodo referenziato da una risorsa è già bloccata con **409** (`apiRouter.delete('/resource-organizations/:id', ...)`, `src/server.ts:4259` e seguenti). Il comportamento per questo caso è "non peggiora": chi aveva un match esatto lo mantiene, chi non l'aveva ricade sulla generica come ora.

**Due antenati diversi con una card ciascuno (non è un'ambiguità in lettura):** oggi la scrittura non impedisce che `Engineering` (capability) e `Backend` (competence, discendente) abbiano *entrambi* una card per lo stesso `(role, currency)` — l'unicità server (`src/server.ts`, validatore del `crud('rate-cards', ...)`, verificato alla riga 4356 e seguenti: «UNIQUENESS: at most one card per (role, organization, currency)») è sulla tripla **letterale**, non sulla posizione nell'albero, quindi due stringhe diverse non collidono mai fra loro. Questo non produce ambiguità in **lettura**: `ancestorChain` è un totale ordine dal nodo alla radice (nessun nodo ha due genitori), quindi per qualunque risorsa esiste esattamente una sequenza di antenati, e il ciclo del §2 ritorna sul primo hit in quell'ordine — il più vicino, sempre e deterministicamente. L'ambiguità che un amministratore potrebbe percepire non è nella risoluzione (totale e deterministica) ma nella **scrittura**: due card che possono convivere senza errore mentre solo una sarà mai effettivamente raggiunta da una risorsa reale. Questo blocco non aggiunge un vincolo di scrittura che lo impedisca (sarebbe legittimo avere una card "di riserva" su un antenato per coprire nodi non ancora creati) — invece, avvisa **al momento del salvataggio** (§7), che è la decisione presa sul punto.

## 5. Dove vive il resolver: `rate-card.util.ts`, e la fine della duplicazione

**Decisione (non più aperta):** un nuovo file `src/app/services/rate-card.util.ts`, parallelo a `sell-rate.util.ts` — stesso principio («nessun I/O, nessun orologio, nessuna dipendenza Angular»). Le alternative scartate:

- **Dentro `org-scope.util.ts`:** quel file si dichiara esplicitamente di ambito visibilità/appartenenza (doc comment di testa, verificato: «TWO INDEPENDENT AXES… the axis of BELONGING… the axis of VISIBILITY»), non tariffe. Aggiungerci `pickRateCard` ci spingerebbe dentro una responsabilità che il file nega di avere.
- **Dentro `server.ts`, esportata solo per i test:** chiude il gap di test (§13) ma **non** elimina la duplicazione in `resources.component.ts` — un componente Angular non deve importare da `server.ts` (un file Node-only, con `Express`/repository/IO), quindi `inheritedRate()` continuerebbe a reimplementare la logica a mano.

Solo l'opzione scelta rende vero che `resources.component.ts` **smette** di duplicare la logica — che è il punto della scelta, non un effetto collaterale.

**Cosa contiene il file, e da dove importa.** `pickRateCard` (§2) più `RATE_BASE_CURRENCY` (spostata verbatim da `src/server.ts:1601`, dove oggi è l'**unico** uso del nome in tutto il file — verificato via grep, quindi lo spostamento non lascia un riferimento pendente) e `conflictingCardMessage` (§7b). Importa `nodeByName`, `ancestorChain`, `descendantOrgIds`, `type OrgNode` da `./org-scope.util` (già pure, già lì, già testate in `org-scope.util.spec.ts`) e `type RateCard` da `./api.service` — quest'ultimo per lo stesso motivo per cui `src/server.ts:22` già importa `type { FxRate, RateCard } from './app/services/api.service'`: `RateCard` è un tipo **preesistente**, di cui `api.service.ts` è già il proprietario canonico (a differenza di `NegotiatedRate`, che `sell-rate.util.ts` ha dichiarato da zero perché non esisteva prima). Non introdurre una terza dichiarazione dello stesso shape.

Nota sulla costante valuta: il codebase ha già `RATE_BASE_CURRENCY` (server, privata), `SELL_RATE_BASE_CURRENCY` (`sell-rate.util.ts`, esportata) e una `BASE_CURRENCY` locale in `manage-rate-cards.component.ts`, oltre al `BASE_CURRENCY` canonico esportato da `api.service.ts:829`. `rate-card.util.ts` **non** importa quest'ultimo: dichiara la propria `RATE_BASE_CURRENCY`, sullo stesso modello già scelto da `sell-rate.util.ts` per la propria costante — coerenza con il precedente più recente, non una svista. La proliferazione dei quattro nomi è preesistente e fuori scope per questo blocco.

**`server.ts`:** rimuove la propria `RATE_BASE_CURRENCY` (riga 1601) e la propria `pickRateCard` (righe 1625-1630), importa entrambe da `rate-card.util.ts`, e passa un quarto argomento a `withEffectiveRates`/`pickRateCard`: `nodes`. `resolveResourceRates` (`src/server.ts:1656-1660`) aggiunge un `await repos.resourceOrganizations.list()` accanto ai due `await` che già fa (`repos.rateCards.list()`, `getHoursPerDay()`) — stessa forma, non una nuova categoria di cambiamento; nessuno dei 5 call site elencati sotto può già `await` (tutti dentro handler Express `async` o helper `async` chiamati da uno di essi):

1. `GET /resources` — `src/server.ts:1701`
2. `GET /resources/:id` — `src/server.ts:1703`
3. `POST /resources` (risposta dopo la creazione) — `src/server.ts:1817`
4. `PUT /resources/:id` (risposta dopo l'update) — `src/server.ts:2027`
5. `accruedTAndM()` — `src/server.ts:5072`, chiamata dal path di scrittura `/billing-plan-items` a `src/server.ts:5143`

`pickRateCard`/`withEffectiveRates` restano sincrone e pure: `nodes` diventa un quarto/terzo argomento passato per valore, esattamente come `sellRateFor` riceve `rates`/`projects`/`contracts` come argomenti semplici senza mai leggere un repository da sé.

**`resources.component.ts` — la duplicazione che finisce davvero.** `inheritedRate` (oggi `:678-685`, verificato live) reimplementa a mano lo stesso confronto a due passi che `pickRateCard` fa. Con questo blocco, importa `pickRateCard` da `rate-card.util.ts` e passa `this.orgOptions()` — già caricato per il `<select>` dell'organizzazione (`orgsRes`, `:463-467`), oggi presente in scope e **non usato** da `inheritedRate` — come quarto argomento `nodes`. Nessun nuovo fetch: il dato è già lì, semplicemente non collegato.

## 6. Ogni consumatore, e il gating a tre stati

**Questo blocco non introduce nessuna nuova cifra sui consumatori esistenti** (`finance.util.ts`, `match.util.ts`, `accruedTAndM`, `billing.ts` `tmAccrued()`, `dashboard.component.ts`, `reporting.ts`): tutti continuano a leggere `Resource.costRate`/`billRate`/`costRateDay`/`billRateDay` dalla stessa risposta già risolta lato server, quindi il loro stato di caricamento esistente resta valido senza modifiche. La verifica: nessuno di questi file legge `pickRateCard` direttamente, tutti passano per `resolveResourceRates`/`GET /resources`.

**Due punti *nuovi* introducono davvero una cifra sullo schermo, e sono l'oggetto di questo paragrafo:** il form risorsa (§7a, provenienza) e la nuova cifra di billability per risorsa (§8). Per entrambi si applica la regola del progetto, enunciata con le sue stesse parole: **`status()==='error' ? [] : value()` che alimenta una cifra mostrata è vietato.** Ha prodotto un Critical qui quattro volte in una settimana, l'ultima delle quali rendeva Margine = Ricavo Ordine con Margine % 100.0 per un ruolo a cui la lettura sottostante era negata — un errore diventato "zero", zero diventato "niente da sottrarre", e il margine sembrava perfetto proprio perché il dato che l'avrebbe eroso non c'era. Ogni cifra mostrata deve passare per uno stato esplicito a tre valori `error | loading | ready` su **una** lista di input condivisa, con `!authReady()` che conta come `loading`.

**Riferimento verificato, corretto due volte.** In questo codebase esistono **due** implementazioni di riferimento dello stato a tre valori `computed<'error' | 'loading' | 'ready'>`: `contract-details.ts::moneyFiguresState()` (`src/app/commercial/contract-details/contract-details.ts:1491`) e `what-if.ts::dataState()` (`src/app/forecast/what-if.ts:481-485`).

La prima stesura di questo paragrafo diceva che `dataState()` non esiste, sulla base di un grep pulito eseguito nel worktree così com'era al momento — un worktree creato da `main` a `89351f2`, un punto **precedente** al merge del blocco F, che è precisamente il blocco che ha introdotto `dataState()`. Il grep era onesto sull'albero interrogato ed era sbagliato sul progetto: dopo il rebase di questo branch sul `main` aggiornato (`f2b6edd`), `dataState()` esiste, con dieci riferimenti nel file. L'errore non era nella verifica ma nel momento in cui è stata fatta — la lezione è verificare di nuovo dopo ogni rebase su un `main` che si muove, non fidarsi di un grep pulito eseguito prima che l'albero sotto i piedi cambiasse.

`dataState()` è la implementazione **più recente** delle due, e vale la pena citarla per un motivo specifico oltre alla novità: il suo doc comment (`:456-479`) rende esplicito, nello stesso file, che `!authReady()` conta come `'loading'` — «pre-authReady `dataRes`/`projectsRes` resolve SUCCESSFULLY with their empty defaults... so treating that as 'ready' would render a confident "no data"/"matches baseline" for a baseline that was never actually loaded yet» — la stessa clausola che questo blocco richiede per le proprie superfici (§8). Il commento cita anche `contract-details.ts`'s `moneyFiguresState()` per nome come precedente diretto, e nota una terza variante imparentata ma non identica — `billing.ts`'s coppia `financialDataError()`/`financialDataLoading()` (`src/app/commercial/billing/billing.ts:841,851`), due booleani distinti invece di un unico discriminante a tre valori — che questo documento non tratta come una terza implementazione della stessa forma, solo come una parente dello stesso principio.

Per il form risorsa (§7a, §8), lo stato a tre valori è:

```ts
protected rateFiguresState = computed<'error' | 'loading' | 'ready'>(() => {
  const inputs = [this.rateCardsRes, this.orgsRes, this.assignmentsRes];
  if (inputs.some(r => r.status() === 'error')) return 'error';
  if (!this.auth.authReady() || inputs.some(r => r.isLoading())) return 'loading';
  return 'ready';
});
```

`rateCardsRes`/`orgsRes` esistono già (`:473-478`, `:463-467`); `assignmentsRes` è nuovo (§8). Il template usa `rateFiguresState()` per scegliere fra tre rami — mai un accessorio che collassa `error` su un valore che sembra un numero legittimo. Per il pannello di errore, `app-list-state` (`src/app/shared/list-state.component.ts`) — porta già `role="alert"` e un'icona, ed è il componente stabilito per questa presentazione in tutto il progetto.

## 7. Provenienza nel form risorsa, e avviso non bloccante al salvataggio

**Decisione (non più aperta).** Due superfici UI, entrambe richieste, entrambe accettate come lavoro UI aggiuntivo:

### 7a. Provenienza nel form risorsa ("Inherited from Engineering")

Il form risorsa (`resources.component.ts`, il blocco RATE CARDS del template, oggi `:352-370`) mostra già un hint quando `inheritedRate()` risolve una card, ma non dice **da dove viene**. Lo stesso principio già imposto per le sell rate negoziate vale qui identico: la provenienza grigia/testuale è *il* requisito che conta, perché mostra da dove viene il prezzo (`negotiated-sell-rates-design.md`, §7: «quel grigio è il requisito che conta»).

La provenienza si deriva **senza** cambiare la forma di ritorno di `pickRateCard` (che resta `RateCard | undefined`, invariata per non toccare `withEffectiveRates`): il campo `card.organization` della card vincente dice già tutto quello che serve, confrontato con l'organizzazione della risorsa nel form.

```ts
/** Da dove viene la card risolta — derivato dal solo `card.organization`, senza
 *  che `pickRateCard` debba restituire altro oltre alla card stessa. */
protected rateCardProvenance = computed<string | null>(() => {
  const card = this.inheritedRate();
  if (!card) return null;
  if (!card.organization) return 'the generic rate card';
  if (card.organization === this.orgValue()) return `the ${card.organization} rate card`;
  return `Inherited from ${card.organization}`;
});
```

Tre rami, non due: una card sul **nodo proprio** della risorsa non è "ereditata" — dirlo sarebbe falso quanto l'inverso — mentre una card generica non ha un'organizzazione da nominare. Solo il terzo ramo (un antenato) usa la frase del brief alla lettera. Il template aggiunge questa etichetta nell'hint esistente sotto gli input cost/bill (già `:366-369`), non un nuovo blocco separato — stessa riga logica, un'informazione in più.

### 7b. Avviso non bloccante al salvataggio (`manage-rate-cards.component.ts`)

Al salvataggio (create o update) di una card, se il suo nodo ha **almeno un antenato o discendente** con una card per lo stesso `(role, currency)` in valuta base, un toast **informativo, non bloccante** (`NotificationService.show(msg, 'info')` — il tipo `'info'` esiste già, `src/app/services/notification.service.ts:4,31`; il salvataggio non è mai impedito):

> *"This role already has a card on {other node}: this new card covers only {this node} and its descendants without a card of their own."*

Il testo è **direzione-agnostico** per costruzione, non solo per comodità: che `{other node}` sia un antenato o un discendente, la seconda metà della frase resta vera in entrambi i casi — se `{other node}` è un discendente con una card propria, quel discendente è per definizione **escluso** da "i suoi discendenti senza card propria" (la sua card vince per vicinanza, §2), quindi la frase non promette nulla che non accada. Non sono due messaggi con un `if` in mezzo: è una frase, verificata vera nei due sensi.

```ts
/** Null se non c'è conflitto potenziale, altrimenti il testo del toast (§7b). */
export function conflictingCardMessage(
  saved: { organization?: string; role: string; currency: string },
  otherCards: readonly RateCard[],
  nodes: readonly OrgNode[],
): string | null {
  if (!saved.organization || saved.currency !== RATE_BASE_CURRENCY) return null;
  const node = nodeByName(saved.organization, nodes);
  if (!node) return null;
  const ancestorNames = new Set(ancestorChain(node.id, nodes).slice(1).map(a => a.name));
  const descendantIds = descendantOrgIds(node.id, nodes);
  const other = otherCards.find(c => {
    if (c.role !== saved.role || c.currency !== RATE_BASE_CURRENCY || !c.organization) return false;
    if (ancestorNames.has(c.organization)) return true;
    const otherNode = nodeByName(c.organization, nodes);
    return otherNode !== undefined && otherNode.id !== node.id && descendantIds.has(otherNode.id);
  });
  return other
    ? `This role already has a card on ${other.organization}: this new card covers only ${saved.organization} and its descendants without a card of their own.`
    : null;
}
```

**Perché il filtro sulla valuta base è necessario, non decorativo:** `pickRateCard` (§2) ignora ogni card fuori dalla valuta base a monte, nel filtro `forRole` — due card non-EUR sullo stesso `(role, currency)` non collidono **mai** in lettura, qualunque sia la loro posizione nell'albero, perché nessuna delle due viene mai risolta. Avvisare comunque sarebbe un falso allarme: l'amministratore vedrebbe un conflitto che il resolver non produrrà mai. `conflictingCardMessage` applica lo stesso filtro di `pickRateCard`, non uno nuovo.

**Perché non per una card generica:** una card senza `organization` non ha un `{this node}` da nominare nella frase — il messaggio non ha senso per quel caso, e il brief non lo richiede. Salvare una card generica non genera l'avviso.

Il resolver di conflitto vive in `rate-card.util.ts` insieme a `pickRateCard` (§5): non serve a `server.ts`, ma è un aiuto di sola lettura sulle stesse forme (`RateCard`, `OrgNode`) e beneficia dello stesso test diretto, non solo di un test a livello componente.

## 8. `resourceBillability` agganciata al form risorsa

**Verificato di nuovo, non solo riportato dal draft:** `resourceBillability(resourceId, d: FinanceData)` (`src/app/services/finance.util.ts:242-248`) è **oggi orfana** — grep su tutto `src/app` (esclusi gli spec) per `resourceBillability` trova **solo** la propria dichiarazione; nessun componente la chiama. Ha però già un test unitario del layer puro (`finance.util.spec.ts:146-151`, `res('1', 75, 140)` con 100 ore → `{hours:100, cost:7500, billable:14000}`) — "orfana" qui significa "nessun chiamante applicativo", non "non testata": il test pinna già l'aritmetica pura, quel che manca è il collegamento a uno schermo.

**Decisione:** agganciarla al form risorsa, accanto all'hint di provenienza (§7a) — "da dove viene il prezzo" e "quanto vale questa persona" sono le due metà della stessa domanda, e il brief lo rende esplicito. Il commento sul codice della funzione (verificato, `:236-240`) chiarisce già che resta **deliberatamente** sul `billRate` di riferimento, non su `sellRateFor`: non cambia con questo aggancio.

**Come arriva il dato, senza nuove fetch inutili.** `FinanceData` (`finance.util.ts:6-45`) richiede `requests`/`orders`/`orderLines`/`financials` come campi non opzionali per il tipo, ma `resourceBillability` legge **solo** `d.resources` e `d.assignments` (verificato sul corpo della funzione). Il form costruisce quindi un `FinanceData` letterale con questi due popolati e gli altri a `[]` — zero fetch aggiuntive per campi inutilizzati, un solo nuovo `rxResource` per `assignments`:

```ts
// Nuovo, sullo stesso idioma già in uso in questo file per orgsRes/rateCardsRes
// (rxResource<T, boolean> con params su authReady, non authGatedResource — questo
// file non usa quell'helper altrove, e restare coerenti con i vicini conta più
// di introdurre un pattern "migliore" a metà file).
protected readonly assignmentsRes = rxResource<Assignment[], boolean>({
  params: () => this.auth.authReady(),
  stream: ({ params: ready }) => (ready ? this.api.getAssignments() : of<Assignment[]>([])),
  defaultValue: [] as Assignment[],
});

protected billability = computed<{ cost: number; billable: number; hours: number } | null>(() => {
  const id = this.editingId();
  if (!id || this.rateFiguresState() !== 'ready') return null;
  const data: FinanceData = {
    requests: [], orders: [], orderLines: [], financials: [],
    resources: this.resources(), assignments: this.assignmentsRes.value(),
  };
  return resourceBillability(id, data);
});
```

**Gate obbligato su `rateFiguresState()`.** La cifra non nasce da un contenitore parzialmente caricato: se `assignmentsRes` è in `error`, `billability` è `null`, e il template mostra il pannello d'errore di `app-list-state` (§6) — **mai** uno `0` che assomiglierebbe a "questa persona non porta valore". Il gate su `editingId()` esiste perché la cifra ha senso solo per una risorsa già esistente (id noto per filtrare gli assignment); nella modalità "Create employee" non compare.

**RBAC — nessuna nuova regola.** `/assignments` è già letta da `pm`/`resource-manager`/`delivery-executive`/`finance`/`admin` (`docs/roles-and-permissions.md`, tabella READ_RULES), e lo schermo Resources è raggiungibile solo da `resource-manager`/`delivery-executive`/`admin` (`src/app/app.routes.ts:10`, `roleGuard`) — un sottoinsieme, quindi ogni ruolo che raggiunge questo form può già leggere `/assignments`. Nessuna riga nuova nella RBAC (a differenza del gap chiuso in §11, che è preesistente e non causato da questo aggancio).

**Unità — esplicita.** `resourceBillability` restituisce `cost`/`billable` in **€** (ore × €/ora, entrambi i fattori già nella stessa unità — `resource.costRate`/`billRate` sono €/ora per costruzione, §12), non €/giorno: nessuna conversione qui, e il template formatta con `number:'1.0-2'` come ogni altra cifra monetaria del form.

**Test — pin del comportamento come parte dell'aggancio.** Il test puro esistente (`finance.util.spec.ts:146-151`) resta e non cambia: pinna già l'aritmetica. Il nuovo test è a livello componente (`resources.component.spec.ts`), e verifica che lo schermo mostri la cifra corretta **e** che un `assignmentsRes` in errore mostri il pannello d'errore, non uno zero — l'assenza che deve accompagnare ogni presenza (§13).

## 9. Il report d'impatto — passo manuale nel deploy checklist

Sul modello di `scripts/negotiated-rate-impact.mjs` (letto per intero) — dependency-free, `fetch` globale di Node 20+, stesso idioma `BASE`/`API`/`RBAC_HEADERS`/`req()` — un nuovo script `scripts/rate-inheritance-impact.mjs`.

**Cosa confronta, per risorsa:** per ogni risorsa con un `role`, calcola due volte il costo/prezzo effettivo **in €/giorno** (non €/ora — confrontare in €/giorno evita la scala nascosta di `hoursPerDay`, un fattore globale identico su "prima" e "dopo" che non aggiungerebbe informazione al confronto):

- **"prima"** — la risoluzione di oggi, portata verbatim nello script: match esatto sull'`organization` della risorsa, altrimenti la card generica;
- **"dopo"** — la risoluzione con la camminata sugli antenati (§2), stessa porting verbatim, usando le stesse `RateCard[]`/`OrgNode[]` grezze da `/rate-cards` e `/resource-organizations`.

Ogni riga usa `override ?? cardResult` per entrambe le colonne — l'override per-risorsa (`costRateOverride`/`billRateOverride`, già sul wire, invariato dal blocco) non cambia mai fra "prima" e "dopo": solo la card sottostante può cambiare.

Stampa **solo** le risorse per cui almeno uno dei due numeri cambia: id, nome, ruolo, organizzazione, costo prima→dopo, prezzo prima→dopo, delta in €/giorno.

**Il gate, enunciato con precisione — la trappola in cui questo blocco rischia di cadere.** La proprietà forte è sulle **tabelle** (`rateCards`+`resourceOrganizations`), non sulle risorse: *se nessuna card è attaccata a un nodo che ha almeno un discendente*, allora per qualunque collocazione delle risorse "prima" e "dopo" sono identici — perché il ciclo su `ancestorChain(...).slice(1)` non troverebbe mai un hit. Questa è una proprietà dimostrabile a priori, indipendente da dove si trovino le risorse in un dato momento, ed è il test di proprietà nel layer puro (§13) — **non** l'osservazione empirica sul report live. Sul seed **come committato prima di questo blocco**, il report stamperebbe zero righe per la ragione debole (nessuna risorsa sotto `Engineering`), esattamente come il gemello `negotiated-rate-impact.mjs` stampava zero righe "per costruzione" su una tabella vuota — zero non è evidenza.

**Per questo, il seed guadagna una riga nuova.** `src/db/seed.ts` aggiunge la risorsa `id: '13'`, `role: 'Developer'`, `organization: 'Backend'` (il nodo competence più profondo, `parentId` → `Platform` → `Engineering`), senza `costRate`/`billRate` propri (nessun override, per lasciare che la card faccia tutto il lavoro). **Nota sull'id:** non `'7'` — il blocco F (bench/disponibilità, già mergiato in `main`) ha già occupato gli id `'7'`-`'9'` nell'array `resources` (Priya Kapoor, Marco Belli, Elena Rossi) e gli id `'7'`-`'11'` nei fixture `requests`/`assignmentsBase`; il blocco E, in corso in parallelo, ha già preso `'12'`. `'13'` è il primo libero verificato sul seed live al momento della stesura — da riverificare comunque al momento dell'implementazione, perché più agenti scrivono sullo stesso file in parallelo. Verificato a mano contro il seed live:

- **prima** (match esatto): `'Backend'` non è `'Engineering'` ⇒ ricade su `RC_DEV` ⇒ **cost 600 / bill 1120 €/giorno**;
- **dopo** (camminata): `ancestorChain('6', nodes)` = `[Backend, Platform, Engineering]` innermost-first ⇒ `.slice(1)` = `[Platform, Engineering]` ⇒ nessuna card su `Platform` ⇒ hit su `RC_DEV_ENG` (organization `'Engineering'`) ⇒ **cost 640 / bill 1200 €/giorno**;
- **delta**: **cost +40,00 €/giorno, bill +80,00 €/giorno**, esattamente un'unica riga nel report.

Questo numero letterale è quello che il report deve stampare al primo run dopo il merge, ed è la riga che sostituisce "zero per mancanza di dati" con "zero per costruzione, verificato anche con un caso reale che si muove".

**Passo manuale, come il gemello — ma scritto dove si legge davvero.** `rate-inheritance-impact.mjs` richiede un server già in esecuzione (come `negotiated-rate-impact.mjs`), e questo progetto non ha un job CI che avvia un server per interrogarlo via HTTP (i test Vitest non toccano una porta). Nessun wiring CI. **Verificato, non assunto:** il passo del gemello (`negotiated-rate-impact.mjs`) non è oggi scritto in nessun documento di deploy — grep su `docs/` per `negotiated-rate-impact` trova solo la sua propria spec/piano, non `docs/architecture/06-deployment-operations.md`. Dipende quindi solo dalla disciplina di chi ha scritto quel piano, esattamente il difetto che il brief di questo blocco chiede di non ripetere: *"il passo deve essere scritto nella checklist di deploy… non solo in un report che nessuno rilegge."*

**Collocazione esatta.** `docs/architecture/06-deployment-operations.md` guadagna una nuova sezione numerata **`## 11. Pre-merge impact reports (manual gate)`**, in coda al documento (dopo l'attuale `## 10. Security operations notes`, che è l'ultima sezione oggi) — non richiede una rinumerazione delle sezioni esistenti. La nuova sezione elenca **entrambi** gli script gemelli come passo manuale pre-merge quando la relativa area di dati cambia:

- `scripts/negotiated-rate-impact.mjs` — quando `negotiated_rates`, `contracts` o `rate_cards` cambiano; gate: tabella vuota ⇒ zero righe *per costruzione* (non è la prova di correttezza — quella vive nei test unitari); con dati, il delta atteso va confrontato a mano prima del merge;
- `scripts/rate-inheritance-impact.mjs` (questo blocco) — quando `rate_cards` o `resource_organizations` cambiano; gate: nessuna card su un nodo non-foglia ⇒ zero righe *per costruzione*; sul seed di questo blocco, esattamente una riga con il delta di cui sopra.

**Perché anche il gemello, non solo il nuovo script.** Creare per la prima volta una sezione "report d'impatto pre-merge" e scriverci **solo** il nuovo script avrebbe lasciato la sezione stessa a mentire per omissione — esattamente la stessa famiglia di difetto che questo progetto continua a incontrare (una verifica che sembra completa e non lo è). Chiudere il gap del gemello nello stesso movimento non è scope creep sul blocco di questo documento: è la stessa identica riga di documentazione, per lo stesso identico tipo di script, nello stesso file.

## 10. Unicità — nessuna nuova regola di scrittura

Il vincolo di scrittura di oggi (validatore del `crud('rate-cards', ...)`, `src/server.ts`, righe 4341-4356 verificate: «al più una card per `(role, organization, currency)`») resta l'unico vincolo. La camminata sugli antenati non introduce ambiguità in **lettura** (§4: `ancestorChain` è un ordine totale) e quindi non richiede un vincolo nuovo in **scrittura** per restare corretta — a differenza di due tariffe negoziate sullo stesso `(contractId|projectId, role, currency)`, che richiedono un vincolo di unicità perché lì la lettura non ha un ordine di priorità posizionale a disambiguare. Qui l'ordine posizionale nell'albero fa già quel lavoro. Non toccare il vincolo di scrittura è la scelta minima, non una svista — l'avviso non bloccante di §7b è la risposta scelta al disagio che due card "convivrebbero" senza mai potersi disambiguare a vicenda in scrittura.

## 11. RBAC — invariato, e il gap in `docs/roles-and-permissions.md`

Questo blocco **non** aggiunge nessun endpoint, nessuna nuova collezione, nessuna nuova regola RBAC: `/rate-cards`, `/resources`, `/resource-organizations` esistono già e le loro regole non cambiano. Verificato sul codice live (`src/server.ts`):

- **Mutazione `/rate-cards`:** `admin`, `delivery-executive`, `finance` (riga 656, verificata: `{ test: p => p.startsWith('/rate-cards'), roles: [...] }`).
- **Lettura `/rate-cards`:** `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` (riga 716, verificata).

**Ma `docs/roles-and-permissions.md`, la fonte dichiarata autoritativa (`CLAUDE.md`), non menziona `/rate-cards` in nessuna delle due tabelle** — verificato con grep case-insensitive su tutto il documento: zero occorrenze di "rate-card"/"RateCard" nelle tabelle READ_RULES e Mutation rules, mentre `/negotiated-rates` (arrivata più tardi) c'è. È un gap **preesistente**, non causato da questo blocco, ma questo blocco tocca direttamente la funzione di risoluzione che quella regola protegge, quindi è il momento di chiuderlo: la stessa lezione già pagata due volte nel blocco F ("una nuova regola aggiunta senza aggiornare il documento") si applica anche a una regola **vecchia** mai stata scritta. La riga da aggiungere, verbatim identica al codice, a **entrambe** le tabelle di `docs/roles-and-permissions.md`:

| Collection(s) | Allowed roles |
| --- | --- |
| `/rate-cards` | READ: `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` — MUTATION: `admin`, `delivery-executive`, `finance` |

Nessuna riga cambia significato per effetto di questa aggiunta (a differenza del caso F citato dal brief, dove aggiungere la riga esponeva un paragrafo vicino diventato falso) — verificato leggendo l'intero documento: nessun paragrafo esistente assume che `/rate-cards` sia "open" o diverso da quanto il codice fa oggi.

## 12. Unità di misura, formattazione, e parità dev/prod

- **Nessuna migration, nessuna colonna nuova, nessun endpoint nuovo.** Il blocco è puro codice di risoluzione (`rate-card.util.ts`) più tre superfici UI (provenienza, avviso, billability) — verificato in ogni sezione sopra. Non si applica quindi né `nullsToUndefined()` né la parità del `PATCH` vuoto (`src/db/repository.ts`): non c'è nulla di nuovo da leggere o scrivere sul repository che non esista già. Se un futuro reviewer cerca una migration per questo blocco, non ce n'è una — a differenza delle sell rate negoziate, che ne avevano una e per cui era un gate obbligatorio.
- **€/giorno vs €/ora, esplicito in ogni punto che tocca un numero.** `RateCard.costRate`/`billRate` (lo storage) e `Resource.costRateDay`/`billRateDay` (l'effettivo, override ?? card) sono **€/giorno**; `Resource.costRate`/`billRate` (quello che ogni consumatore di margine legge) è **€/ora** (`costRateDay/hpd`). Il report d'impatto (§9) confronta in €/giorno per evitare la scala nascosta di `hoursPerDay`; `resourceBillability` (§8) moltiplica ore × €/ora, quindi produce **€** puri, non €/giorno né €/ora. Ogni cifra di questo documento porta la propria unità accanto, per lo stesso motivo per cui un blocco precedente ha spedito un fattore 8 di inflazione sui ricavi avendo lasciato l'unità implicita.
- **Massimo 2 decimali a schermo.** Ogni cifra nuova (provenienza — i valori già mostrati nell'hint, invariati; billability) usa `number:'1.0-2'`, mai il `DecimalPipe` nudo (che di default userebbe `1.0-3`). `—` (em dash) resta il placeholder "nessun valore" stabilito nel progetto (verificato in uso in `billing.ts`/`contract-details.ts`); questo blocco non ne introduce un secondo.
- **`authReady` gating.** Ogni nuovo `rxResource` (`assignmentsRes`, §8) chiave i propri `params` su `auth.authReady()` e ritorna un default vuoto (`[]`) finché non è `true` — mai letto `auth.userId()`/`auth.role()` al field-init.

## 13. Verifica

- **Layer puro** (`src/app/services/rate-card.util.spec.ts`, nuovo file):
  - **Precedenza esaustiva, testata separatamente per ogni gradino** (mai due gradini nello stesso test): (a) match sul nodo proprio batte l'antenato più vicino e la generica; (b) l'antenato più vicino batte uno più lontano (albero sintetico a 3 livelli con card su due livelli diversi, stesso `role`/`currency`); (c) nessun antenato con card ⇒ ricade sulla generica esattamente come oggi; (d) un discendente **con** una card propria non è toccato da una card su un suo antenato (resta il proprio match, non quello dell'antenato).
  - `organization` che non risolve a nessun nodo (`nodeByName` → `undefined`) ⇒ comportamento identico a `pickRateCard` di oggi; nessun `role` ⇒ `undefined`; valuta diversa da EUR ⇒ ignorata, invariato.
  - **Il test che conta più degli altri, come proprietà e non come esempio:** generando alberi e collocazioni di card sintetiche in cui nessuna card sta su un nodo con figli, il risultato per ogni nodo/risorsa deve coincidere esattamente con quello di una reimplementazione di riferimento del `pickRateCard` di oggi (match esatto + generica, nessun antenato) — la versione automatizzata del gate del §9, verificata sul codice e non solo osservata su un dato di esempio.
  - `conflictingCardMessage` (§7b): nessun messaggio quando non c'è organizzazione, quando la valuta non è base, quando non c'è nessun'altra card in conflitto; messaggio presente per un conflitto con un antenato **e**, separatamente, per un conflitto con un discendente (due test, non uno con due assert); nessun messaggio quando l'unica altra card è sulla stessa organizzazione letterale (già bloccato dall'unicità, ma il resolver non deve inciamparci).
  - **Ogni test non banale ha un passo di mutazione esplicito** (§ "Task shape" del piano): esempio, invertire `.slice(1)` in `.slice(0)` deve far fallire il test (d) qui sopra, perché il nodo proprio tornerebbe a contare come proprio antenato e "batterebbe" se stesso — la stessa card, ma per la ragione sbagliata, che un test debole non distinguerebbe.
- **`resources.component.spec.ts`:** `inheritedRate` ritorna la card dell'antenato quando il nodo proprio non ne ha una; ritorna quella del nodo proprio anche quando un antenato ne ha un'altra; con `orgsRes` ancora vuoto (caricamento in corso) ritorna `null`, mai un numero. `rateCardProvenance`: le tre etichette (nodo proprio / antenato / generica), testate come tre casi distinti, non un solo test con tre assert. `billability`/`rateFiguresState`: la cifra corretta quando tutto è `ready`; il pannello d'errore (non uno zero) quando `assignmentsRes` è in errore — la coppia presenza/assenza richiesta dal progetto.
- **`manage-rate-cards.component.spec.ts`:** il toast informativo appare al salvataggio di una card in conflitto con un antenato **e**, separatamente, con un discendente; **non** appare al salvataggio di una card generica né di una card senza conflitti — l'assenza per ogni presenza.
- **Smoke** (`scripts/smoke-api.mjs`, nuovi check sul modello di quelli già presenti per `/negotiated-rates`, che creano e puliscono righe scoped al test): `GET /resources` per una risorsa la cui `organization` è una competence con card solo sulla capability antenata restituisce i valori della card antenata, non quelli della generica; una risorsa il cui nodo ha una card propria la mantiene anche se un antenato ne ha un'altra; una risorsa con `organization` legacy/non risolvibile si comporta esattamente come prima del blocco.
- **Report d'impatto** (`scripts/rate-inheritance-impact.mjs`, §9): sul seed con la nuova riga `id:'13'`, esattamente una riga stampata con il delta letterale **cost +40,00 / bill +80,00 €/giorno** — eseguito prima del merge, come da nuova sezione nel deploy checklist (§9).
- **Postgres fresco: non obbligatorio, ma buona pratica standard.** A differenza delle sell rate negoziate (che aggiungevano una tabella e quindi una migration, da cui l'obbligo dichiarato in quella spec), questo blocco non cambia lo schema (§12): `rate_cards` e `resource_organizations` restano come sono. Un passaggio su Postgres fresco resta comunque una regressione standard (i due adapter devono comportarsi identicamente), ma non è il gate specifico che era per la migration del blocco precedente.
- **Verifica in browser:** il form risorsa mostra la provenienza corretta nelle sue tre varianti quando si sposta una risorsa fra un nodo con card propria, un discendente senza card sotto una capability con card, e nessuna card affatto; la cifra di billability compare per una risorsa esistente e non per una in creazione; il salvataggio di una card su `Platform` con `RC_DEV_ENG` già su `Engineering` mostra il toast informativo e **non** blocca il salvataggio; il `<select>` di Manage Rate Cards mostra la gerarchia indentata.

## 14. Fuori scope

- **Nessuna conversione valutaria** nella risoluzione (invariato da oggi: una card fuori dalla valuta base è ignorata, non convertita).
- **Nessun nuovo vincolo di scrittura** sulla posizione nell'albero (§10) — l'avviso di §7b è informativo, non un blocco.
- **La billability company-wide resta sul `billRate` di riferimento** (invariato, commento già presente in `finance.util.ts:236-240`): questo blocco cambia *come* quel riferimento si risolve, non introduce un secondo calcolo per-progetto.
- **`what-if.ts` non guadagna uno stato a tre valori** in questo blocco: il gap esiste (§6) ma non è toccato da nessuna delle superfici di cui sopra — riparlarne è un blocco a sé.
- **La proliferazione delle costanti `*_BASE_CURRENCY`** (§5) resta com'è: una consolidazione è un piccolo blocco di refactoring a sé, non richiesto da questo brief.
