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

Due colonne su `assignmentMonths`:

```
replacedFromAssignmentMonthId  text (nullable)   -- riferimento SOFT, non FK
replacedDays                   jsonb (nullable)  -- mappa { 'YYYY-MM-DD': ore } di ciò che la sostituzione ha spostato
```

`replacedDays` è necessaria e non derivabile: all'approvazione bisogna restituire al dummy ciò che l'approvatore ha **tagliato**, ma l'approvatore può aver ridotto (o azzerato) le ore nel frattempo, quindi le cifre originali non sono più leggibili da nessuna parte. Senza questo campo la restituzione dovrebbe indovinare — e una restituzione sbagliata inventa o distrugge ore prenotate.

Ed è una **mappa per giorno, non un totale** — questa è la parte che costa se si sbaglia. Un totale unico obbligherebbe a spalmare la restituzione sui giorni che la persona *si trova* a tenere al momento della decisione, ma il mese di una persona mescola legittimamente ore trasferite e ore proprie: una sostituzione su un mese che già aveva ore lo **retrocede**, non lo sostituisce. Con un totale, un rifiuto su un mese misto toglie alla persona lavoro suo e lo accredita a giorni del dummy che non hanno mai ceduto un'ora — i totali del mese tornano, ogni cifra giornaliera è sbagliata. Con la mappa la restituzione è decisa giorno per giorno e il vincolo «mai più di quanto quel giorno aveva ceduto» è **strutturale**, non un controllo a parte. Le due colonne nascono e muoiono insieme.

`replacedFromAssignmentMonthId` è il mese del dummy da cui questo mese proviene. Serve a tre cose, tutte necessarie:
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

La **restituzione** vive nello stesso file, come funzione pura a sé — è aritmetica delicata e va provata senza database né lock:

```ts
planGiveBack(
  replacedDays: Readonly<Record<string, number>>,
  targetHeldByDate: Readonly<Record<string, number>>,
  decided: 'Approved' | 'Rejected',
  dummyBookedByDate: Readonly<Record<string, number>>,
  dummyDailyCap: number,
): { giveBack: Record<string, number>; targetHours: Record<string, number>;
     giveBackHours: number; shortfallHours: number }
```

Itera **solo i giorni presenti nella mappa** (gli altri non vengono mai sfiorati, ed è così che il lavoro proprio della persona è intoccabile per costruzione): rifiuto → `giveBack = replacedDays[g]`; approvazione → `giveBack = replacedDays[g] − min(replacedDays[g], oreTenute[g])`, cioè zero sui giorni in cui l'approvatore ha lasciato tutto. `giveBack` è poi limitato dal tetto giornaliero del dummy (`cap −` quanto la **risorsa** dummy tiene già quel giorno su **tutti** i suoi incarichi, la stessa aggregazione del gate di scrittura) e ciò che non entra finisce in `shortfallHours`, che il chiamante logga: nessuna ora si perde in silenzio, e la persona perde esattamente quanto il dummy riceve. `targetHours` è la nuova quantità sui giorni della persona (`0` = riga da cancellare) e resta **vuota sull'approvazione**, dove ciò che tiene *è* l'allocazione approvata.

Un cap non utilizzabile (0, NaN, negativo) restituisce **tutto**: l'inverso deliberato della convenzione di `planSubstitution`. Rifiutare di muovere ore verso una risorsa di cui non si conosce il limite è il lato sicuro quando si **prenota** lavoro nuovo; qui le ore erano già del dummy, e rifiutare distruggerebbe fabbisogno prenotato invece di evitare di crearne.

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

- **rifiutato** → per ogni giorno della mappa tornano al dummy esattamente le ore che ne erano uscite, e la riga della persona su quel giorno scende esattamente di altrettanto (`0` = cancellata). Un giorno che la sostituzione non ha toccato non viene sfiorato. Se l'approvatore aveva ridotto le ore e poi il mese viene rifiutato, il dummy torna comunque **intero**: quelle ore erano sue, e un rifiuto annulla la sostituzione per intero;
- **approvato** → giorno per giorno, `min(spostate, ancora presenti)` resta alla persona ed è definitivo; il resto di quel giorno torna al dummy. Sui giorni in cui l'approvatore ha lasciato tutto — o ha aggiunto ore proprie — non torna nulla: le ore in più sono un'allocazione nuova, non parte della sostituzione (§8). Se invece ha **azzerato** il mese e poi lo ha approvato — il modo in cui il tool di origine esprime un rifiuto — torna l'**intera** mappa: nessuna ora può svanire perché la persona non tiene più traccia di dove erano finite.

