# Angular Review — verifica best practice v20+/v21

> Verifica dell'implementazione contro le 10 skill `/angular` (signals, component, http, routing, forms, di, ssr, tooling, testing, directives).
> Generato il 2026-06-07. Complementare ad `AUDIT.md` (che copre la completezza *funzionale*); questo documento copre la **qualità del codice Angular**.

## Baseline iniziale (prima degli interventi)

| Check | Stato iniziale | Causa |
|---|---|---|
| `npm install` | ❌ assente | `node_modules` mai installato; `npm ci` falliva per lockfile disallineato (binari opzionali per-piattaforma mancanti, Node 26) → risolto con `npm install` |
| `ng lint` | ❌ 8 errori | `@typescript-eslint/no-explicit-any` (cast `as any` nei save dei 7 sotto-tab Project) |
| `ng build` | ⚠️ warning | initial bundle **677 kB** > budget 500 kB (zero lazy loading) |
| `ng test` | ❌ 1 fallito | `App.spec` senza provider router → `NG0201 No provider for ActivatedRoute` |

## Stato finale (dopo gli interventi)

| Check | Stato |
|---|---|
| `ng lint` | ✅ 0 errori |
| `ng build` | ✅ initial **379 kB** (main chunk 609 kB → 14 kB), nessun warning |
| `ng test` | ✅ 1/1 |

---

## ✅ Errori corretti

### 1. Toolchain — dipendenze non installate
`node_modules` era assente. `npm ci` rifiutava per lockfile fuori sync. Risolto con `npm install` (lockfile rigenerato). **Nota ricorrente:** su questa repo usare `npm install`, non `npm ci`, finché il lockfile non viene ricommittato allineato.

### 2. 8× `no-explicit-any` + type-safety (skill: forms, component)
I 7 sotto-tab Project costruivano l'oggetto con `{ ...form.value } as any`. `as any` disattiva il type-checking e mascherava bug reali. Corretto introducendo interfacce tipizzate (`Task`, `Partner`, `Issue`, `ProjectDocument`, `FinancialItem`, `CostCenter`) e costruendo gli oggetti esplicitamente da `getRawValue()`.

### 3. 🐛 Bug `NaN%` nei Cost Center (skill: forms)
`project-cost-centers` raccoglieva `allocatedBudget` ma la tabella leggeva `cc.allocated`/`cc.actual` → `undefined/undefined*100 = NaN%`. L'`as any` nascondeva il mismatch. Corretto mappando `allocatedBudget → allocated` e `actual: 0`.

