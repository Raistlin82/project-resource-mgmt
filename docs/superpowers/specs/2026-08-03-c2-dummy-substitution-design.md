# Design — C2: Sostituzione dummy → risorsa reale

- **Data:** 2026-08-03
- **Stato:** Design approvato (in attesa di spec review + review utente)
- **Gap di riferimento:** «C — Risorse DUMMY / SUBCO + Multi-FTE» della gap analysis RPT. C è decomposto in 2 fasi; **C1 è chiusa e mergiata**, questa spec copre **C2**.
- **Fonte funzionale:** `Manuale utente RPT (ITA) v4.pdf`, §4.2.1 (Come sostituire una risorsa Dummy) e §8.6.

---

## 1. Contesto e obiettivo

C1 ha introdotto i **dummy** — segnaposto per persone non ancora identificate, pianificabili oltre 1 FTE e tenuti fuori dai KPI interni. Restano fabbisogno finché qualcuno non li copre. C2 è il gesto che li copre.

In RPT (§4.2.1) il People Manager, dalla modale di approvazione del dummy, spunta la commessa e preme «Sostituisci»; cerca la persona fra quelle abilitate della sua organizzazione; conferma; le commesse del dummy compaiono **evidenziate** sul calendario della persona; e **la sostituzione si completa approvando il mese** su quella persona. Se la persona non copre tutto, «le ore che vengono decurtate restano da sostituire nel dummy con una eventuale risorsa aggiuntiva».

**Obiettivo:** trasferire le ore da un dummy a una persona reale, con il trasferimento reversibile fino alla decisione e la parte non coperta che resta sul dummy.

### Decisioni di requisito (approvate)

1. **Passaggio immediato e reversibile**: alla conferma le ore lasciano il dummy e arrivano alla persona come mese `Requested`; un rifiuto le restituisce. Nessun doppio conteggio fra fabbisogno e domanda in nessun istante.
2. **Grano: un mese, con l'opzione «tutti i mesi rimanenti»** della stessa commessa.
3. **Parzialità senza campi nuovi**: si trasferisce quanto la persona può assorbire; l'approvatore può ridurre ancora prima di approvare, e la differenza torna al dummy.
4. **Subentra solo personale interno**, con il filtro sull'organizzazione del dummy precompilato ma rimovibile.

### Fuori scope

- Ricerca avanzata per skill/capability/practice (blocco D): qui bastano nome, ruolo e organizzazione.
- Copertura del fabbisogno via fornitore e codice RES (blocco F): è un percorso diverso dal subentro di una persona.
- Sostituzione di un **subco** con un interno: il manuale non la prevede.

---

## 2. La semantica che regge il design

Un dummy può valere 2,5 FTE; una persona no — il gate di capacità giornaliera di B1 la ferma a 1 FTE. Il trasferimento quindi **non è uno spostamento in blocco**: è limitato a quanto la persona può assorbire giorno per giorno, considerando ciò che ha già prenotato altrove. Il resto **resta sul dummy**.

Questa non è una complicazione aggiunta: è la sostituzione parziale del manuale. Un dummy da 2,5 FTE coperto con Maria diventa Maria a 1 FTE in `Requested` e un dummy sceso a 1,5 FTE, che il People Manager copre con altre due persone finché il fabbisogno è chiuso. **La parzialità cade fuori dal vincolo di capacità**, senza chiedere quote a nessuno.

---

## 3. Modello dati

Nessuna tabella nuova. Il trasferimento agisce sulle strutture di B1/B3 (`assignmentDays`, `assignmentMonths`).

Una sola colonna su `assignmentMonths`:

```
replacedFromAssignmentMonthId  text (nullable) → assignmentMonths.id
```

Il mese del dummy da cui questo mese proviene. Serve a tre cose, tutte necessarie:
1. sapere **dove restituire** le ore quando la decisione arriva;
2. **evidenziare** nel calendario i mesi arrivati per subentro (§4.2.1: «con una leggera evidenziazione»);
3. generare la **nota automatica** che il manuale richiede.

Il campo è **nullable e transitorio**: viene scritto alla sostituzione e azzerato alla decisione, quando il legame ha esaurito la sua funzione. Un mese senza il campo è un mese normale.

---

## 4. Layer puro `substitution.util.ts`

Nuovo `src/app/services/substitution.util.ts` (SSR-safe, nessun orologio, nessun I/O), accanto a `calendar.util` / `capacity.util` / `allocation-month.util` / `resource-kind.util`. È il cuore aritmetico, isolato perché sia testabile senza database né lock:

