# UX/UI defect remediation — lista fornita dall'utente (2026-08-04)

Fonte: lista dell'utente, autorevole. 75 issue: 6 P0, 30 P1, 35 P2, 4 P3.
Lavoro parziale già svolto (non committato) nel worktree `project-resource-mgmt-ui-remediation`.

## P0 — Release blocker

| ID | Difetto e impatto | Ipotesi di soluzione | File |
|---|---|---|---|
| P0-01 | Submit dell'Allocation Calendar ignora le modifiche visibili non salvate e invia i valori precedenti | Rendere atomico save-then-submit, oppure disabilitare Submit finché il mese è dirty spiegandone il motivo | `allocation-calendar.component.ts` |
| P0-02 | Submit del time entry crea sempre una bozza: il client invia `Submitted`, il server elimina il campo e forza `Draft`; la pagina non esegue la transizione | Endpoint atomico create-and-submit, oppure creazione Draft + PUT Draft→Submitted, con test end-to-end | client, `server.ts` |
| P0-03 | Client e server risolvono diversamente l'identità JWT: `john` diventa resource `2` nel client ma resta `john` sul server → 403 nelle approvazioni e SoD errata; username sconosciuti ricadono su resource `1` | Directory persistente e univoca OIDC subject/username → resourceId, condivisa client/server, **senza fallback sull'identità di un'altra persona** | `auth.service.ts`, `server.ts`, `seed.ts` |
| P0-04 | La Dashboard predefinita usa un `forkJoin` di dati staffing + commerciali + finanziari: solo finance/delivery-executive/admin soddisfano l'intersezione RBAC; employee, PM, RM e sales atterrano sull'errore | Dashboard per ruolo, chiamate condizionate alle capability, oppure endpoint aggregato che restituisce solo i dati autorizzati | `dashboard.component.ts`, `READ_RULES` |
| P0-05 | Self-service employee bloccato: profilo e incarichi richiedono `/resources`, `/assignments`, `/requests` che l'employee non può leggere o aggiornare | Endpoint self-scoped per profilo, incarichi e time entry; whitelist dei soli campi modificabili dal proprietario | `my-profile`, `my-assignments`, RBAC |
| P0-06 | Generazione fatture/ordini non atomica: prima l'ordine fatturato, poi l'update del billing item o la creazione della linea. Un errore intermedio lascia record orfani; un retry può duplicarli | Endpoint server transazionale e idempotente, con chiave stabile per billing item/operazione | `billing.ts`, `orders.ts` |

## P1 — Priorità alta

