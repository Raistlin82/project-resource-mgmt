# Audit di implementazione — Project & Resource Management

> Analisi totale dell'applicazione per distinguere cosa è **realmente implementato** dai pulsanti/funzioni che sembrano attivi ma non producono effetti persistenti.
> Generato il 2026-06-07.

## Verdetto generale

La divisione in aree (**Resource** / **Project** / **Analytics** / **Configuration**) è corretta, ma il livello di completamento è molto disomogeneo. Solo poche aree sono realmente persistenti; gran parte del Project Management e quasi tutto Analytics & Reporting sono mock locali o pulsanti morti.

### Causa architetturale

Il "backend" è una mock API in-memory dentro `src/server.ts`. Esistono endpoint CRUD solo per: `resources`, `requests`, `assignments`, `projects`, e le entità di configurazione (`languages`, `skill-catalogs`, `proficiency-sets`, `skills`, `project-roles`, `service-organizations` [GET-only], `resource-organizations`). **Tutto il resto non ha endpoint**, quindi qualsiasi azione su quelle entità è necessariamente solo locale o non implementata.

## Legenda

- ✅ **Funzionante** — chiama un endpoint reale (mock API in `server.ts`), persiste
- ⚠️ **Solo locale** — modifica solo un `signal` in memoria, perso al reload (nessun endpoint esiste)
- ❌ **Non implementato** — nessun handler, handler vuoto, solo `alert()`/`console.log`, o chiama un metodo API inesistente

---

## 1. Resource Management — *quasi completo*

| Pagina | Stato | Note |
|---|---|---|
| **My Profile** (`my-profile/my-profile.component.ts`) | ✅ Completo | 14 controlli tutti funzionanti (skills, ruoli, esperienza, foto, CV → tutti `updateResource`) |
| **Resource Requests** (`resource-requests/resource-requests.component.ts`) | ✅ Completo | CRUD reale + publish/withdraw/track, filtri client-side |
| **Staffing** (`staffing/staffing.component.ts`) | ✅ Completo | `createAssignment` reale; selezione/filtro/assegnazione |
| **My Assignments** (`my-assignments/my-assignments.component.ts`) | ⚠️/❌ Parziale | Save ore = ✅. Frecce calendario prev/next = ❌ morte. Griglia settimanale/mensile = placeholder visivo (distribuzione `assignedHours/5` finta) |
| **Dashboard** (`dashboard/dashboard.component.ts`) | ❌ Bottoni morti | "Filter" e "New Request" (header) senza handler. Solo i link "View All"/"Manage" navigano |

---

## 2. Project Management — *solo "Projects" è reale, tutto il resto è mock*

**Punto critico:** esiste l'endpoint CRUD solo per `projects`. Le 7 sotto-schede (partners, documents, plans, financial-plans, cost-centers, tasks, issues) non hanno alcun endpoint → ogni "Create/Add/Invite/Upload" aggiunge righe effimere perse al reload.

| Pagina | Stato | Note |
|---|---|---|
| **Projects** (`projects/projects/projects.ts`, `project-details/project-details.ts`) | ✅ Completo | Unica area con persistenza reale (create/edit/delete/search/tab) |
| **Project Partners** (`projects/project-partners/project-partners.ts`) | ⚠️ + ❌ | "Invite Partner" solo locale; icona `more_vert` morta |
| **Project Documents** (`projects/project-documents/project-documents.ts`) | ⚠️ + ❌ | Nessun vero upload file; card cliccabile e `more_vert` non fanno nulla |
| **Project Plans** (`projects/project-plans/project-plans.ts`) | ⚠️ + ❌ | Milestone/Work package solo locali; icona edit morta |
| **Financial Plans** (`projects/financial-plans/financial-plans.ts`) | ⚠️ | Create solo locale; nessun edit/delete sulle righe |
| **Project Cost Centers** (`projects/project-cost-centers/project-cost-centers.ts`) | ⚠️ + ❌ | Add solo locale; edit morto; 🐛 bug: `allocatedBudget` non mappato → usage `NaN%` |
| **Project Tasks** (`projects/project-tasks/project-tasks.ts`) | ⚠️ | Create solo locale; nessun controllo per cambiare stato task |
| **Project Issues** (`projects/project-issues/project-issues.ts`) | ⚠️ | Create solo locale; un'issue non può mai essere chiusa via UI |