```ts
planSubstitution(
  dummyHoursByDate: Readonly<Record<string, number>>,
  targetBookedByDate: Readonly<Record<string, number>>,
  targetDailyCap: number,
): { transfer: Record<string, number>; remaining: Record<string, number> }
```

Per ogni giorno: `transfer = min(oreDummy, max(0, cap − giàPrenotate))`, `remaining = oreDummy − transfer`. Un giorno con residuo zero non trasferisce nulla e resta intero sul dummy. Le voci a zero non compaiono nelle mappe restituite.

---

## 5. Logica server

### 5.1 Endpoint

**`POST /assignment-months/:id/substitute`** — `:id` è la riga mensile **del dummy** — con body `{ targetResourceId, applyToRemainingMonths?: boolean }`.

Rifiuta con **400**: se la riga non appartiene a una risorsa `kind='dummy'`; se il target non è `internal`, non esiste o è terminato; se il target coincide con il dummy. Rifiuta con **403** se il mese non è aperto (la sostituzione muove ore: vale il gate mese-aperto di B1). **404** se la riga mensile non esiste.

### 5.2 Il trasferimento di un mese

1. Raccogli le ore/giorno del dummy per quel mese e le ore già prenotate dal target su quei giorni, **su tutti i suoi incarichi**.
2. `planSubstitution(...)` con il tetto del target (`dailyCapFor('internal', base)`, quindi 1 FTE).
3. Trova l'incarico del target sulla **stessa richiesta**; crealo se non esiste (nasce `Draft`, senza stato client-settable: C1/B3 lo vietano).
4. Somma le ore trasferite ai giorni del target; sottraile ai giorni del dummy (una riga che va a zero si cancella, come già fa l'endpoint di allocazione).
5. Ricalcola `assignedHours` e lo stato derivato di **entrambi** gli incarichi.
6. La riga mensile del target diventa `Requested` con una nuova approvazione verso il suo manager, e porta `replacedFromAssignmentMonthId`. **Eccezione self-managed:** se chi sostituisce è il manager del target, il mese va direttamente `Allocated` (scorciatoia del gap A, già usata da B3) — e allora **il legame si chiude subito**, `replacedFromAssignmentMonthId` non viene scritto: non ci sarà nessuna decisione futura, quindi non c'è nulla da restituire e un legame lasciato aperto resterebbe tale per sempre.
   **Conseguenza da conoscere:** se il target ha già, su quella richiesta e in quel mese, ore in stato `Allocated`, aggiungerne altre lo retrocede a `Requested` — è la ri-approvazione forzata di B1/B3 sull'edit di un mese approvato, e vale anche qui. Il subentro rimette quindi in approvazione anche il lavoro che la persona aveva già confermato su quella commessa in quel mese. È corretto (l'approvatore deve vedere il profilo giornaliero risultante, non quello precedente), ma va detto nell'esito così chi opera non lo scopre dopo.
7. Se il trasferimento è **zero ore** (target saturo in ogni giorno), non si crea nulla: l'endpoint risponde 200 con `transferred: 0` e un motivo leggibile. Non è un errore: è l'informazione che serve un'altra persona.

### 5.3 Concorrenza

L'operazione tocca **due** risorse. I due lock `res:` si acquisiscono **in ordine lessicografico degli id**, mai «prima il dummy poi la persona»: due sostituzioni incrociate prenderebbero i lock in ordine opposto e si bloccherebbero a vicenda. L'I/O sulle approvazioni resta **fuori** da entrambi, come impone la disciplina già documentata nel file, e il recompute degli aggregati resta ultimo e best-effort.

### 5.4 «Tutti i mesi rimanenti»

Itera lo stesso trasferimento sui mesi successivi della **stessa commessa** che hanno ancora ore, ciascuno con la propria riga `Requested` e la propria approvazione — coerente con B3, dove si approva un mese per volta. La risposta riporta **un esito per mese**: ore trasferite e ore rimaste. Un mese chiuso o senza ore viene saltato con il suo motivo, senza interrompere gli altri.

### 5.5 Note automatiche

Sul mese del target una `plannerNote` generata: «Subentra a *<nome dummy>* — *<mese>*». Sul mese del dummy una nota che registra chi ha assorbito quante ore. **Scostamento motivato:** il manuale la chiama «nota approvatore», ma da noi `approverNote` appartiene alla decisione, mentre questa è una nota di chi propone — cioè esattamente ciò che l'approvatore deve leggere *prima* di decidere. Una nota già presente non viene sovrascritta: il testo generato le si aggiunge.