| ID | Difetto | Soluzione | File |
|---|---|---|---|
| P1-01 | Sweep route raggiunge il limite 300 req/min: SSR interno e hydration nello stesso bucket loopback → 429, errori resource, redirect incoerenti | Bucket separato o bypass firmato per SSR interno; cache API; `Retry-After`, backoff, stato UI per 429 | rate limiter |
| P1-02 | `ListStateComponent` non protegge dai veri errori `rxResource`: i binding proiettati sono valutati anche quando l'errore dovrebbe nasconderli → `ResourceValueError` prima del pannello Retry | Gating nel parent o `TemplateRef`/`ngTemplateOutlet` istanziato solo in stato resolved; test con rxResource realmente fallita | `list-state.component.ts` |
| P1-03 | Stati asincroni incompleti: 45/46 route usano rxResource, 35 senza branch error, 32 senza loading → errori diventano liste vuote, KPI zero, eccezioni | Matrice uniforme auth → loading → error/retry → empty → content per ogni route e dipendenza | Contracts, Forecast, Locations, … |
| P1-04 | Allocation Approvals conserva selezioni non più visibili dopo un filtro; il batch agisce su tutto il feed → si approva ciò che non si vede | Intersecare la selezione con gli id visibili, o mostrare e confermare il numero di righe nascoste | `allocation-approvals.component.ts` |
| P1-05 | Chiudere l'Allocation Calendar con X/footer/Escape perde le modifiche locali senza avviso | Dirty tracking + dialog Discard/Save/Continue editing | `allocation-calendar.component.ts` |
| P1-06 | La shell carica sempre requests e resources per i badge: employee e sales ricevono 403 e toast anche su pagine valide | Badge per capability o endpoint aggregato autorizzato | `app.ts` |
| P1-07 | Create/Edit/Delete mostrati a ruoli read-only; il server rifiuta. Il PM carica `/contracts` che non può leggere | Matrice capability unica condivisa da route, menu, CTA e caricamento dipendenze | `projects.ts`, route map, RBAC |
| P1-08 | Forecast e What-if raggiungibili da employee/sales ma richiedono feed vietati; il 403 diventa "nessun dato" | Guard coerente col backend e stato Access denied distinto dall'empty | `forecast.ts`, `what-if.ts` |
| P1-09 | Reporting è funzione PM/RM ma il load fail-fast include dati commerciali e finanziari vietati a quei ruoli | Dataset separati per capability o endpoint portfolio che proietta solo dati autorizzati | `reporting.ts` |
| P1-10 | Project 360, Contract Details e Billing mostrano KPI finanziari parziali come completi: dipendenze vuote/403 diventano zeri o somme FX incomplete | Richiedere resolved su tutte le dipendenze e mostrare "dati limitati", o aggregati server autorizzati | `project-details.ts`, `contract-details.ts`, `billing.ts` |
| P1-11 | Sales non può configurare le tariffe negoziate: le select dei ruoli derivano da `/resources` (vietato a sales) e omettono ruoli catalogati non assegnati | Usare `/project-roles`, coerente con la validazione backend | `contract-details.ts`, `project-rates.ts` |
| P1-12 | UI e backend accettano USD/GBP per le negotiated rates ma `sellRateFor` usa solo EUR: righe visibili e salvate che non influenzano i ricavi; header resta "€/day" | Limitare esplicitamente a EUR, o convertire via FX con currency/unità dinamica | `sell-rate.util.ts` |
| P1-13 | Billing T&M usa il bill rate della risorsa anziché la tariffa negoziata. Una sola fattura sul progetto fa sparire dal KPI Unbilled anche time entry future | Usare `sellRateFor`; associare le time entry alla fattura o persistere un cutoff | `billing.ts`, accrual server |
| P1-14 | Financial Plans forza USD mentre il resto tratta gli stessi dati come EUR | Usare `BASE_CURRENCY` o aggiungere currency al record con conversione esplicita | `financial-plans.ts`, modello |
| P1-15 | Remaining Budget resta verde anche quando il valore è negativo | Tono calcolato dal segno e stato esplicito "Over budget" | `financial-plans.ts` |
| P1-16 | Forecast usa le date della request invece di quelle dell'assignment e considera Draft/Rejected come committed | Usare la finestra dell'assignment e una policy esplicita degli stati | `forecast.util.ts` |
| P1-17 | "Total Demand" mostra il picco ma il colore confronta domanda multi-settimana con supply settimanale; con domanda e supply zero restituisce 0% verde | Confrontare misure omogenee; stato critico "No capacity/uncovered demand" | `forecast.ts`, `forecast.util.ts` |
| P1-18 | Available/Over-by sottrae ore lifetime (anche storiche o rifiutate) da capacità settimanale. Skill Gap conta dummy, cessati e indisponibili come copertura | Calcoli time-phased per periodo e stato; filtrare risorse attive, deliverable, disponibili | `forecast.util.ts` |
| P1-19 | My Assignments e My Profile calcolano utilization da ore lifetime, includono Rejected e ripetono la stessa stima per sei mesi con quattro settimane fisse | Allocazioni giornaliere/mensili reali, giorni lavorativi, separazione storico/corrente/forecast | `my-assignments`, `my-profile` |
| P1-20 | Staffing consente allocation negativa o >100, ore oltre il massimo, date invertite; il pulsante controlla solo `hours > 0` | Reactive Form con validatori numerici e cross-field, errori inline, submit vincolato | `staffing.component.ts` |
| P1-21 | Il time entry può terminare senza feedback se manca `projectId` o le ore non sono valide; data vuota e doppio click non protetti | Form validato, messaggio contestuale, stato submitting, idempotenza server | `my-assignments.component.ts` |
| P1-22 | `/projects/<id-inesistente>` resta su "Loading…" ma rende tab e KPI zero/"On Track" | Separare loading/error/not-found; non rendere KPI senza progetto; ritorno alla lista | `project-details.ts` |
| P1-23 | Drawer mobile chiuso ancora tabbabile; aperto non sposta/intrappola/ripristina il focus, non rende inert il background, non risponde a Escape | CDK drawer/focus trap, inert, blocco scroll, Escape, focus restore, aria-expanded/controls | `app.ts` |
| P1-24 | Header/CTA escono dal viewport a 390px: Partners 415, Documents 452, Plans 564, Financial Plans 416 | Stack verticale o wrap sotto breakpoint mobile; CTA full-width o container scroll | project-plans, partners, documents, financial plans |
| P1-25 | Tabelle wide con header nowrap dentro card `overflow-hidden`: colonne e azioni clippate su mobile | Wrapper `overflow-x-auto`, prima colonna sticky, o layout card mobile | `styles.css`, resources |
| P1-26 | Diverse eliminazioni (finanziarie, documenti, rate, profilo) senza conferma né undo | Confirmation comune con nome e conseguenza; undo per rimozioni reversibili | financial plans, documents, profile |
| P1-27 | Eliminando un'esperienza esterna si usa `projectName` come chiave: due omonime vengono eliminate insieme | Id stabile per esperienza o rimozione per indice/composite key, con conferma | `my-profile.component.ts` |
| P1-28 | Issuer OAuth, client id, redirect e `requireHttps:false` hardcoded su localhost: un deployment reale tenta il localhost del browser | Configurazione runtime dal deployment; HTTPS obbligatorio fuori dallo sviluppo | `auth.service.ts` |
| P1-29 | Billing senza validazioni condizionali: milestone/cap/progress possono mancare; tax e retention >100; payment terms negativi o frazionari | Validator dinamici equivalenti su client e server | `billing.ts`, `server.ts` |
| P1-30 | Nessun fallback globale per errori di rendering, lazy chunk o navigazione: una `ResourceValueError` lascia la vista rotta con sola console | `ErrorHandler` applicativo, boundary per route, fallback con retry/reload e telemetria | `app.config.ts`, `main.ts` |

