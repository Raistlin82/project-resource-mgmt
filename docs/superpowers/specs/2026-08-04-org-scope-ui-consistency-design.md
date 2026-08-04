# Design — Coerenza dell'ambito organizzativo in UI (post-D)

- **Data:** 2026-08-04
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Origine:** due delle tre domande di prodotto sollevate dalla review finale del gap **D** e decise dall'utente il 2026-08-04. La terza (ereditarietà delle rate card lungo l'albero) è un blocco a sé, successivo a questo.
- **Riferimento:** `docs/superpowers/specs/2026-08-03-d-org-hierarchy-people-manager-design.md`

---

## 1. Contesto e obiettivo

Il gap D ha introdotto due assi indipendenti — l'**organigramma** (`Resource.managerId`, transitivo) come asse della visibilità, e l'**albero organizzativo** (Capability > Practice > Competence) come asse dell'appartenenza — e li ha usati per instradare decisione e feed delle allocazioni. Due superfici sono però rimaste sulla nozione *precedente* di «le mie persone», e la loro incoerenza è visibile a un utente ordinario:

1. **`/utilization`** filtra `r.managerId === currentManagerId` (`src/app/utilization/utilization.component.ts:278`), cioè i soli **report diretti**. Un Capability Leader che gestisce un nodo ma nessuna persona in organigramma vede «My Team» vuoto e un utilizzo medio di 0%, mentre il feed di approvazione gli mostra tutto il suo sottoalbero.
2. **Il Substitute picker** della modale di approvazione pre-filtra i candidati sull'organizzazione del dummy con un confronto **esatto** (`filteredCandidates`, `approval-modal.component.ts:759`: `r.organization !== org`). Un dummy su `Engineering` non propone quindi nessun candidato che stia su `Platform` o `Backend`, benché siano nel suo stesso ramo.

**Obiettivo:** allineare entrambe le superfici alla nozione di ambito che D ha già reso autorevole, senza cambiare il significato di nessun numero già in uso.

**Fuori scope:** l'ereditarietà delle rate card lungo l'albero (blocco successivo, tocca importi fatturabili); qualunque modifica a `scopeOf`/`dimensionsOf`, che restano come sono; nuovi endpoint, nuove colonne, migration.

### 1.1 Un sospetto verificato e smentito

Durante l'esplorazione ho sospettato che `currentManagerId` (`utilization.component.ts:239`) confrontasse un **id utente** con `Resource.managerId`, che contiene un **id risorsa** — il difetto che D ha documentato altrove («comparare uno username con un `resourceId` è sempre falso sotto JWT reale, ed è così che un controllo d'ambito degrada in *nessuno corrisponde*»). **Non è così:** `auth.userId()` (`src/app/services/auth.service.ts:111`) risolve lo username a un resource id via `USERNAME_TO_RESOURCE_ID`, e il suo commento lo dichiara. Il confronto è omogeneo e il filtro attuale è corretto. Questa spec è quindi puramente additiva su quel punto.

---

## 2. `/utilization`: due viste

### 2.1 Comportamento

Un signal `teamScope: signal<'direct' | 'org'>` con default **`'direct'`**. Il default esistente non si muove: chi guarda quel numero ogni giorno lo ritrova identico.

- **`'direct'`** — `r.managerId === currentManagerId`, esattamente il filtro di oggi.
- **`'org'`** — `scopeOf(currentManagerId, resources, orgNodes)`, cioè l'unione dell'organigramma transitivo sotto l'attore e delle risorse nei sottoalberi org che gestisce. È la stessa funzione che governa il feed di approvazione, importata da `src/app/services/org-scope.util.ts` e **non** reimplementata.

`scopeOf` esclude l'attore stesso, quindi «All my org» non contiene chi la sta guardando — coerente con la vista dei report diretti, che nemmeno lo contiene.

### 2.2 Cosa vede chi non gestisce nulla, e i ruoli globali

**Decisione utente:** la vista mostra `scopeOf(attore)` **per tutti**, senza eccezioni per ruolo.