### 5.6 Il ritorno indietro, alla decisione

L'hook post-decisione di B3 guadagna **un ramo, senza toccare quelli esistenti**: se il mese deciso porta `replacedFromAssignmentMonthId`,

- **rifiutato** → tutte le ore tornano al dummy, il mese del target si azzera;
- **approvato** → torna al dummy solo la **differenza** fra le ore trasferite e quelle approvate (l'approvatore può averle ridotte); il resto è definitivo.

In entrambi i casi `replacedFromAssignmentMonthId` viene azzerato e l'audit registra la restituzione. Se la riga del dummy nel frattempo non esiste più (incarico cancellato), la restituzione è un no-op registrato, non un errore: la decisione non deve fallire per questo.

### 5.7 RBAC

La sostituzione è un'azione da approvatore: **`resource-manager`, `delivery-executive`, `admin`** — gli stessi che decidono le allocazioni, via una regola di mutazione sul prefisso `/assignment-months`.

---

## 6. Frontend

- **Modale di approvazione (B3)**: sulle righe di un dummy compare *Substitute*. Apre un pannello di ricerca sulle risorse **interne** non terminate, filtrabili per nome, ruolo e organizzazione, con l'organizzazione del dummy **precompilata e rimovibile**. Nessun endpoint nuovo: la lista risorse esiste già, il filtro è lato client.
- **Riepilogo prima di confermare**: chi subentra, su quale commessa e mese, **quante ore verranno assorbite e quante resteranno**, più la casella «apply to all remaining months».
- **Esito**: per ogni mese, ore trasferite e ore rimaste — così si vede subito se serve una seconda persona.
- **Calendario**: i mesi con `replacedFromAssignmentMonthId` sono evidenziati e nominano il dummy di provenienza, finché la decisione non chiude il legame.
- Pattern obbligati: standalone + `OnPush`, signal-first, control flow nativo, `rxResource` keyed su `auth.authReady()`, design system `command-*` con token `-text`, Material solo per le icone. **Copy in inglese.**

---

## 7. Testing

- **Layer puro**: capacità piena; capacità parziale; giorno già saturo che non assorbe nulla; dummy multi-FTE spalmato su più sostituzioni; mappe vuote.
- **Smoke**: sostituzione totale; sostituzione limitata dalla capacità (con le ore residue verificate sul dummy); rifiuto che restituisce tutto; approvazione ridotta che restituisce la differenza; «tutti i mesi rimanenti»; 400 su una riga che non è di un dummy; 400 su un target non interno; trasferimento a zero ore che risponde 200 con il motivo.
- **Componenti**: il pulsante compare solo sui dummy; la ricerca filtra ed è precompilata sull'organizzazione; il riepilogo mostra le stime.
- Gate finali come C1: build, unit, lint, smoke live in-memory **e** su Postgres fresco.

---

## 8. Rischi e questioni aperte

- **L'hook post-decisione di B3 è il punto più delicato del sistema** — vi convivono SoD, step enforcement e audit. Il ramo di restituzione va aggiunto senza toccare gli altri, con la stessa verifica che è servita in B3 (dove l'estrazione del nucleo decisionale fu controllata riga per riga).
- **Il doppio lock `res:` introduce una regola di ordinamento nuova** in `server.ts`: va documentata nel punto in cui si acquisisce e verificata contro ogni altro sito che prende `res:`, `req:`, `month:` o `approval:`.
- **Una sostituzione parziale lascia il dummy con ore sparse** su giorni diversi: è corretto, ma la UI deve renderlo leggibile, altrimenti chi opera non capisce quanto resta da coprire.
- **L'approvatore può modificare le ore** del mese subentrato prima di approvare: la differenza torna al dummy (§5.6). Se invece le **aumenta** oltre il trasferito, la differenza non viene sottratta a nessuno — è una allocazione nuova, non parte della sostituzione, e va trattata come tale.
- **Lezione di C1 da applicare qui**: prima di chiudere il blocco, fare il grep di ogni consumatore di `assignmentDays`/`assignmentMonths` e decidere superficie per superficie se la sostituzione lo tocca. In C1 quattro schermate hanno conservato il vecchio comportamento perché nessun task le possedeva.
