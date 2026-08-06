# Lutech RPT vs Delivery Control — comparativa side by side

_Fonte lato RPT: **Manuale Utente Resource Planning Tool (RPT), v04 del 07/07/2026**, 49 pagine, letto integralmente._
_Fonte lato nostro: **il codice su `main`**, verificato riga per riga il 2026-08-06 — 45 tabelle, 19 migrazioni, 48 rotte, 1852 test unitari, 710 check smoke API. Non la roadmap, non la memoria di sessione (che su due punti si è rivelata già superata)._

---

## 1. Le due cose non hanno lo stesso perimetro

Prima di confrontare: **RPT è un modulo, Delivery Control è una catena.**

RPT dichiara il proprio perimetro a pag. 4: gestire la pianificazione delle risorse, anticipare la domanda di hiring, ottimizzare l'allocazione. Le commesse **le legge** da PCP/InforLN; l'anagrafica e l'organigramma **li legge** da Zucchetti; le skill **le legge** da People Portal; le richieste di hiring **le apre** su ServiceNow. Non ha clienti, contratti, ordini, fatture, ricavi, consuntivi.

Delivery Control copre l'intera catena in un solo processo: commerciale → delivery → consuntivi → fatturazione → ricavi → reporting, con motore di approvazione e audit trail.

Quindi la domanda "chi è meglio" ha **tre risposte diverse** a seconda di cosa si chiede. Sono in §5.

---

## 2. Vocabolario di copertura

| Tag | Significato |
|---|---|
| **PARI** | facciamo la stessa cosa, con la stessa granularità |
| **AVANTI** | la facciamo, e in modo più rigoroso o più completo — con il perché indicato |
| **PARZIALE** | il dato o il motore esiste, manca la superficie o la granularità |
| **MANCA** | assente, senza workaround |
| **SOLO DC** | RPT non ha nulla di equivalente |

---

## 3. La matrice, area per area