- Chi non gestisce né persone né nodi vede una vista **vuota**, con una riga che spiega perché.
- `admin` e `delivery-executive` vedono il **proprio** ambito, non l'intera azienda — pur essendo onniveggenti nel feed di approvazione.

Il motivo di quest'ultima scelta è che «la mia organizzazione» deve avere un solo significato: se per due ruoli fosse l'azienda intera, l'utilizzo medio sarebbe un KPI aziendale per loro e un KPI di team per tutti gli altri, e lo stesso numero direbbe due cose diverse a seconda di chi guarda.

### 2.3 Il KPI: i non-internal non entrano nella media

`averageUtilization` non cambia formula — è già la media di `managedResources()` e segue quindi la vista da sé. Cambia **cosa conta**.

`scopeOf` include le risorse dei sottoalberi org, quindi un **dummy** o un **subco** può comparire nella vista «All my org». La lista li mostra (sono nell'organizzazione), ma la media conta **solo** le risorse che passano `countsTowardInternalCapacity(kindOf(r))` da `src/app/services/resource-kind.util.ts`.

Questa non è una precauzione teorica: è la lezione del gap C1, dove i dummy gonfiavano i KPI di portfolio e il solo seed dimezzava l'utilizzo medio di `/reporting`. Per un placeholder lo scalare `utilization` è privo di significato — non è capacità di nessuno.

La regola si applica a **entrambe** le viste, non solo alla nuova: oggi un amministratore che assegnasse un manager a un dummy lo farebbe entrare nella media anche nella vista dei report diretti. È quindi anche una correzione, non solo un vincolo sul codice nuovo.

Quando la lista contiene righe non-internal e la media le esclude, la UI lo dichiara accanto al KPI: un numero il cui denominatore differisce dalle righe visibili va spiegato dove si legge, non solo nel codice.

### 2.4 Caricamento dati

Il componente carica già `resources` e le time entry in un `forkJoin` keyed su `auth.authReady()`, con un commento che spiega perché: una lettura anticipata partiva senza bearer, il 401 faceva collassare il `forkJoin` fail-fast e la vista restava vuota per sempre. L'albero organizzativo (`ApiService.getResourceOrganizations()`) entra **in quello stesso `forkJoin`** — nessun secondo caricamento indipendente, che è il difetto trovato e rimosso nel Task 8 di D (un dropdown usabile prima che la sua sorgente dati fosse risolta produceva una griglia falsamente vuota).

`currentManagerId` resta un **getter** che legge `auth.userId()` a ogni valutazione. Non va convertito in un campo: un valore catturato al field-init congela il default anonimo e associa l'ambito al manager sbagliato dopo un reload.

### 2.5 Il controllo di vista

Due bottoni in un segmented control, con la vista attiva indicata da `aria-pressed`, realizzati con le classi `command-*` esistenti e i token di `src/styles.css` — nessun token nuovo, Material solo per le icone. Testo in **inglese**: `Direct reports` e `All my org`. Il controllo è **sempre presente**, anche quando la seconda vista risulterebbe vuota: un controllo che appare e sparisce in base ai dati è difficile da spiegare e da testare, e nasconde l'informazione utile («non gestisci nessuna organizzazione»).

### 2.6 Messaggi di vista vuota

I due casi sono distinti e vanno detti in modo distinto:

- vista `'direct'` vuota → nessuno riporta direttamente all'attore;
- vista `'org'` vuota → l'attore non gestisce nessuna organizzazione né alcuna persona in organigramma.

---

## 3. Il pre-filtro del Substitute picker

`defaultOrgFor(row)` resta invariato: pre-seleziona l'organizzazione del dummy, e il select conserva la sua opzione «All organizations», quindi il filtro è sempre azzerabile.

Cambia solo il **matching** in `filteredCandidates` (`approval-modal.component.ts:755-763`): il confronto esatto `r.organization !== org` diventa un confronto contro le **dimensioni derivate** del candidato, ottenute con `dimensionsOf(r, orgNodes())`. Un candidato passa quando una qualsiasi delle sue dimensioni (capability, practice, competence) è uguale al filtro. Un filtro su `Engineering` accetta dunque anche chi sta su `Platform` o `Backend`.

L'albero è **già** caricato nel componente: `orgNodesRes`/`orgNodes()` (`approval-modal.component.ts:723-728`) esistono dal Task 5 di D per `canDecideFor`. Nessun caricamento nuovo.

Poiché il comportamento non è visibile dal solo select, una riga sotto di esso dichiara che il filtro include le organizzazioni annidate. Senza quella riga un operatore non può distinguere «la lista è corta» da «la lista è filtrata».

Il filtro per nome/ruolo, l'ordinamento e le regole di eleggibilità dei candidati (solo `internal`, non terminati) restano **invariati**.

---

## 4. Errori e casi limite

| Caso | Comportamento |
|---|---|
| L'albero org non è ancora caricato | `orgNodes()` è `[]`; `dimensionsOf` restituisce `{}` e `scopeOf` l'insieme dell'organigramma. Nessun errore, nessuna eccezione: la vista si arricchisce quando i dati arrivano. Il `forkJoin` di `/utilization` risolve i tre insiemi insieme, quindi lì il caso non si presenta. |
| Risorsa senza `organization` | Non compare in nessun sottoalbero; entra nella vista `'org'` solo per via dell'organigramma. |
| Risorsa attaccata a un nodo inesistente | `dimensionsOf` restituisce `{}`: non passa nessun filtro di dimensione. Nessun errore. |
| Ciclo nei dati (organigramma o albero) | Le traversate di `org-scope.util` portano un `visited` set che garantisce la terminazione; la scrittura di nuovi cicli è già rifiutata da D. |
| Attore non risolvibile a una risorsa | `auth.userId()` ha un default; l'ambito risulta vuoto e la vista `'org'` mostra il messaggio di §2.6. |
| Vista `'org'` con soli dummy/subco | La lista li mostra, la media è `0` su denominatore vuoto — il KPI mostra `0%` e la nota di §2.3 spiega perché non conta quelle righe. |

---

## 5. Verifica

- **Nuovo** `src/app/utilization/utilization.component.spec.ts` (il componente non ne ha): il default è `'direct'` e riproduce il filtro attuale; lo switch a `'org'` include una risorsa raggiungibile **solo** per via del sottoalbero org (nessun legame di organigramma) e una raggiungibile solo per organigramma; il KPI segue la vista; un dummy nel sottoalbero compare nella lista ma **non** nella media; i due messaggi di vuoto. Le asserzioni sono sul **DOM reso**, non sui signal — in D l'unico difetto arrivato al browser è stato un signal corretto con un DOM che non lo seguiva.
- **`approval-modal.component.spec.ts`** (esistente): un caso con il candidato **due livelli sotto** il nodo filtrato, che deve comparire. La fixture indiretta è essenziale: una diretta passerebbe anche con il confronto esatto di oggi, cioè non proverebbe nulla.
- Gate completi: `ng test`, `ng lint`, `ng build`. **Nessuna migration e nessun cambio di schema**, quindi il run su Postgres fresco non è richiesto — va detto esplicitamente nel report anziché lasciato ambiguo.
- Verifica nel browser: entrambe le viste di `/utilization` con un attore che gestisce un nodo, e una sostituzione da un dummy verso un candidato annidato.

---

## 6. Ciò che questa spec non fa

- Non tocca `scopeOf`, `dimensionsOf`, `scopedApproversOf` né `accountableApproversOf`: l'ambito è quello di D, invariato.
- Non applica l'ambito a `GET /resources`, che resta visibile a chi ha il ruolo (D §8).
- Non tocca il feed di approvazione né la decisione.
- Non risolve i follow-up noti di D (il lock protetto ma non testato, l'assenza di un controllo referenziale su `Resource.managerId`, l'unicità dei nomi a match esatto), che restano registrati.
- Non introduce l'ereditarietà delle rate card: blocco successivo, con report di impatto prima/dopo, perché muove importi già fatturabili.
