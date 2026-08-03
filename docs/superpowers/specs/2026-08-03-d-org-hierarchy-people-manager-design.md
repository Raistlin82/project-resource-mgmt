# Design — D: Gerarchia organizzativa + People Manager

- **Data:** 2026-08-03
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «D — Gerarchia organizzativa + People Manager» (gap #11, #12) della tassonomia autoritativa dei blocchi.
- **Fonte funzionale:** `Manuale utente RPT (ITA) v4.pdf`, §6 (Attività di supervisione dei Delivery Manager: Competence Manager, Practice Manager, Capability Leader), §3.2.3 (dummy per practice/livello/tariffa), §7.1 (filtri della dashboard di monitoraggio).

---

## 1. Contesto e obiettivo

Il manuale RPT descrive quattro profili gestionali in catena — **People Manager → Competence Manager → Practice Manager → Capability Leader** — e per ciascuno afferma la stessa cosa: ha «visibilità completa dei progetti in cui lavorano tutte le risorse gerarchicamente sottostanti **in organigramma, anche se in strutture organizzative differenti**» (§6.2, §6.3).

Quella frase contiene il fatto strutturale che governa tutta questa spec: **gli assi sono due e sono indipendenti.**

1. **L'organigramma** — la catena manageriale persona-per-persona. È l'asse della *visibilità*.
2. **La struttura organizzativa** — Capability > Practice > Competence. Il manuale la chiama esplicitamente così: «struttura organizzativa (practice, competence)» (§3.2.1). È l'asse dell'*appartenenza*, e in UI si presenta come **filtro** dentro l'ambito: «utilizzare i filtri Capability, Practice, Competence e People manager per circoscrivere la ricerca» (§7.1).

Il codice oggi ha metà del primo asse e una forma parziale del secondo:

- `resources.manager_id` esiste, è indicizzato ed è esposto nel form risorsa (fatto nel gap A) — ma **nessuno lo risale**. Nessuna funzione calcola «chi sta sotto di me».
- `resourceOrganizations {id, name, description, costCenters[], serviceOrganizationId}` esiste (fase F2) con un padre `serviceOrganizations`, e `Resource.organization` è vincolata a quel catalogo **per nome**, validata server-side (`validateResourceCatalogRefs`, `src/server.ts`). Ma è una gerarchia a due livelli il cui scopo è **finanziario**: porta i cost center e seleziona la rate card (`pickRateCard` fa match per nome dell'organizzazione).
- Capability, practice e competence **non esistono da nessuna parte** nel modello.

La conseguenza diretta di questo vuoto è un debito che abbiamo già incontrato e documentato nel gap A (§4.3) e ritrovato in B3 e C2: **l'approvazione dell'allocazione ha un fallback per ruolo.** `allocationApproverStep(managerId)` (`src/app/services/staffing.util.ts:78`) produce uno step mirato quando la risorsa ha un manager, e uno step **role-only** quando non lo ha — e la decisione accetta di conseguenza *qualsiasi* utente con ruolo `resource-manager`. Il feed `GET /allocation-approvals` non filtra affatto per ambito: restituisce ogni riga a chiunque abbia uno dei ruoli ammessi.

**Obiettivo di D:** dare alla gerarchia una struttura di dati, e usarla per instradare visibilità e decisione al manager competente invece che a chiunque abbia il ruolo giusto.

### 1.1 Perimetro (deciso con l'utente)

**Dentro:** l'albero organizzativo con la sua UI di customizing; il legame alla risorsa; l'ambito che governa visibilità e decisione; i filtri Capability/Practice/Competence nelle schermate dove oggi si cercano risorse, si staffa e si approva.

**Fuori, per scelta:** le dashboard dedicate per livello manageriale (§6.3.1, §6.3.2) restano al blocco **F**; la ricerca avanzata a faccette completa resta a **G**. Nessun ruolo RBAC nuovo (vedi §2.2).

---

## 2. Modello dati

### 2.1 Le tre colonne nuove

`resourceOrganizations` acquista:

| Colonna | Tipo | Semantica |
|---|---|---|
| `parent_id` | `text`, nullable, self-reference | Il nodo superiore nell'albero di delivery. `null` = radice. |
| `level` | `text`, notNull | `'capability' \| 'practice' \| 'competence'`. |
| `manager_id` | `text`, nullable | La risorsa che gestisce il nodo — soft reference, come `resources.manager_id`. |

Vincoli di livello, validati in scrittura:

- un nodo `capability` ha `parent_id` nullo;
- un nodo `practice` ha un padre di livello `capability`;
- un nodo `competence` ha un padre di livello `practice`;
- un nodo con figli non è cancellabile.

### 2.2 Il manager del nodo È il profilo del manuale

`manager_id` su un nodo `capability` **è** il Capability Leader di quella capability; su una `practice`, il Practice Manager; su una `competence`, il Competence Manager. Il livello del nodo dice già di che profilo si tratta, quindi **non introduciamo ruoli RBAC nuovi**: i sette ruoli restano quelli che sono, e `resource-manager` continua a essere il ruolo di chi gestisce persone. Cambia solo *quali* persone.

Questa è una scelta deliberata contro l'alternativa (tre ruoli RBAC nuovi): i ruoli in questo sistema sono globali e a precedenza fissa (`ROLE_PRIORITY`), mentre l'autorità di un manager è **relativa a un insieme di risorse**. Modellarla come ruolo l'avrebbe resa di nuovo piatta — esattamente il problema che D esiste per risolvere.

### 2.3 Due riferimenti verso l'alto, ortogonali

Dopo questa modifica una riga di `resourceOrganizations` ha due riferimenti verso l'alto, e la loro distinzione va scritta nel codice e nei doc perché è il punto in cui questo modello si può fraintendere:

- **`parent_id`** — gerarchia di **delivery**. Determina ambito dei manager, derivazione delle dimensioni e filtri.
- **`service_organization_id`** — appartenenza **finanziaria**. Determina cost center e rate card. Non partecipa all'albero, non si risale per l'ambito, resta esattamente com'è.

Il manuale conferma che sono indipendenti: la visibilità segue l'organigramma «anche se in strutture organizzative differenti».

### 2.4 Il legame risorsa resta per nome

`Resource.organization` continua a essere il **nome** del nodo, non un id.

Motivo: è già validato per nome, e `pickRateCard` (`src/server.ts`) risolve la rate card facendo match sul nome dell'organizzazione. Passare a un `organizationId` obbligherebbe a migrare anche le rate card, per un guadagno nullo — il nome è già la chiave di fatto in tutto il sistema.

Il prezzo, che accettiamo e imponiamo: **il nome è univoco in tutto l'albero**, non solo tra fratelli. Validato server-side sulle scritture e verificato nel customizing. Su un catalogo gestito da admin due nodi omonimi sarebbero comunque illeggibili in un filtro.

### 2.5 Una risorsa può puntare a qualsiasi livello

L'aggancio della risorsa non è obbligato a essere una foglia: `Resource.organization` può nominare un nodo `capability`, `practice` o `competence`, e le dimensioni superiori si **derivano risalendo `parent_id`** finché si può.

Due ragioni:

1. **La migrazione non inventa dati.** Le quattro righe esistenti (`Res Org Germany`, `Engineering`, `Consulting`, `Design`) sono puntate da risorse reali. Diventano radici di livello `capability`: l'albero è valido immediatamente, senza che noi inventiamo una gerarchia che non conosciamo. L'admin la ristruttura dal customizing quando la conosce.
2. **Il manuale fa lo stesso.** I dummy sono preconfigurati «per Practice, livello professionale e tariffa» (§3.2.3), quindi anche nel RPT l'aggancio non è sempre sulla foglia.

Le dimensioni derivate **non vengono mai denormalizzate sulla risorsa**: si calcolano a ogni lettura. Una risorsa non può quindi avere una practice incoerente con la propria competence — l'incoerenza è irrappresentabile.

---

## 3. L'ambito

### 3.1 Il layer puro

Nuovo file `src/app/services/org-scope.util.ts`, senza dipendenze, senza orologio, testabile in isolamento. L'ambito è una funzione dei dati:

```
scopeOf(managerResourceId, resources, orgs) =
      { risorse sotto managerResourceId nella chiusura transitiva di managerId }
    ∪ { risorse il cui nodo cade in un sottoalbero org di cui managerResourceId è manager }
```

Il calcolo gira in memoria sulle liste che gli handler già caricano: nessuna query nuova, nessun `withLock` (è sola lettura).

Il modulo esporta anche `dimensionsOf(resource, orgs)` → `{capability?, practice?, competence?}`, la derivazione risalendo l'albero, che alimenta i filtri di §4.

### 3.2 Due guardie non negoziabili

Entrambe le catene sono dati che un admin edita, quindi entrambe possono contenere un ciclo:

1. **In lettura:** ogni chiusura transitiva porta un `visited` set. **È il `visited` set a garantire la terminazione**, non il tetto: un nodo già visto non viene riesplorato, quindi anche una catena ciclica finisce. Il tetto (`MAX_CHAIN_DEPTH = 64`) è una seconda rete e un limite semantico dichiarato, non il meccanismo di sicurezza. Senza il `visited` set un ciclo manderebbe un handler in loop, cioè in stallo — e non è un caso teorico: `managerId` è un campo libero del form risorsa.
2. **In scrittura:** `PUT /resources` rifiuta un `managerId` che creerebbe un ciclo, e la scrittura di un nodo rifiuta un `parent_id` che creerebbe un ciclo. Entrambe con un 400 che dice quale catena si chiuderebbe.

### 3.3 Dove si applica

- **`decideOneApproval`** — il gate della decisione. Oggi accetta qualsiasi `resource-manager`; passa a richiedere che il decisore sia nell'ambito della risorsa oggetto dell'approvazione. La **SoD esistente resta sopra** e invariata: il decisore deve comunque essere diverso dal richiedente.
- **`GET /allocation-approvals`** — il feed. Oggi restituisce tutto; passa a restituire l'ambito dell'attore.

**`roleGate` non si tocca.** È prefix-based e non conosce le entità: non può sapere di *quale* risorsa parla una richiesta. L'ambito vive nei handler, accanto alla SoD, dove questa classe di logica già abita.

`admin` e `delivery-executive` restano onnivedenti: sono ruoli globali per definizione, e il feed dei livelli alti serve proprio a vedere tutto.

### 3.4 Il fallback per ruolo diventa l'ultima istanza, non la prima

Regola completa per «chi può decidere l'allocazione della risorsa R»:

1. i manager di R nella catena `managerId` (transitivamente); **oppure**
2. i manager dei nodi org che contengono R, risalendo `parent_id` dal nodo di R; **oppure**
3. **solo se** R non ha né manager in organigramma né alcun manager di nodo risalendo l'albero — qualunque utente con ruolo `resource-manager`, come oggi.

Il punto 3 è ciò che tiene in piedi i **dummy** senza casi speciali. Un dummy oggi non ha `managerId` (nel seed le righe `4`, `5`, `6` ne sono prive) ma ha una `organization`: appena il suo nodo — o un suo antenato — acquista un manager, lo step si fa mirato da sé, e nel frattempo nulla si blocca. Questo vale anche per le approvazioni che **C2** apre sui mesi placeholder riaperti dopo una restituzione, che oggi sono role-only per costruzione.

### 3.5 Breaking change dichiarato

**Chi oggi approva risorse che non gestisce smetterà di poterlo fare.** È il punto della feature, non un effetto collaterale.

Conseguenza operativa: gli smoke check che oggi approvano un'allocazione autenticandosi come un `resource-manager` arbitrario **vanno riscritti** perché documentano il fallback, non il requisito. Il lavoro è di riassegnare l'attore nel fixture, non di indebolire l'asserzione. Il caso nuovo da aggiungere è quello che oggi passerebbe e non deve: **un manager estraneo alla risorsa riceve 403**.

---

## 4. UI

### 4.1 Customizing

`src/app/configuration/manage-resource-organizations.component.ts` esiste già e gestisce il catalogo piatto. Acquista: il campo padre, il livello, il manager, e una **vista ad albero** al posto della lista piatta. La validazione dei vincoli di §2.1 e dell'unicità del nome è lato server; la UI la rispecchia per dare l'errore prima del roundtrip, senza diventare l'unico guardiano.

Due fatti del backend che il piano deve rispettare, entrambi già presenti nel codice:

- **Le tre colonne nuove vanno aggiunte all'allow-list `allowed` di `crud('resource-organizations', …)`.** `crud()` copia dal body solo i campi nominati (`pick()`, la guardia contro il mass assignment): un campo non elencato non è scrivibile e falirebbe in silenzio, senza errore.
- **I vincoli di §2.1 entrano nell'hook `validate` che `crud()` già espone** (`src/server.ts:643`), usato allo stesso modo dalle fasi D ed E per le regole di integrità che il controllo numerico generico non esprime. L'hook riceve il body già filtrato e, su `PUT`, l'id del record — ciò che serve per escludere se stesso dal controllo di unicità del nome. **Il handler resta quindi generico:** non serve trasformare questa collezione in un handler bespoke.

L'RBAC del customizing **non cambia**: le mutazioni su `/resource-organizations` restano ad `admin` e `delivery-executive` (`src/server.ts:529`), la lettura resta aperta agli attori verificati perché ogni schermata che mostra un'organizzazione ne ha bisogno.

`service-organization-details.component.ts` non cambia: `service_organization_id` resta quello che è.

### 4.2 I filtri

Capability, Practice e Competence entrano come filtri dove oggi si cercano e si scelgono persone:

- `src/app/resources/resources.component.ts` — la lista risorse;
- `src/app/staffing/staffing.component.ts` — la scelta di chi staffare;
- `src/app/allocation-approvals/allocation-approvals.component.ts` — il feed di approvazione.

Sono derivati con `dimensionsOf`, quindi coerenti per costruzione. Testo in **inglese**, come tutta la UI. Design system bespoke (`command-*` + token in `src/styles.css`), Material solo per le icone.

Il filtro per **People Manager** nominato dal §7.1 esiste già come concetto (`managerId` sulla risorsa) e viene esposto nella stessa passata, perché è lo stesso gesto per l'utente.

---

## 5. Migrazione e persistenza

Migration additiva in `drizzle/`, nello stile delle precedenti: tre colonne su `resource_organizations`, nessun backfill inventato. Le quattro righe esistenti diventano `level: 'capability'`, `parent_id: null`, `manager_id: null` — l'albero è valido dal primo boot.

`src/db/seed.ts` resta **la sola fonte di verità** dei dati seed, consumata sia dall'adapter in-memory sia dal seeder Postgres. Il seed acquista un esempio minimo di gerarchia a tre livelli con un manager assegnato, così la feature è visibile al primo avvio e l'ambito è esercitabile dallo smoke senza che il test si costruisca l'albero da zero.

Vale il seam dual-adapter di sempre: `nullsToUndefined()` su ogni ritorno e mai sui valori passati a `.set()`; `null` esplicito in una patch = «azzera», `undefined` = «non toccare». `parent_id` e `manager_id` sono nullable e quindi devono azzerarsi identicamente sui due adapter.

**L'ordine di seed va verificato su un database Postgres fresco.** Il blocco C1 ha spedito un server che non si avviava affatto per una FK che rompeva l'ordine di seed in `bootstrap.ts` — invisibile in-memory perché quell'adapter non applica FK, trovata solo da un run su DB vuoto. `parent_id` è una self-reference: le radici vanno inserite prima dei figli.

---

## 6. Errori e casi limite

| Caso | Comportamento |
|---|---|
| `parent_id` che chiude un ciclo | 400, con la catena che si chiuderebbe |
| `managerId` di risorsa che chiude un ciclo | 400, idem |
| `level` incoerente col livello del padre | 400 |
| Nome duplicato nell'albero | 400 |
| Cancellazione di un nodo con figli | 409 |
| Cancellazione di un nodo puntato da risorse | 409 (il catalogo è già protetto così altrove) |
| Risorsa che nomina un nodo inesistente | 400, dalla validazione catalogo già in essere |
| Ciclo già presente nei dati | La lettura non va in stallo: `visited` set e tetto di profondità, e l'ambito calcolato si ferma senza errore |
| Risorsa senza organizzazione e senza manager | Ricade nel fallback §3.4 punto 3 |

---

## 7. Verifica

- **Unit sull'util puro** (`org-scope.util.spec.ts`): chiusura transitiva su più livelli; unione dei due insiemi; un ciclo in organigramma e un ciclo nell'albero che non fanno stallare né esplodere; il tetto di profondità; `dimensionsOf` che deriva da un aggancio su ciascuno dei tre livelli; risorsa senza organizzazione.
- **Spec di componente** per i filtri e per la vista ad albero del customizing, con asserzioni sul **DOM reso**, non sui signal. Questa regola non è cosmetica: in C2 l'unico difetto arrivato al browser è stato un signal corretto con un DOM che non lo seguiva (`[value]` su una `<select>` popolata da un `@for`), e il test che lo copriva asseriva solo il signal.
- **Smoke live** (`scripts/smoke-api.mjs`): un manager decide nel proprio ambito e riesce; un manager estraneo riceve 403; il feed di un manager contiene solo il suo ambito; una risorsa senza gerarchia resta decidibile dal fallback; i cicli respinti con 400.
- **Gate completi** su entrambi gli adapter, con il run su **Postgres fresco** come gate ricorrente e non solo finale (§5).

---

## 8. Gap noti e non in scope

- **Le dashboard per livello manageriale** (§6.3.1, §6.3.2) non sono qui: sono di **F**.
- **La ricerca a faccette completa** (§8 del manuale, filtri su rate band, livello, job-role, skill, disponibilità) è di **G**. D aggiunge le tre dimensioni org e il people manager, non l'intero pannello.
- **Le deleghe e l'act-as** (§6 del manuale sul delegare temporaneamente il profilo) sono di **I**. D non introduce nessuna forma di impersonificazione: l'ambito è quello dell'attore verificato.
- **L'ambito non si applica alla lettura delle singole risorse** (`GET /resources`): resta visibile a chi ha il ruolo, come oggi. Restringerlo sarebbe un secondo breaking change su una superficie che quasi ogni schermata usa, e il manuale parla di visibilità sui *progetti in cui le risorse lavorano*, non sull'anagrafica. Se serve, è un blocco a sé.
- **Nessun audit dedicato ai cambi di gerarchia** oltre a quello che il middleware append-only già registra su `PUT`/`DELETE` delle due entità. Un `parent_id` che si sposta cambia l'ambito di un manager, e l'entry generica non lo dice — coerente con la lacuna già registrata in C2 sugli audit di dettaglio, e da affrontare insieme a quella.