L'aritmetica è tutta in `planGiveBack` (§4); il ramo nell'hook fa solo l'I/O intorno.

In entrambi i casi `replacedFromAssignmentMonthId` e `replacedDays` vengono azzerati **in un `finally`**, quindi anche se il trasferimento fallisce a metà: un mese deciso che resta collegato sembra una sostituzione pendente, e una decisione successiva (o un retry) restituirebbe le stesse ore due volte. Se la riga del dummy nel frattempo non esiste più (incarico cancellato), la restituzione è un no-op registrato, non un errore: la decisione non deve fallire per questo.

**Gap noto:** la restituzione non produce una voce di audit propria. Come il trasferimento, muove righe-giorno attraverso il repository e non via HTTP, quindi il middleware di audit non la vede; a registro resta la transizione di stato del mese. Vale per entrambi i lati della sostituzione, non solo per la restituzione, e va colmato per entrambi insieme.

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

- **Layer puro**: capacità piena; capacità parziale; giorno già saturo che non assorbe nulla; dummy multi-FTE spalmato su più sostituzioni; mappe vuote. Per la restituzione (`planGiveBack`), dove sta l'aritmetica che costa: giorno misto ore proprie + ore trasferite; mese azzerato e poi approvato; taglio parziale; approvatore che aggiunge ore; decisione per giorno con un giorno tagliato e uno gonfiato; clamp sul tetto del dummy con `shortfallHours`; cap non utilizzabile.
- **Smoke**: sostituzione totale; sostituzione limitata dalla capacità (con le ore residue verificate sul dummy); rifiuto che restituisce tutto; approvazione ridotta che restituisce la differenza; **rifiuto di un mese misto su due giorni** (il lavoro proprio della persona sopravvive intatto e il giorno mai toccato del dummy non cambia); **azzeramento e approvazione** che restituisce l'intero trasferimento; «tutti i mesi rimanenti»; 400 su una riga che non è di un dummy; 400 su un target non interno; trasferimento a zero ore che risponde 200 con il motivo.
- **Componenti**: il pulsante compare solo sui dummy; la ricerca filtra ed è precompilata sull'organizzazione; il riepilogo mostra le stime.
- Gate finali come C1: build, unit, lint, smoke live in-memory **e** su Postgres fresco.

---

## 8. Rischi e questioni aperte

- **L'hook post-decisione di B3 è il punto più delicato del sistema** — vi convivono SoD, step enforcement e audit. Il ramo di restituzione va aggiunto senza toccare gli altri, con la stessa verifica che è servita in B3 (dove l'estrazione del nucleo decisionale fu controllata riga per riga).
- **Il doppio lock `res:` introduce una regola di ordinamento nuova** in `server.ts`: va documentata nel punto in cui si acquisisce e verificata contro ogni altro sito che prende `res:`, `req:`, `month:` o `approval:`.
- **Una sostituzione parziale lascia il dummy con ore sparse** su giorni diversi: è corretto, ma la UI deve renderlo leggibile, altrimenti chi opera non capisce quanto resta da coprire.
- **L'approvatore può modificare le ore** del mese subentrato prima di approvare: la differenza torna al dummy, **giorno per giorno** (§5.6). Se invece le **aumenta** oltre il trasferito, su quel giorno non viene sottratto nulla a nessuno — è un'allocazione nuova, non parte della sostituzione, e va trattata come tale. Il conto è per giorno e non sul totale del mese: un mese con un giorno tagliato e un altro gonfiato restituisce il taglio e lascia stare l'aggiunta, mentre sul totale i due si annullerebbero a vicenda e il dummy non rivedrebbe mai le sue ore.
- **Lezione di C1 da applicare qui**: prima di chiudere il blocco, fare il grep di ogni consumatore di `assignmentDays`/`assignmentMonths` e decidere superficie per superficie se la sostituzione lo tocca. In C1 quattro schermate hanno conservato il vecchio comportamento perché nessun task le possedeva.