### 4. 🐛 Dashboard: `href` invece di `routerLink` (skill: routing)
`<a href="/requests">` e `<a href="/utilization">` causavano un **full page reload** (reset dell'app + hydration). Sostituiti con `routerLink` + import di `RouterLink`.

### 5. Stato derivato → `computed` (skill: signals)
Dashboard teneva `openRequests`/`overbookedResources`/`recentRequests`/`overbookedResourcesList` come `signal` scritti a mano dentro `subscribe`. Convertiti in `computed` derivati da `resources()`/`requests()` → una sola sorgente di verità.

### 6. Memory leak in `projects.ts` (skill: signals)
`searchControl.valueChanges.subscribe()` non veniva mai chiusa. Sostituita con `toSignal(...)` (auto-cleanup legato al ciclo di vita del componente).

### 7. `standalone: true` ridondante (skill: component)
Rimosso da `manage-skills` (è il default in v20+; la skill dice esplicitamente di non impostarlo).

### 8. Lazy loading + 404 + input binding (skill: routing, tooling)
- Tutte le route convertite a `loadComponent` → initial bundle 677 → 379 kB.
- Aggiunta rotta wildcard `**` con un `NotFoundComponent` (404).
- Abilitato `withComponentInputBinding()`; `project-details` legge `:id` via `input.required<string>()` invece di `ActivatedRoute.snapshot`.

### 9. Test rotto (skill: testing)
`App.spec` ora fornisce `provideRouter([])` nel `TestBed`.

---

## 🔧 Miglioramenti proposti (non ancora applicati)

Ordinati per rapporto valore/rischio. Nessuno è bloccante; richiedono una revisione o decisioni di prodotto.

### A. HTTP: migrare a `httpResource()` / `toSignal` — *alto valore* (skill: http)
Oggi ogni pagina fa `signal([])` + `ngOnInit().subscribe()`, **senza stati di loading/errore**. Con `httpResource` si ottengono `isLoading()`, `error()`, `value()`, `reload()` gratis:
```ts
// invece di: resources = signal([]); ngOnInit(){ api.getResources().subscribe(...) }
resources = httpResource<Resource[]>(() => '/api/resources', { defaultValue: [] });
```
Candidati: dashboard, projects, my-assignments, staffing, utilization, manage-skills, tutte le config.

### B. Gestione errori assente — *alto valore* (skill: http, di)
Nessun `catchError`; una GET/PUT fallita non mostra nulla. Proporre un `errorInterceptor` funzionale + uno stato d'errore globale (toast). Registrazione via `provideHttpClient(withInterceptors([errorInterceptor]))`.

### C. SSR: hydration mancante — *alto valore* (skill: ssr)
`app.config.ts` non ha `provideClientHydration()` → il client **ri-renderizza da zero** scartando il DOM SSR. Aggiungere:
```ts
provideClientHydration(withEventReplay())
```
+ `withHttpTransferCacheOptions(...)` per non rifare le GET lato client. ⚠️ Da testare a runtime per eventuali hydration mismatch.

### D. `CommonModule` ovunque → import specifici (skill: component)
Ogni componente importa `CommonModule` intero. Con il control-flow nativo (`@if/@for`) già in uso, servono solo le pipe: importare `DatePipe`, `DecimalPipe`, `CurrencyPipe` (e `NgClass` finché presente).

### E. `[ngClass]` → `[class]` (skill: component — "do NOT use ngClass")
Presente in `reporting.ts`, `project-issues.ts`, `my-assignments.component.ts`. Convertire in `[class.x]="cond"` o `[class]="mapString()"`.

### F. `my-assignments`: `Math = Math` nel componente + distribuzione finta (skill: component, signals)
`Math = Math` espone l'oggetto globale al template (anti-pattern). La griglia settimanale mostra `assignedHours/5` come distribuzione giornaliera **finta**. Sostituire con un `computed` onesto (o etichettare i dati come stimati).

### G. `alert()` / `confirm()` → dialog Material (skill: component)
`manage-skills` (confirm delete) e i vari `alert('Please select a project')` bloccano il thread e non sono testabili/accessibili. Usare `MatDialog`/`MatSnackBar`.

### H. Stub che fingono successo — *correttezza* (vedi anche AUDIT.md)
`manage-skills` upload CSV e `maintain-availability` mostrano `alert("...uploaded successfully")` senza fare nulla. Sostituire con stato "non disponibile" onesto o implementazione reale.

### I. Mismatch `projectId` mock vs reale — *correttezza* (skill: http)
Le 7 sotto-schede Project filtrano su `projectId` hardcoded (`P-1001`/`P-1002`), mentre i progetti reali hanno id `'1'`/`'2'` → per un progetto reale le schede sono vuote. Richiede endpoint backend reali (in `server.ts` + `ApiService`) e filtro sull'id reale.

### J. `ApiService`: base URL via InjectionToken (skill: di, ssr)
Sostituire il ternario `isPlatformServer(...) ? 'http://localhost:3000/api' : '/api'` con un `API_BASE_URL = new InjectionToken<string>(...)` fornito diversamente in `app.config` e `app.config.server`.

### K. Copertura test minima (skill: testing)
Un solo spec. Aggiungere: test di `ApiService` con `HttpTestingController`; test dei `computed` (dashboard, financial-plans, my-assignments); test del binding `:id → input()` di `project-details`.

### L. Signal Forms — *forward-looking* (skill: forms)
I Reactive Forms attuali sono corretti. Valutare la migrazione alla nuova **Signal Forms API** (sperimentale in v21) per i form più complessi. Non urgente; sperimentale.

### M. Prerendering pagine statiche (skill: ssr)
`app.routes.server.ts` usa `RenderMode.Server` per tutto ("Prerendered 0 static routes"). Le pagine di configurazione semi-statiche possono usare `RenderMode.Prerender`; le viste dati autenticate `RenderMode.Client`.

### N. Bottoni morti (vedi AUDIT.md per l'elenco completo)
Dashboard `Filter`/`New Request`, frecce calendario `my-assignments`, azioni `reporting`, icone `edit`/`more_vert` nei Project: collegare un handler o rimuoverle.