> ⚠️ **Effetto collaterale grave:** i mock usano `projectId` fissi `'P-1001'`/`'P-1002'`. Per un progetto reale creato dalla CRUD funzionante, tutte le 7 schede appaiono vuote.

---

## 3. Analytics & Reporting — *split netto*

| Pagina | Stato | Note |
|---|---|---|
| **Utilization** (`utilization/utilization.component.ts`) | ✅ Completo | Dati reali (`forkJoin` resources+assignments+requests); copy/paste/create/edit/delete assegnazioni tutti reali. *(In realtà è gestione utilizzo, non analytics)* |
| **Reporting** (`reporting/reporting.ts`) | ❌ Tutto finto | Nessun ApiService iniettato. 7 controlli morti: filtro date, Export Report, 2× `more_vert`, Filter, Search, "View report →". KPI/grafici/tabella = mock hardcoded |

---

## 4. Configuration — *buona, con 2 pagine placeholder*

| Pagina | Stato | Note |
|---|---|---|
| **Default Language** (`configuration/set-default-language.component.ts`) | ✅ | `setDefaultLanguage` reale |
| **Skill Catalogs** (`configuration/manage-skill-catalogs.component.ts`) | ✅ | create/delete reali |
| **Proficiency Sets** (`configuration/manage-proficiency-sets.component.ts`) | ✅ | create/delete reali (edit non esiste — coerente, nessuno stub) |
| **Manage Skills** (`configuration/manage-skills.component.ts`) | ✅ + ⚠️ + ❌ | CRUD reale; Download CSV (client-side ok); Upload CSV = ❌ stub con `alert` fasullo |
| **Project Roles** (`configuration/manage-project-roles.component.ts`) | ✅ | create + toggle restrict reali (delete non esiste — coerente) |
| **Resource Organizations** (`configuration/manage-resource-organizations.component.ts`) | ✅ | create/delete reali |
| **Service Org Details** (`configuration/service-organization-details.component.ts`) | ✅ read-only | Solo GET (corretto by-design) + export client-side |
| **Manage Cost Centers** (`configuration/manage-cost-centers.component.ts`) | ⚠️ placeholder | CRUD tutto su mock locale, nessun endpoint; search input morto |
| **Maintain Availability** (`configuration/maintain-availability-data.component.ts`) | ❌/⚠️ placeholder | Upload CSV = stub con `alert`; nessun endpoint availability |

---

## Sintesi dei problemi prioritari

### 🔴 Bottoni completamente morti (nessun handler)
- **Dashboard**: `Filter`, `New Request`
- **My Assignments**: frecce `‹ ›` del calendario
- **Reporting**: `Export Report`, filtro date, `View report →`, 2× `more_vert`, `Filter`, `Search`
- **Project**: `more_vert` (Partners, Documents), `edit` (Plans, Cost Centers), card documento cliccabile

### 🟠 Stub che fingono successo (`alert("...uploaded successfully")`)
- `manage-skills.ts` → Upload CSV
- `maintain-availability-data.ts` → Upload CSV

### 🟡 Persistenza illusoria (mock locale, perso al reload — manca l'endpoint)
- Tutte le 7 sotto-schede Project (partners, documents, plans, financial-plans, cost-centers, tasks, issues)
- Manage Cost Centers (configuration)
- Dati Reporting

### 🐛 Bug funzionale
- `project-cost-centers.ts` → `allocatedBudget` non mappato a `allocated`/`actual` → badge usage mostra `NaN%`

---

## Funzioni client-side reali (ok, ma senza backend)
Download/export generati lato browser dai dati già caricati — funzionano ma non passano da nessun endpoint:
- Download CSV (`manage-skills.ts`)
- Export to Spreadsheet (`service-organization-details.ts`)
- Template download (`maintain-availability-data.ts`)

---

## Raccomandazioni di sequenza

1. **Quick-win (basso rischio, nessun endpoint):** correggere/rimuovere i bottoni morti evidenti, il bug `NaN%` dei cost-center, implementare le frecce del calendario, sostituire gli `alert()` fasulli con uno stato "non disponibile" onesto.
2. **Backend mancante (interventi strutturali):** aggiungere in `server.ts` + `ApiService` gli endpoint per partners, documents, plans, financial-plans, cost-centers, tasks, issues e collegare le 7 sotto-schede ai `projectId` reali; aggiungere endpoint reporting/export e availability.
3. **Coerenza dati:** far sì che le sotto-schede Project filtrino sull'`id` reale del progetto invece dei `projectId` mock `P-1001/P-1002`.