## P2 — Priorità media (35)

P2-01 404 visuale restituisce HTTP 200 in SSR (`app.routes.server.ts`) → `RESPONSE_INIT.status=404` o catch-all, con test HTTP.
P2-02 Contract Details mostra "Contract not found" anche durante il caricamento → branch loading/error/403/404 distinti con Retry e Back.
P2-03 "Find a section…" non cerca i nomi dei gruppi ("Configuration" → No matches) (`app.ts`) → includere le label di gruppo o correggere il placeholder.
P2-04 Due voci "Cost Centers" indistinguibili (`app.ts`) → "Project Cost Centers" e "Organizational Cost Centers".
P2-05 Dopo interazione manuale il gruppo della route attiva può restare chiuso (`app.ts`) → aprire automaticamente il gruppo corrente.
P2-06 Ctrl/Cmd+K focalizza la ricerca nel drawer chiuso/sidebar collassata; hint sempre ⌘K (`app.ts`) → aprire prima la navigazione, shortcut platform-aware.
P2-07 `aria-controls` derivato da label con spazi (`navgroup-Resource Control`) → IDREF non risolvibili (`app.ts`) → slug stabili senza whitespace + test.
P2-08 I tab di Project Details non implementano ARIA Tabs, frecce, deep link, persistenza Back/refresh → child route/query param + pattern tablist/tab/tabpanel.
P2-09 Segmented control di Requests e Approvals comunica la selezione solo visivamente → `aria-pressed` o pattern tabs.
P2-10 Schedule senza equivalenza tastiera/touch per drag, reassign, resize; `role=button` non gestisce Enter/Space; `touch-action:none` ostacola il pan → editor accessibile + gesture con soglia.
P2-11 La timeline Schedule usa `role=table` senza wrapper `role=row` → struttura ARIA completa o tabella semantica.
P2-12 Selezione del paese legata a un `<tr>` mouse-only (`manage-locations.component.ts`) → pulsante/radio in cella o riga focusable con Enter/Space.
P2-13 Azioni hover-only spariscono su touch (foto/esperienze, documenti, work package, export, project actions) → visibili su coarse pointer e focus-visible, o menu azioni.
P2-14 Upload profilo/resume usa input `display:none` dentro label non focusabile → input visually-hidden ma focusabile, o pulsante esplicito.
P2-15 Molti form disabilitano Save senza spiegare l'errore, senza `aria-invalid`/`aria-describedby` → field primitive condivisa con errore inline e summary al submit.
P2-16 Change Requests e Billing non gestiscono Enter: pulsante fuori dal form, manca `ngSubmit` → `type=submit` associato al form + `ngSubmit`.
P2-17 Diverse mutazioni senza pending state, doppio invio possibile → pending signal, disable/"Saving…", idempotency.
P2-18 Create Financial Plan e Invite Partner attive senza progetto; il click produce solo un toast → disabilitare con spiegazione o includere la selezione progetto nel flusso.
P2-19 Multi-select skills richiede Ctrl/Cmd, impossibile su touch → checkbox/chip multiselect accessibile.
P2-20 Il calendario mensile nasconde gli assignment oltre il secondo dietro un "+N more" non interattivo → pulsante che apre elenco/popover accessibile.
P2-21 I default "today" usano UTC e possono slittare di un giorno → helper condiviso per date civili locali.
P2-22 Approval Modal dice "Approve/Reject month" anche con solo alcune righe selezionate → "Approve selected (N)" e riepilogo dello scope.
P2-23 Le righe dell'Approval Modal non fanno wrap: overflow su mobile → layout card/due righe sotto breakpoint.
P2-24 I grafici Forecast dichiarano committed+pipeline stack ma usano `[stacked]=false` → demand stack confrontato con supply line/bar.
P2-25 Revenue breakdown: stesso colore per Labor ed External, percentuali >100% compresse male con margine negativo → colori/pattern distinti e stato overrun separato.
P2-26 `CommandBarChart.height()` imposta `--ldg-h` ma il CSS non usa la variabile → applicare l'altezza al contenitore/SVG e testare il resize.
P2-27 Dark mode: testo bianco su accent/critical a ~3,4:1 e ~4,0:1, sotto 4,5:1 → token testuale dedicato con contrasto verificato.
P2-28 Su 61 tabelle solo 4 hanno caption; 72/303 `<th>` hanno scope → caption/`aria-labelledby`, `scope=col/row`, row header.
P2-29 Toast duplicati (interceptor + componenti), errori sticky, stack illimitato; sotto 384px `right-4 w-full` esce di 16px → ownership unica, deduplica/limite, storico separato, `inset-x-4 w-auto`.
P2-30 Login perde il deep link e torna sempre a `/`; decodifica JWT con `atob` non gestisce UTF-8 → URL interno nello state OAuth e `TextDecoder` sui byte base64url.
P2-31 Il quick start senza IdP/database porta a una Dashboard inutilizzabile (discovery Keycloak fallita, API protette) → profilo demo esplicito e sicuro, o documentazione/config di avvio completa.
P2-32 In demo mode ogni reload registra in rosso "error loading discovery document" anche se il fallback riesce → evitare la discovery quando il backend dichiara demo mode, o classificare l'evento come informativo.
P2-33 Quality gate UI insufficiente: 55 componenti/15 spec, 46 route/9 spec, nessun E2E, axe, responsive, console/network gate, visual regression; coverage/browser runner non installati → CI Node 22 con soglie, Playwright multi-role/viewport, axe, screenshot regression, failure injection.
P2-34 Project Details e Contract Details senza un vero `<h1>`; gerarchia parte da heading inferiori → un solo h1 descrittivo per route.
P2-35 Progetti, contratti, richieste e piani consentono date finali anteriori all'inizio fino al rifiuto server → validator condiviso end ≥ start, min dinamico, errore inline.

## P3 — Priorità bassa (4)

P3-01 Placeholder italiano nell'Approval Inbox in un'app dichiarata inglese (`approvals.ts`) → stringa inglese o i18n coerente.
P3-02 Font e Material Icons dipendono da Google: offline/CSP mostra le ligature testuali nei pulsanti (`index.html`) → self-host o SVG icon registry con fallback.
P3-03 Lo skeleton usa un div generico con `aria-busy` senza `role=status`, live text o testo screen-reader → `role=status`, `aria-live=polite`, testo sr-only.
P3-04 Node locale 25.2.1 non supportato da Angular 21; nessun `engines` né pin, mentre Docker usa Node 22 → vincolare Node 22 via `engines`/`.nvmrc`/Volta e CI.