### 3.1 Accesso, ruoli, visibilità (manuale §1.2, §2, §6, §9)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 1 | SSO su VPN Forticlient | Keycloak OIDC (Authorization Code + PKCE); ogni bearer verificato via JWKS a ogni chiamata | PARI |
| 2 | Lingua UI **IT / English (UK)** commutabile a runtime (§2.1) | solo inglese; nessun i18n runtime (`config/language` è il default *dato*, non la lingua dell'interfaccia) | **MANCA** |
| 3 | 9 profili: PM, CDE, EM, People Manager, Competence Mgr, Practice Mgr, Capability Leader, Delivery Excellence, Monitoring/WFM | 7 ruoli: `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `sales`, `admin`. CDE/EM/Competence/Practice/Capability collassano in `resource-manager` + `delivery-executive` | PARZIALE |
| 4 | visibilità gerarchica: Practice/Capability vedono i progetti di tutte le risorse sottostanti *anche su strutture organizzative diverse* (§6.2, §6.3) | albero `resource_organizations` + People Manager (blocco D) e picker di ambito org | PARI |
| 5 | enforcement dei permessi | `roleGate` server-side: `READ_RULES` + regole di mutazione per collezione, il ruolo del JWT vince sempre, header `X-User-*` accettati solo con `AUTH_TRUST_HEADERS=true` | **AVANTI** — il manuale non descrive alcun controllo lato server: la separazione documentata è solo funzionale |
| 6 | Segregation of Duties | approvatore ≠ richiedente/owner imposto negli handler su campi *server-pinned*; catena a due firme sopra 50.000 € | **AVANTI** — in RPT Competence, Practice e Capability possono **sia pianificare sia gestire le allocazioni** (§6.1–6.3): nulla di documentato impedisce loro di approvare la propria proposta |
| 7 | **Deleghe** (§9): delega temporanea del ruolo PM o People Manager, con intervallo date, ambito allocazione e/o pianificazione, divieto di sovrapposizione temporale, auto-creazione dell'utenza del delegato, revoca, "act-as" con Ripristina utenza | assente | **MANCA** |

### 3.2 Pianificazione — il lavoro del PM (manuale §3)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 8 | flusso: Cliente → Commessa → dettaglio commessa → Continua / "Modifica Pianificazione Esistente" | Progetto (→ contratto → cliente) → Request → Assignment. Nessuna singola "griglia di pianificazione per commessa" | PARZIALE |
| 9 | griglia risorse della commessa: stato per riga, SCR, tot costo/ore pianificate, colonne mese pianificato+costi | gli stessi dati esistono ma distribuiti su `project-details`, `/schedule`, `/capacity` | PARZIALE |
| 10 | inserimento per **Codice ID digitabile** (`COGNOM` + `NOM` + `00000` + progressivo, es. `ROMSAL000002`) | id UUID v4 con prefissi `TE`/`AL`/`AR`/`OB`: nessuno digita un UUID | **MANCA** — convenzione diversa, ma operativamente peggiore per un pianificatore |
| 11 | **Ricerca Avanzata a 13 faccette**: cod. risorsa, nome, cognome, anagrafica (INTERNAL/DUMMY/SUBCO), capability, practice, competence, people manager, tariffa, livello professionale, skill matrix, skill capability, job role (+ società per i subco) | `/staffing`: testo libero + **4 faccette** (capability, practice, competence, people manager) | PARZIALE |
| 12 | card candidato con anagrafica, costi, skill, capability/practice/competence, people manager, ore contratto, tariffa, livello | card con skill, ruolo, org **+ punteggio di match 0–100 pesato con breakdown per dimensione e rilevazione dello skill-gap** (`match.util.ts`) | **AVANTI** sul ranking — RPT filtra, non ordina per idoneità. I campi della card restano meno ricchi dei loro |
| 13 | semaforo **"Disponibilità futura" a 6 pallini** sulla card (verde BENCH / giallo PARZIALE / rosso ALLOCATO) | il rollup a 6 mesi BENCH/PARTIAL/ALLOCATED esiste ed è identico — ma vive su `/bench`, **non sulla card di staffing** | PARZIALE — dato giusto, posto sbagliato |
| 14 | tasti rapidi Allocazione 100% / 50% / Azzera / Rimuovi risorsa | `allocation-calendar`: 100% / 50% / Clear + rimozione | PARI |
| 15 | **Dettaglio Calendario** (§3.3): pianificazione giorno per giorno con spinner ore, riga "Capacità max giornaliera", riga TOTALI | `assignment_days` + `PUT /assignments/:id/allocation` con mappa giorno→ore, cap giornaliero *kind-aware*, marker di sforamento con **testo + icona oltre al colore** | **AVANTI** — il loro semaforo è solo colore; il nostro rispetta WCAG 1.4.1 |
| 16 | semaforo "ore caricate": verde a target, giallo sotto-allocato, rosso sovra-allocato | stato per-mese BENCH/PARTIAL/ALLOCATED + marker `over` per giorno + semaforo in `/capacity` | PARI |
| 17 | **"Mesi aperti"** gestiti da calendario centralizzato; solo Admin apre un nuovo mese (§3.6) | `planning_periods` Open/Closed, con enforcement server-side su ogni scrittura di allocazione | PARI |
| 18 | Salva in bozza / Manda in approvazione, per riga e per mese | `assignment_months.status`: Draft → Requested → Allocated, **più `Rejected` esplicito** | **AVANTI** — vedi riga 41 |
| 19 | cancellazione risorsa solo per i nuovi inserimenti mai salvati; altrimenti solo azzeramento | guardie di delete su request/assignment; azzeramento via Clear | PARI |
| 20 | **Multi-FTE 1,5 → 30 FTE solo per Dummy/Subco**; se la selezione include un interno il sistema blocca a 1 FTE per risorsa | `MULTI_FTE_MAX = 30`, `dailyCapFor` *kind-aware*, interni bloccati a 1 FTE | PARI — identico, tetto di 30 incluso |
| 21 | Campo Note del pianificatore per (risorsa, commessa, mese), salvabile solo dopo la bozza | `assignment_months.planner_note` e `approver_note`, editabili nel calendario | PARI (la notifica all'approvatore è riga 43) |
| 22 | **Dettaglio Storico** per riga: tutte le modifiche alla pianificazione di quella risorsa (§3.4) | audit trail append-only **più ricco** (attore, ruolo, metodo, path, diff before/after per chiave, incluse le master data che muovono denaro) — ma **nessuna schermata lo legge**: `/audit-logs` non ha una rotta Angular | PARZIALE — dato migliore, finestra assente |
| 23 | **"Visualizza PCP"**: Totale Costi PCP / Totale Costi Pianificato / Delta € / Delta % per mese | `costBaselineComparison`: baseline **congelata** (`cost_baselines`, con `frozenAt`/`frozenBy`) contro piano live, delta e delta% per mese, più flag `outOfBaselineHorizon` per i mesi mai congelati | **AVANTI** — RPT confronta con un PCP letto live; noi con una baseline congelata e attribuita, quindi contestabile a posteriori |
| 24 | Report PM → **.xlsx**, un foglio "Pianificazione" | export CSV/JSON (protetto contro formula injection, SSR-safe) | **MANCA** — nessun XLSX |

### 3.3 Dummy, Subco, domanda di hiring (manuale §3.2.3–3.2.5, §4.2, §7.3, §8.4, §8.6)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 25 | catalogo Dummy precaricato per practice / tariffa giornaliera / livello professionale | `kind: 'dummy'`, dummy seedati esattamente su quello schema | PARI |
| 26 | wizard **Crea risorsa Dummy** (ruolo principale, data fine validità, tariffa giornaliera, nome, cognome, email, sede, capability, practice, competence, people manager) + codice automatico + riepilogo di conferma | creazione via `/resources` (admin / resource-manager); nessun wizard dedicato con quel set di campi | PARZIALE |
| 27 | catalogo Subco precaricato; **per un nuovo fornitore bisogna scrivere a `rpt.wfm@lutech.it`** | `kind: 'subco'` + `vendor_id` → tabella `vendors` + schermata `config/vendors` in self-service | **AVANTI** |
| 28 | wizard **Crea risorsa Subco** (seniority, data fine validità, tariffa, società, skill matrix max 3, job role max 3, …), solo per Monitoring / Delivery Excellence | via `/resources`; nessun wizard dedicato | PARZIALE |
| 29 | **ServiceNow Requester Portal**: dal dummy si apre la demand di hiring/subco e si inserisce il **codice RES**; il codice del dummy viene riscritto includendo la RES (`RES0005555 - ZZ - Dummy - SAP - Associate PMO`) e il dummy passa da generico a specifico | assente | **MANCA** |
| 30 | **sostituzione Dummy → risorsa reale** (§4.2.1): modale di approvazione, check sulla commessa, "Sostituisci", Ricerca Avanzata limitata alle risorse su cui si è abilitati, popup di conferma, commessa importata evidenziata, "Approva mese" chiude; le ore decurtate **restano sul dummy** per un'ulteriore risorsa; nota approvatore automatica | `substitution-write.util.ts`: `replaced_days` **e `replaced_baseline_days`** (ciò che la persona già aveva su quelle date, su quell'assignment, immediatamente prima del trasferimento) + `planGiveBack` con compensazione inversa e gestione del caso `demotedExistingWork` | **AVANTI** — senza la mappa di baseline il give-back distrugge silenziosamente ore già prenotate dalla persona su una data che ne porta entrambe. Il manuale non descrive nulla su questo caso |
| 31 | **Futura domanda Hiring/Subco** (§7.3): istogramma per technical skill **e industry knowledge**, torta del totale, lista di dummy generici e RES-specifici con Resource Code, Skill, Practice, Seniority, Hire Date | `HiringDemandRow { month, role, hours }` dentro `/bench/monthly` | PARZIALE — aggregato per ruolo e mese, non per skill/industry; senza seniority, hire date, RES |

### 3.4 Allocazione e approvazione — il lavoro del People Manager (manuale §4)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 32 | "Riepilogo Costi": costo risorse interne totale del mese, numero risorse del team, costo medio, costi per mese | rollup costi in `/reporting` e `/capacity/monthly` | PARI |
| 33 | filtro date da 1 a 12 mesi, default centralizzato, limite all'ultimo mese aperto | `/capacity/monthly` con range; `/bench/monthly` con finestra a 6 mesi fissata lato server | PARI |
| 34 | filtro organizzativo practice / competence / people manager, con valorizzazione in base al profilo | picker di ambito org (blocco D + coerenza ambito UI) | PARI |
| 35 | istogramma: numero risorse per allocazione (completa/parziale/assente) e per tipologia (dummy/subco), per mese e per cliente | `/capacity` + `/bench` | PARI |
| 36 | torta a **5 bucket** (allocate 100%, parziali, bench senza commessa, dummy, subco) con costi, ore, **giorni** e **FTE equivalente** per bucket | `/capacity/monthly` dà l'FTE, `/bench/monthly` i 3 stati; dummy e subco esclusi dai KPI interni **come nel manuale** (`countsTowardInternalCapacity`) | PARZIALE — i 5 bucket con costi+ore+giorni+FTE non convivono in un'unica vista |
| 37 | tabella: colonne fisse che contano **solo ALLOCATO**, colonne mese dinamiche che contano **ALLOCATO + RICHIESTO**, formato `88 hh / 176 hh`, pallino verde / triangolo rosso sopra / triangolo arancione sotto | `utilization` vs `utilizationPlanned` e `staffedEffort` vs `staffedEffortPlanned` separano già confermato da pendente; semafori in `/capacity` e `/bench` | PARI |
| 38 | riga espandibile: dettaglio commesse 1..n, anagrafica risorsa e sua organizzazione, delta in testata | `project-details` e `/utilization` per risorsa | PARI |
| 39 | approvazione per mese: modale calendario multi-commessa, check per commessa, "Approva Mese", da ripetere per ogni mese | `/allocation-approvals`, decisione per coppia (assignment, mese) | PARI |
| 40 | **Allocazione multipla** (§4.2): N risorse in un'unica schermata, "Approva e Prosegui" **avanza automaticamente al mese successivo tenendo la finestra aperta** | modalità multi-risorsa con "Approve selected" — **senza auto-avanzamento al mese successivo** | PARZIALE |
| 41 | rifiutare = "Azzera Allocazione" e poi approvare (workaround che il manuale documenta come procedura) | stato `Rejected` esplicito + nota dell'approvatore | **AVANTI** — un rifiuto è un rifiuto, non un'approvazione di zero ore |
| 42 | Note Pianificatore / Note Approvatore; il pulsante note diventa rosso quando ci sono note | `planner_note` / `approver_note` nel calendario | PARI |
| 43 | **notifica email** ai responsabili alla creazione di dummy, subco e commessa Basket; la nota notifica l'approvatore | nessun canale email; solo toast in-app | **MANCA** |
| 44 | Report People Manager → **.xlsx a 2 fogli**: "Allocazione - Dettaglio" (per risorsa e per commessa) e "Allocazione - Testata" (per risorsa, commessa-agnostico) | CSV/JSON | **MANCA** |

### 3.5 Unchargeable / bench (manuale §7, §8)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 45 | **4 categorie**: A disallocato dal mese successivo, B da meno di 1 mese, C tra 1 e 2 mesi, D da oltre 2 mesi | `freeingUpNextMonth` (= A) + `bucketForMonthsIdle` B(≤1) / C(2) / D(≥3), mutuamente esclusive **per costruzione** | PARI — coincidono esattamente |
| 46 | Riepilogo Unchargeable: costo totale, costo mensile, numero risorse; per mese di riferimento costo totale, costo mensile medio, conteggio | rollup costi bench in `/bench` e `/reporting` | PARI |
| 47 | filtri Capability / Practice / Competence / People Manager; torta cliccabile che filtra la tabella | filtri e stato per mese in `/bench` | PARI |
| 48 | colonna Skill con hover sulle **3 skill a proficiency più alta, estratte da MIO CV in People Portal** | `resources.skills` con livelli + catalogo skill + proficiency set — dato interno, non da People Portal | PARZIALE |
| 49 | **Data Disponibilità** (mese-anno) da cui la risorsa è libera | `AvailabilityDate` con variante esplicita `beyond-horizon` | **AVANTI** — dichiara "oltre l'orizzonte" invece di produrre una data che non sa |
| 50 | **Percentuale Disallocazione mese corrente**: 25% / 50% / 75% / 100% | `BenchCell` ha 3 stati (BENCH/PARTIAL/ALLOCATED) e **nessuna percentuale** | **MANCA** |
| 51 | storico disallocazione per mese, per risorsa (`2025-03 · disallocato 21 gg · 100%`) | assente come vista storica per risorsa | **MANCA** |
| 52 | costo giornaliero standard e tariffa in tabella | `cost_rate` / `bill_rate` + rate card + **tariffe di vendita negoziate per progetto** + FX multi-valuta | **AVANTI** |
| 53 | Report Unchargeable → **.xlsx a 4 fogli, uno per categoria**, con struttura organizzativa, responsabili, codice risorsa, nominativo, job role, 3 technical skill con proficiency, standard cost rate, tariffa, disponibilità | CSV/JSON | **MANCA** |

### 3.6 Commesse BASKET — il non fatturabile (manuale §1.3, §8.5)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 54 | commessa **BASKET** per maternità e congedi parentali, ferie, AMS, gruppi tecnici, malattia, indisposizione; creata **solo in RPT**, non in PCP/InforLN; una per Practice; per SW Factory / AMS / GCC anche piani annuali su base storica | **nessun concetto di progetto non fatturabile né di assenza/ferie per risorsa**: `projects` non ha campo type/basket/billable, e non esiste una tabella di assenze | **MANCA** |
| 55 | wizard **Crea Nuova Commessa Basket** (codice, cliente preimpostato, descrizione, tipo preimpostato BASKET, validità, capability, practice, PM, CDE, EM) + notifica email ai ruoli indicati | assente | **MANCA** |

> **Questo è l'unico gap con una conseguenza numerica immediata.** Senza commesse BASKET, una persona in maternità o in ferie risulta BENCH: i nostri numeri di unchargeable **sovrastimano l'inattività**, e le categorie C e D si popolano di casi che non sono un problema di delivery. Il difetto non è "manca una feature": è che una metrica che già mostriamo è falsa in quei casi.

### 3.7 Integrazioni con i sistemi di record (manuale §1.1, §3.2.4, §7.1)

| # | RPT | Delivery Control | Stato |
|---|---|---|---|
| 56 | alimentato da **5 sistemi**: Zucchetti (anagrafica risorse + organizzazione aziendale), Skill Matrix, PCP forecast, Capability; commesse da PCP/InforLN; skill da People Portal; hiring su ServiceNow | seam a 4 adapter (GL, FatturaPA, CRM outbox, BI feed) dietro registry, che producono **artefatti locali**: `connected: false`, nessuna credenziale, nessun ack, nessun reverse-sync | **MANCA** |

### 3.8 Ciò che RPT non ha affatto

RPT legge le commesse: tutta la catena che le genera e le monetizza è fuori dal suo perimetro.

| # | Delivery Control | RPT |
|---|---|---|
| 57 | clienti → contratti → ordini → righe d'ordine | — |
| 58 | piano di fatturazione, numerazione fatture sequenziale sotto lock, generazione batch, fattura stampabile, tetto not-to-exceed con reject e flag di accrual, imposte e ritenute, XML FatturaPA | — |
| 59 | riconoscimento ricavi in stile ASC-606 (POC / lineare / as-incurred / deferred-advance) con giornale in partita doppia bilanciato in preview | — |
| 60 | AR aging e DSO, redditività cliente e concentrazione (HHI reale), drill-down del margine con alert di varianza, realization, revenue per FTE | — |
| 61 | multi-valuta: tabella FX con normalizzazione in ogni rollup finanziario | — |
| 62 | **timesheet** (`time_entries`) con approvazione — i **consuntivi**. RPT è solo piano | — |
| 63 | delivery di progetto: work package, milestone con approvazione, task, issue, partner, documenti, centri di costo, piani finanziari, change request con approvazione e regole di priorità | — |
| 64 | motore di approvazione multi-step con soglia a 50.000 € → delivery-executive → finance, ruolo verificato per step, SLA, decisioni race-safe sotto lock | — |
| 65 | audit trail append-only con diff before/after, incluse le master data che muovono denaro (FX, rate card, ore/giorno) | — |
| 66 | forecast rolling 8/12 settimane + **sandbox what-if** (win-deal / hire / slip-project) con delta affiancati | — |
| 67 | schedule drag-and-drop con rilevamento conflitti di sovra-allocazione **a livello di data** (sweep-line) | — |
| 68 | **16 schermate di master data in self-service** (skill, cataloghi, proficiency, ruoli progetto, centri di costo, org di servizio e di risorsa, sedi, industry, categorie di costo, ruoli partner, fornitori, rate card, disponibilità, integrazioni, lingua) | in RPT dummy e fornitori si aggiungono **scrivendo a `rpt.wfm@lutech.it`** |
| 69 | rate card + **tariffe di vendita negoziate** per progetto/ruolo | — |
| 70 | doppia persistenza (in-memory / Postgres+Drizzle) con parità garantita dagli stessi handler, 19 migrazioni forward, 1852 test unitari, 710 check smoke API | — |

---

## 4. "Copriamo tutto?" — No.

Su **56 capacità di RPT** valutate una per una contro il codice:

| Stato | Righe | Quota |
|---:|---:|---|
| **PARI** | 20 | 36% |
| **AVANTI** | 11 | 20% |
| **PARZIALE** | 12 | 21% |
| **MANCA** | 13 | 23% |

**31 su 56 (55%) coperte o superate. 12 parziali. 13 mancanti.** Più 14 aree che RPT non ha affatto.

I 13 gap, in chiaro:

| Gap | Peso |
|---|---|
| commesse **BASKET** / non fatturabile (+ assenze) | **bloccante** — rende falsa una metrica che già mostriamo |
| **deleghe** + act-as | **bloccante** — necessità operativa quotidiana (ferie, handover) |
| **integrazioni live** con Zucchetti / PCP / InforLN / People Portal / ServiceNow | **bloccante** — dipende da terzi, non solo da noi |
| ServiceNow hiring demand + linkage del codice RES sul dummy | alto |
| **XLSX** (3 report: pianificazione 1 foglio, allocazione 2 fogli, unchargeable 4 fogli) | alto — i pianificatori Lutech vivono in Excel |
| i18n **IT/EN** a runtime | alto |
| % di disallocazione del mese corrente | medio |
| storico mensile di disallocazione per risorsa | medio |
| notifiche email | medio |
| codici risorsa leggibili e digitabili | medio |
| schermata Storico sull'audit trail che **già abbiamo** | basso — è solo una vista |
| faccette di ricerca (4 → 13) e strip disponibilità 6 mesi sulla card di staffing | basso — il dato esiste già su `/bench` |
| auto-avanzamento al mese successivo nell'approvazione multipla | basso |

Dei 13, **due sono progetti veri** (modello BASKET/non fatturabile con le assenze; deleghe con act-as e provisioning), **uno dipende da terzi** (le 5 integrazioni), **dieci sono piccoli e ben delimitati** — e di questi, tre (Storico, strip disponibilità, faccette) sono superfici su dati che già abbiamo.

---

## 5. "Chi è meglio?" — Tre domande, tre risposte

### 5.1 Come sostituto di RPT, oggi: **RPT.**

Non per le meccaniche. Sulle meccaniche siamo pari o avanti, e non di poco:

- allocazione **giorno per giorno** con cap giornaliero kind-aware e sforamento segnalato anche senza colore;
- approvazione **per (risorsa, mese)** con Draft/Requested/Allocated **e un Rejected vero**, dove RPT rifiuta azzerando;
- **multi-FTE identico**, tetto di 30 FTE e blocco a 1 FTE per gli interni compresi;
- **sostituzione dummy più rigorosa della loro**, con la mappa di baseline per giorno che impedisce al give-back di distruggere ore già prenotate — un caso che il manuale non affronta;
- **aging del bench A/B/C/D coincidente**, con in più una data di disponibilità che sa dire "oltre l'orizzonte";
- **baseline PCP congelata e attribuita** invece di un confronto con un PCP letto live;
- **SoD e RBAC verificati lato server** su ogni scrittura, dove il manuale non documenta alcun controllo — e dove i profili Practice/Capability possono per disegno sia proporre sia approvare;
- **ranking dei candidati 0–100** con breakdown, dove RPT filtra e non ordina.

RPT vince per i 13 buchi, di cui tre bloccanti: BASKET, deleghe, e il fatto di essere **alimentato dai sistemi di record**. È questo l'argomento decisivo: RPT è cablato in Zucchetti, PCP, InforLN, People Portal e ServiceNow. Noi abbiamo quattro adapter che scrivono file locali e dichiarano `connected: false`. Un tool di pianificazione che non legge l'organigramma vero e le commesse vere non sostituisce niente, per quanto buono sia il suo motore.

### 5.2 Come prodotto, in assoluto: **Delivery Control.**

RPT è un modulo di una catena i cui altri anelli stanno altrove. Non ha clienti, contratti, ordini, fatture, riconoscimento ricavi, consuntivi, timesheet, motore di approvazione con soglie, audit trail. Noi copriamo la catena intera in un solo processo.

Contare le feature per decidere non ha senso: **non sono lo stesso prodotto.** RPT sostituito da Delivery Control sarebbe un downgrade su 13 punti; PCP + InforLN + Zucchetti + RPT sostituiti da Delivery Control sarebbe un consolidamento di quattro sistemi in uno.

### 5.3 Per qualità di esecuzione: **pari, con vantaggi opposti.**

RPT vince sull'**ergonomia del pianificatore**: 13 faccette con la disponibilità dentro la card di ricerca, codici digitabili, XLSX multi-foglio, IT/EN, Storico visibile per riga, email, auto-avanzamento nell'approvazione. Sono tutte scelte di chi ha visto un pianificatore lavorare.

Noi vinciamo sul **rigore**: ogni scrittura passa da RBAC + SoD + audit; la parità dev/prod è garantita dagli stessi handler su due adapter e verificata da 1852 test e 710 check; i semafori rispettano WCAG 1.4.1; la sostituzione non può corrompere ore prenotate; la baseline è congelata e attribuita.

---

## 6. Se l'obiettivo è sostituire RPT, l'ordine è questo

1. **BASKET / non fatturabile + assenze.** Unico gap che rende falso un numero già a schermo.
2. **Deleghe + act-as.** Necessità quotidiana; tocca l'autenticazione, quindi va progettato prima e non dopo.
3. **XLSX multi-foglio** per i tre report. Piccolo, molto visibile.
4. **Faccette (4 → 13) + strip disponibilità 6 mesi sulla card di staffing.** Il dato esiste già.
5. **i18n IT/EN.**
6. **Schermata Storico** sull'audit trail esistente.
7. **% disallocazione + storico mensile per risorsa.**
8. **Integrazioni live.** Dipende da terzi: va aperto per tempo, non per ultimo.

---

## 7. Limiti dichiarati di questa comparativa

- Lato RPT: **solo il manuale utente v04**. Non ho visto il prodotto, il suo modello dati, né il suo comportamento server-side. Dove scrivo "il manuale non documenta X" significa esattamente quello, non "RPT non fa X". I confronti su SoD, enforcement dei permessi e give-back della sostituzione sono quindi affermazioni su **ciò che è documentato**, non sul codice di RPT.
- Lato nostro: verificato sul codice, non su Postgres. In questa sessione `DATABASE_URL` non è mai stato valorizzato, quindi le affermazioni sul comportamento con Postgres derivano dagli stessi handler e dagli shim di parità, non da un'esecuzione.
- Le percentuali di §4 dipendono da come le righe sono state tagliate. Una riga per capacità funzionale del manuale è una scelta difendibile ma non l'unica: il conteggio va letto come ordine di grandezza, non come misura.
