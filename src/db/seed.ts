/**
 * SHARED SEED DATA (single source of truth).
 *
 * This module contains the canonical initial contents of every in-memory
 * store/array used by the demo backend, extracted VERBATIM from the seed
 * literals in src/server.ts. The goal is one shared source of seed data that
 * both the in-memory adapter (src/server.ts) and the Postgres seeder can use,
 * so the two can never drift apart.
 *
 * RULES:
 *   - Every export is a typed `const` array, one per entity, with camelCase
 *     field names matching the TypeScript interfaces in
 *     src/app/services/api.service.ts (imported below).
 *   - Values are copied EXACTLY from server.ts: same ids, same field values,
 *     including the USD/EUR fxRates, the USD-denominated CT2 contract chain,
 *     the per-BillingType billing items, and the three seeded approval
 *     requests (with their server-derived steps/currentStep/status/slaDueAt
 *     materialised inline so the data is self-contained).
 *   - No `any`. Each export is annotated with its api.service interface so the
 *     literal unions (statuses, kinds, recurrences, ...) are type-checked.
 *
 * NOTE: server.ts is intentionally NOT modified by the change that introduced
 * this file; it remains the behavioural reference these values were copied
 * from.
 */
import type {
  Resource,
  User,
  ResourceRequest,
  Assignment,
  TimeEntry,
  Language,
  SkillCatalog,
  ProficiencySet,
  Skill,
  ProjectRole,
  ServiceOrganization,
  ResourceOrganization,
  Country,
  City,
  Industry,
  CostCategory,
  PartnerRole,
  Vendor,
  RateCard,
  Project,
  Partner,
  ProjectDocument,
  WorkPackage,
  Milestone,
  FinancialItem,
  ProjectCostCenter,
  Task,
  Issue,
  ChangeRequest,
  CostCenter,
  Customer,
  Contract,
  Order,
  OrderLine,
  BillingPlanItem,
  ApprovalRequest,
  AuditLog,
  FxRate,
} from '../app/services/api.service';

// --- Core resources ---------------------------------------------------------

export const resources: Resource[] = [
  // utilization is an independent profile value (NOT derived from assignedHours).
  // It is kept plausible against each resource's booking load below: Julie is the
  // over-allocated developer (two overlapping Alpha bookings), John is fully
  // committed on the Beta migration, Alice carries two partial Beta bookings.
  // PHASE F2 — REFERENCE-DATA INTEGRITY: `location` is bound to the cities catalog
  // (store = city name; 'New York'/'London' are seeded cities, 'Remote' is the
  // seeded sentinel city). `organization` is bound to the resource-organizations
  // catalog (store = org name); the names below are seeded resource-org rows.
  { id: '1', name: 'Julie Armstrong', role: 'Developer',
    skills: [{ name: 'Java', level: 3 }, { name: 'Spring', level: 2 }],
    projectRoles: ['Senior Developer', 'Backend Engineer'],
    externalExperience: [{ projectName: 'E-commerce Migration', company: 'TechCorp', role: 'Java Developer', startDate: '2020-01-01', endDate: '2022-12-31', comment: 'Migrated legacy system to Spring Boot.' }],
    profilePicture: '', resume: '', utilization: 95, capacity: 40, managerId: '1', organization: 'Engineering', location: 'New York', costRate: 75, billRate: 140, hireDate: '2019-03-04' },
  { id: '2', name: 'John Miller', role: 'Consultant',
    skills: [{ name: 'Project Management', level: 2 }], projectRoles: ['Business Consultant'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 90, capacity: 40, managerId: '1', organization: 'Consulting', location: 'London', costRate: 90, billRate: 180, hireDate: '2021-09-13' },
  { id: '3', name: 'Alice Smith', role: 'Designer',
    skills: [{ name: 'Figma', level: 3 }], projectRoles: ['UX Designer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 55, capacity: 40, managerId: '2', organization: 'Design', location: 'Remote', hireDate: '2023-01-16' },
];

export const users: User[] = [
  { id: '1', resourceId: '1', name: 'Julie Armstrong', role: 'delivery-executive' },
  { id: '2', resourceId: '2', name: 'John Miller', role: 'resource-manager' },
  { id: '3', resourceId: '3', name: 'Alice Smith', role: 'pm' },
  { id: '4', resourceId: '2', name: 'Finance Controller', role: 'finance' },
  { id: '5', resourceId: '3', name: 'Sales Lead', role: 'sales' },
  { id: '6', resourceId: '1', name: 'System Admin', role: 'admin' },
];

// B9: a request is 'Fulfilled' iff staffedEffort >= requiredEffort (server-derived
// rule; see staffing.util `requestStatusFor`). Each request's staffedEffort below
// equals the sum of assignedHours across its assignments, keeping the seed coherent.
// Date windows are anchored across 2026-04 .. 2026-09 so the bookings fall inside
// the schedule view's default ~12-week horizon from "today" (2026-06-12).
export const requests: ResourceRequest[] = [
  { id: '1', name: 'Project Alpha - Backend', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 20, status: 'Fulfilled', skills: ['Java'], description: 'Backend development for Project Alpha', startDate: '2026-04-01', endDate: '2026-06-30', requesterId: '1', projectId: '1' },
  { id: '2', name: 'Project Beta - UI', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 8, status: 'Published', skills: ['Figma'], description: 'UI Design for Project Beta', startDate: '2026-05-01', endDate: '2026-07-31', requesterId: '1', projectId: '2' },
  { id: '3', name: 'Project Alpha - API Hardening', requiredRole: 'Developer', requiredEffort: 24, staffedEffort: 24, status: 'Fulfilled', skills: ['Java'], description: 'API hardening and performance work for Project Alpha', startDate: '2026-06-15', endDate: '2026-08-31', requesterId: '1', projectId: '1' },
  { id: '4', name: 'Project Beta - Platform Migration', requiredRole: 'Consultant', requiredEffort: 30, staffedEffort: 30, status: 'Fulfilled', skills: ['Project Management'], description: 'Lead the platform migration workstream for Project Beta', startDate: '2026-05-15', endDate: '2026-09-15', requesterId: '1', projectId: '2' },
  { id: '5', name: 'Project Beta - Design QA', requiredRole: 'Designer', requiredEffort: 10, staffedEffort: 10, status: 'Fulfilled', skills: ['Figma'], description: 'Design quality pass ahead of Project Beta go-live', startDate: '2026-08-01', endDate: '2026-09-30', requesterId: '1', projectId: '2' },
];

// Resource Schedule (Approach B): every assignment carries an explicit booking
// window (startDate/endDate) + an allocationPct of the resource's weekly capacity.
//
// DELIBERATE OVER-ALLOCATION (conflict-detection demo): resource '1' Julie
// Armstrong is double-booked — A1 (Alpha Backend, 60%, 2026-05-01..2026-06-30)
// overlaps A2 (Alpha API Hardening, 70%, 2026-06-15..2026-08-31). In the overlap
// window 2026-06-15..2026-06-30 the summed allocation is 60 + 70 = 130% > 100%, so
// the schedule util flags both bookings and records a peak of 130%.
//
// The rest read realistically: a FULL booking (A3 John Miller 100%, no overlap)
// and two PARTIAL, NON-OVERLAPPING bookings (A4/A5 Alice Smith 50% each — A4 ends
// 2026-07-31, A5 starts 2026-08-01; the half-open [start,end) interval makes these
// adjacent, NOT conflicting).
export const assignments: Assignment[] = [
  { id: '1', requestId: '1', resourceId: '1', assignedHours: 20, status: 'hard-booked', startDate: '2026-05-01', endDate: '2026-06-30', allocationPct: 60 },
  { id: '2', requestId: '3', resourceId: '1', assignedHours: 24, status: 'hard-booked', startDate: '2026-06-15', endDate: '2026-08-31', allocationPct: 70 },
  { id: '3', requestId: '4', resourceId: '2', assignedHours: 30, status: 'hard-booked', startDate: '2026-05-15', endDate: '2026-09-15', allocationPct: 100 },
  { id: '4', requestId: '2', resourceId: '3', assignedHours: 8, status: 'soft-booked', startDate: '2026-05-01', endDate: '2026-07-31', allocationPct: 50 },
  { id: '5', requestId: '5', resourceId: '3', assignedHours: 10, status: 'hard-booked', startDate: '2026-08-01', endDate: '2026-09-30', allocationPct: 50 },
];

export const timeEntries: TimeEntry[] = [
  { id: 'TE1', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-06', hours: 8, status: 'Approved', notes: 'Backend integration', approvedBy: '1', approvedAt: '2026-04-07T09:00:00.000Z' },
  { id: 'TE2', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-07', hours: 8, status: 'Approved', notes: 'API hardening', approvedBy: '1', approvedAt: '2026-04-08T09:00:00.000Z' },
  { id: 'TE3', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-08', hours: 4, status: 'Submitted', notes: 'Defect fixing' },
];

// --- Configuration ----------------------------------------------------------

export const languages: Language[] = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'de', name: 'German', isDefault: false },
  { code: 'es', name: 'Spanish', isDefault: false },
  { code: 'fr', name: 'French', isDefault: false },
];

export const skillCatalogs: SkillCatalog[] = [
  { id: '1', name: 'Development Skills', description: 'Skills related to software development', skills: ['1', '2'] },
];

export const proficiencySets: ProficiencySet[] = [
  { id: '1', name: 'Standard IT Proficiency', description: 'Standard 1-5 level proficiency',
    levels: [
      { id: 'l1', level: 1, name: 'Beginner', description: 'Basic knowledge' },
      { id: 'l2', level: 2, name: 'Intermediate', description: 'Practical application' },
      { id: 'l3', level: 3, name: 'Advanced', description: 'Applied theory' },
      { id: 'l4', level: 4, name: 'Expert', description: 'Recognized authority' },
    ] },
];

export const skills: Skill[] = [
  { id: '1', conceptUri: 'sap-rm://skill/1', name: 'Java', description: 'Java programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
  { id: '2', conceptUri: 'sap-rm://skill/2', name: 'JavaScript', description: 'JS programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
];

// CANONICAL ROLE CATALOG (reference-data integrity, Phase A). The stored value
// on resources/requests is the role NAME (backward-compatible with match-scoring
// which compares role strings), so this catalog MUST cover every role value used
// by the seeded resources (`role` + `projectRoles[]`) and requests (`requiredRole`):
//   - resources.role:         Developer, Consultant, Designer
//   - resources.projectRoles: Senior Developer, Backend Engineer, Business Consultant, UX Designer
//   - requests.requiredRole:  Developer, Designer, Consultant
// The original DEV/PM rows are kept; the rest are added so existing data stay
// valid SELECT options and never get silently discarded on edit.
export const projectRoles: ProjectRole[] = [
  { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
  { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false },
  { id: '3', code: 'SR_DEV', name: 'Senior Developer', description: 'Senior Software Developer', restricted: false },
  { id: '4', code: 'BE_ENG', name: 'Backend Engineer', description: 'Backend Engineer', restricted: false },
  { id: '5', code: 'CONS', name: 'Consultant', description: 'Consultant', restricted: false },
  { id: '6', code: 'BIZ_CONS', name: 'Business Consultant', description: 'Business Consultant', restricted: false },
  { id: '7', code: 'DESIGN', name: 'Designer', description: 'Designer', restricted: false },
  { id: '8', code: 'UX_DESIGN', name: 'UX Designer', description: 'UX Designer', restricted: false },
];

export const serviceOrganizations: ServiceOrganization[] = [
  { id: '1', code: 'SO_DE', description: 'Service Org Germany', costCenters: ['CC_DE_1', 'CC_DE_2'] },
];

// PHASE F2 — `Resource.organization` is bound to this catalog by NAME. The seeded
// resources carry organization 'Engineering'/'Consulting'/'Design', so add a row per
// name (alongside the original Germany org) to keep existing data a valid SELECT
// option. costCenters reference the configuration cost-centers catalog (CC-9001/9002).
export const resourceOrganizations: ResourceOrganization[] = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: ['CC_DE_1', 'CC_DE_2'], serviceOrganizationId: '1' },
  { id: '2', name: 'Engineering', description: 'Engineering organization', costCenters: ['CC-9001'], serviceOrganizationId: '1' },
  { id: '3', name: 'Consulting', description: 'Consulting organization', costCenters: ['CC-9002'], serviceOrganizationId: '1' },
  { id: '4', name: 'Design', description: 'Design organization', costCenters: [], serviceOrganizationId: '1' },
];

// --- Customizing catalogs (Phase F1 — additive reference data) --------------

// Countries keyed by ISO 3166-1 alpha-2 code. Covers the countries present in
// the existing resource/project/customer location data (US New York, GB London,
// DE Berlin/Munich) plus the principal extras (IT/FR/ES) so F2 can reconcile.
export const countries: Country[] = [
  { code: 'IT', name: 'Italy' },
  { code: 'DE', name: 'Germany' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
];

// Principal Italian cities/comuni (~20) plus the cities present in existing data
// (Berlin/Munich DE, London GB, New York US) so F2 can reconcile project/resource
// locations. Extendable in customizing.
export const cities: City[] = [
  { id: 'CITY_ROMA', name: 'Roma', countryCode: 'IT' },
  { id: 'CITY_MILANO', name: 'Milano', countryCode: 'IT' },
  { id: 'CITY_NAPOLI', name: 'Napoli', countryCode: 'IT' },
  { id: 'CITY_TORINO', name: 'Torino', countryCode: 'IT' },
  { id: 'CITY_PALERMO', name: 'Palermo', countryCode: 'IT' },
  { id: 'CITY_GENOVA', name: 'Genova', countryCode: 'IT' },
  { id: 'CITY_BOLOGNA', name: 'Bologna', countryCode: 'IT' },
  { id: 'CITY_FIRENZE', name: 'Firenze', countryCode: 'IT' },
  { id: 'CITY_BARI', name: 'Bari', countryCode: 'IT' },
  { id: 'CITY_CATANIA', name: 'Catania', countryCode: 'IT' },
  { id: 'CITY_VENEZIA', name: 'Venezia', countryCode: 'IT' },
  { id: 'CITY_VERONA', name: 'Verona', countryCode: 'IT' },
  { id: 'CITY_PADOVA', name: 'Padova', countryCode: 'IT' },
  { id: 'CITY_TRIESTE', name: 'Trieste', countryCode: 'IT' },
  { id: 'CITY_BRESCIA', name: 'Brescia', countryCode: 'IT' },
  { id: 'CITY_PARMA', name: 'Parma', countryCode: 'IT' },
  { id: 'CITY_MODENA', name: 'Modena', countryCode: 'IT' },
  { id: 'CITY_PERUGIA', name: 'Perugia', countryCode: 'IT' },
  { id: 'CITY_CAGLIARI', name: 'Cagliari', countryCode: 'IT' },
  { id: 'CITY_REGGIO_CALABRIA', name: 'Reggio Calabria', countryCode: 'IT' },
  // Cities present in existing project/resource data (for F2 reconciliation).
  { id: 'CITY_BERLIN', name: 'Berlin', countryCode: 'DE' },
  { id: 'CITY_MUNICH', name: 'Munich', countryCode: 'DE' },
  { id: 'CITY_LONDON', name: 'London', countryCode: 'GB' },
  { id: 'CITY_NEW_YORK', name: 'New York', countryCode: 'US' },
];

// PHASE F2 — 'Remote' is an allowed location sentinel (not a physical city). It is
// stored on `Resource.location` for fully-remote staff. Bindings surface it as a
// dedicated "Remote" option (outside the Country>City filter) and the server treats
// it as a valid location value.
export const REMOTE_LOCATION = 'Remote';

// Standard industry list (covers existing customer industries Manufacturing,
// Finance -> Financial Services).
export const industries: Industry[] = [
  { id: 'IND_TECH', name: 'Technology' },
  { id: 'IND_FINSERV', name: 'Financial Services' },
  { id: 'IND_MANUF', name: 'Manufacturing' },
  { id: 'IND_HEALTH', name: 'Healthcare' },
  { id: 'IND_RETAIL', name: 'Retail' },
  { id: 'IND_ENERGY', name: 'Energy & Utilities' },
  { id: 'IND_TELCO', name: 'Telecommunications' },
  { id: 'IND_PUBLIC', name: 'Public Sector' },
  { id: 'IND_PROFSVC', name: 'Professional Services' },
  { id: 'IND_MEDIA', name: 'Media & Entertainment' },
  { id: 'IND_TRANSPORT', name: 'Transportation & Logistics' },
  { id: 'IND_EDU', name: 'Education' },
  { id: 'IND_REALESTATE', name: 'Real Estate' },
  { id: 'IND_PHARMA', name: 'Pharmaceuticals' },
];

// Cost categories (covers existing financial-plan categories: Software Licenses
// -> Software & Licenses, Consulting Services -> Subcontracting, Hardware).
export const costCategories: CostCategory[] = [
  { id: 'CCAT_LABOR', name: 'Labor' },
  { id: 'CCAT_TRAVEL', name: 'Travel & Expenses' },
  { id: 'CCAT_SOFTWARE', name: 'Software & Licenses' },
  { id: 'CCAT_HARDWARE', name: 'Hardware' },
  { id: 'CCAT_SUBCONTRACT', name: 'Subcontracting' },
  { id: 'CCAT_TRAINING', name: 'Training' },
  { id: 'CCAT_FACILITIES', name: 'Facilities' },
  { id: 'CCAT_MARKETING', name: 'Marketing' },
  { id: 'CCAT_OTHER', name: 'Other' },
];

// Partner relationship roles (covers existing project-partner role values:
// 'Development Partner', and 'UI/UX Design' which maps to a Technology Partner).
export const partnerRoles: PartnerRole[] = [
  { id: 'PROLE_DEV', name: 'Development Partner' },
  { id: 'PROLE_SUBCONTRACT', name: 'Subcontractor' },
  { id: 'PROLE_RESELLER', name: 'Reseller' },
  { id: 'PROLE_TECH', name: 'Technology Partner' },
  { id: 'PROLE_STAFFING', name: 'Staffing Agency' },
  { id: 'PROLE_CONSULTING', name: 'Consulting Partner' },
];

// Vendor catalog: partner/supplier companies. Seeded from existing project-partner
// companies (TechCorp Inc., DesignStudio LLC) plus a few plausible others.
export const vendors: Vendor[] = [
  { id: 'V1', name: 'TechCorp Inc.', vatId: 'US-TECH-0001', country: 'US' },
  { id: 'V2', name: 'DesignStudio LLC', vatId: 'US-DSGN-0002', country: 'US' },
  { id: 'V3', name: 'Nordwind Software GmbH', vatId: 'DE-NORD-0003', country: 'DE' },
  { id: 'V4', name: 'Mediolanum Consulting S.r.l.', vatId: 'IT-MEDI-0004', country: 'IT' },
  { id: 'V5', name: 'Albion Cloud Services Ltd', vatId: 'GB-ALBI-0005', country: 'GB' },
];

// RATE CARDS (Phase E) — DEFAULT cost/bill rates per role (base currency EUR).
// A resource's effective rate = its per-resource override ?? the card matching
// its role (and organization, if an org-specific card exists). Generic cards
// (no organization) cover every org; 'RC_DEV_ENG' demonstrates an org-specific
// override that beats the generic Developer card for the Engineering org.
export const rateCards: RateCard[] = [
  { id: 'RC_DEV', role: 'Developer', currency: 'EUR', costRate: 75, billRate: 140 },
  { id: 'RC_PM', role: 'Project Manager', currency: 'EUR', costRate: 95, billRate: 190 },
  { id: 'RC_SR_DEV', role: 'Senior Developer', currency: 'EUR', costRate: 95, billRate: 175 },
  { id: 'RC_BE_ENG', role: 'Backend Engineer', currency: 'EUR', costRate: 85, billRate: 160 },
  { id: 'RC_CONS', role: 'Consultant', currency: 'EUR', costRate: 90, billRate: 180 },
  { id: 'RC_BIZ_CONS', role: 'Business Consultant', currency: 'EUR', costRate: 110, billRate: 210 },
  { id: 'RC_DESIGN', role: 'Designer', currency: 'EUR', costRate: 65, billRate: 120 },
  { id: 'RC_UX_DESIGN', role: 'UX Designer', currency: 'EUR', costRate: 70, billRate: 130 },
  // Org-specific override: Developers in the Engineering org bill higher.
  { id: 'RC_DEV_ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 80, billRate: 150 },
];

// PHASE F2 — `location` is bound to the cities catalog (store = city name).
// 'Berlin'/'Munich' are seeded cities (countryCode 'DE').
export const projects: Project[] = [
  { id: '1', name: 'Project Alpha', location: 'Berlin', startDate: '2026-04-01', endDate: '2026-12-31', status: 'In Planning', description: 'A major software development project.', ownerId: '1', contractId: 'CT1' },
  { id: '2', name: 'Project Beta', location: 'Munich', startDate: '2026-05-01', endDate: '2027-05-01', status: 'In Execution', description: 'Infrastructure upgrade project.', ownerId: '1', contractId: 'CT2' },
];

// --- Project sub-resources (seeded on REAL ids 1/2) -------------------------

// PHASE F2 — `company` is bound to the vendors catalog (store = company name) and
// `role` to the partner-roles catalog (store = role name). 'TechCorp Inc.' /
// 'DesignStudio LLC' are seeded vendors; 'Development Partner' / 'Technology Partner'
// are seeded partner-roles ('UI/UX Design' reconciled to 'Technology Partner').
export const projectPartners: Partner[] = [
  { id: 'PT1', projectId: '1', company: 'TechCorp Inc.', role: 'Development Partner', contact: 'Jane Doe', status: 'Active' },
  { id: 'PT2', projectId: '2', company: 'DesignStudio LLC', role: 'Technology Partner', contact: 'John Smith', status: 'Invited' },
];

export const projectDocuments: ProjectDocument[] = [
  // PHASE D — author is an ACTOR field (the document's creator). Reconcile the seed
  // names to existing resources so the displayed authors are real people.
  { id: 'D1', projectId: '1', name: 'Project_Charter_v1.pdf', type: 'pdf', size: '2.4 MB', uploadedAt: '2 days ago', author: 'Julie Armstrong', authorInitials: 'JA' },
  { id: 'D2', projectId: '2', name: 'Requirements_Spec.docx', type: 'word', size: '1.1 MB', uploadedAt: '5 days ago', author: 'John Miller', authorInitials: 'JM' },
];

export const workPackages: WorkPackage[] = [
  { id: 'WP-1.1', projectId: '1', name: 'Requirements Analysis', startDate: '2026-04-01', endDate: '2026-04-15', status: 'Completed', progress: 100, assignee: 'Alice Smith' },
  { id: 'WP-1.2', projectId: '1', name: 'System Architecture Design', startDate: '2026-04-16', endDate: '2026-05-05', status: 'In Progress', progress: 60, assignee: 'Julie Armstrong' },
  { id: 'WP-2.1', projectId: '2', name: 'Frontend Development', startDate: '2026-05-06', endDate: '2026-06-20', status: 'In Progress', progress: 40, assignee: 'Alice Smith' },
];

export const milestones: Milestone[] = [
  { id: 'M1', projectId: '1', name: 'Project Kickoff', date: '2026-04-01', status: 'Achieved' },
  { id: 'M2', projectId: '1', name: 'Go-Live', date: '2026-12-01', status: 'Pending' },
  { id: 'M3', projectId: '2', name: 'Architecture Approved', date: '2026-05-20', status: 'Pending' },
];

// PHASE F2 — `category` is bound to the cost-categories catalog (store = name).
// 'Software & Licenses' / 'Subcontracting' / 'Hardware' are seeded categories
// ('Software Licenses' -> 'Software & Licenses', 'Consulting Services' -> 'Subcontracting').
export const projectFinancials: FinancialItem[] = [
  { id: 'F1', projectId: '1', category: 'Software & Licenses', budget: 20000, actual: 18500 },
  { id: 'F2', projectId: '1', category: 'Subcontracting', budget: 50000, actual: 25000 },
  { id: 'F3', projectId: '2', category: 'Hardware', budget: 10000, actual: 11200 },
];

export const projectCostCenters: ProjectCostCenter[] = [
  { id: 'CC-1001', projectId: '1', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
  // PHASE D — manager is a PERSON reference to the resources catalog; reconcile the
  // orphan names ('Bob Jones'/'Charlie Brown') to existing resources.
  { id: 'CC-1002', projectId: '1', name: 'Design & UX', manager: 'John Miller', allocated: 50000, actual: 48000 },
  { id: 'CC-1003', projectId: '2', name: 'Quality Assurance', manager: 'Julie Armstrong', allocated: 40000, actual: 42000 },
];

export const projectTasks: Task[] = [
  // PHASE D — assignee is a PERSON reference to the resources catalog (or 'Unassigned').
  // Reconcile the orphan names ('Jane Doe'/'John Smith') to existing resources.
  { id: 'T1', projectId: '1', name: 'Finalize Requirements Document', assignee: 'Julie Armstrong', assigneeType: 'Subcontractor', partnerId: 'PT1', dueDate: '2026-04-15', status: 'Done', priority: 'High' },
  // Internal tasks have no partner. partnerId is a nullable FK to project_partners;
  // omit it (-> NULL) rather than '' so the Postgres FK is satisfied (an empty
  // string is a non-NULL value with no matching partner row).
  { id: 'T2', projectId: '1', name: 'Design Database Schema', assignee: 'John Miller', assigneeType: 'Internal', dueDate: '2026-04-25', status: 'In Progress', priority: 'Medium' },
  { id: 'T3', projectId: '2', name: 'Setup CI/CD Pipeline', assignee: 'Unassigned', assigneeType: 'Internal', dueDate: '2026-05-05', status: 'To Do', priority: 'Medium' },
];

export const projectIssues: Issue[] = [
  // PHASE D — reportedBy/owner are PERSON references to the resources catalog. Reconcile
  // the orphan reportedBy names ('Jane Doe'/'John Smith'/'Alice Johnson') to existing
  // resources; owners were already valid resource names.
  { id: 'I1', projectId: '1', title: 'API Rate Limiting', type: 'Bug', severity: 'High', status: 'Open', reportedBy: 'Julie Armstrong', owner: 'Julie Armstrong', dueDate: '2026-05-15', impact: 'May slow integration testing', actionPlan: 'Add rate-limit handling and retry policy', escalated: true },
  { id: 'I2', projectId: '1', title: 'Delay in Hardware Delivery', type: 'Risk', severity: 'Medium', status: 'Mitigated', reportedBy: 'John Miller', owner: 'John Miller', dueDate: '2026-05-20', impact: 'Potential schedule slippage', actionPlan: 'Use cloud test environment until hardware arrives', escalated: false },
  { id: 'I3', projectId: '2', title: 'UI Inconsistencies', type: 'Bug', severity: 'Low', status: 'Open', reportedBy: 'Alice Smith', owner: 'Alice Smith', dueDate: '2026-06-01', impact: 'Client acceptance friction', actionPlan: 'Run design QA pass', escalated: false },
];

export const changeRequests: ChangeRequest[] = [
  { id: 'CR1', projectId: '1', title: 'Extend integration scope', description: 'Add one extra external API integration requested by the customer.', requestedBy: 'Julie Armstrong', owner: 'Alice Smith', status: 'Submitted', impactScope: 'Additional interface and test cycle', impactBudget: 12000, impactScheduleDays: 8, priority: 'High', createdAt: '2026-04-20T10:00:00.000Z' },
  { id: 'CR2', projectId: '2', title: 'Defer reporting automation', description: 'Move reporting automation to phase 2 to protect go-live.', requestedBy: 'John Miller', owner: 'Julie Armstrong', status: 'Approved', impactScope: 'Scope moved to later release', impactBudget: -5000, impactScheduleDays: -3, priority: 'Medium', createdAt: '2026-05-05T11:30:00.000Z', decidedBy: '1', decidedAt: '2026-05-06T09:00:00.000Z' },
];

// Configuration-level cost centers (B16)
// PHASE F2 — this catalog is the source for the project-cost-center `id` SELECT
// (selecting a cost center fills+locks the id and derives the name) and the
// resource-organizations `costCenters[]` multi-select. The CC-1001/1002/1003 rows
// are added so the seeded project cost centers (which reference those ids) resolve
// to a real catalog cost center and stay valid SELECT options.
export const costCenters: CostCenter[] = [
  // PHASE D — manager is a PERSON reference to the resources catalog; reconcile the
  // orphan names ('Dana White'/'Erik Stone') to existing resources.
  { id: 'CC-9001', name: 'Corporate IT', manager: 'Alice Smith', allocated: 200000, actual: 150000 },
  { id: 'CC-9002', name: 'Shared Services', manager: 'John Miller', allocated: 80000, actual: 64000 },
  { id: 'CC-1001', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
  { id: 'CC-1002', name: 'Design & UX', manager: 'John Miller', allocated: 50000, actual: 48000 },
  { id: 'CC-1003', name: 'Quality Assurance', manager: 'Julie Armstrong', allocated: 40000, actual: 42000 },
];

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

// PHASE F2 — `industry` is bound to the industries catalog (store = name) and
// `country` to the countries catalog (store = country NAME, matching the seeded
// display). 'Manufacturing' / 'Financial Services' are seeded industries ('Finance'
// -> 'Financial Services'); 'Germany' / 'United Kingdom' are seeded country names.
export const customers: Customer[] = [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
  { id: 'C2', name: 'Initech', industry: 'Financial Services', country: 'United Kingdom' },
];

export const contracts: Contract[] = [
  { id: 'CT1', customerId: 'C1', name: 'Globex Digital Transformation', type: 'Fixed Price', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  // MULTI-CURRENCY DEMO: CT2 (and its orders + billing items below) is denominated
  // in USD end-to-end, so portfolio rollups must convert via fx-rates before summing.
  { id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28' },
];

export const orders: Order[] = [
  // Customer orders carry no partner. partnerId is a nullable FK to
  // project_partners; omit it (-> NULL) rather than '' so the Postgres FK holds
  // (an empty string is a non-NULL value with no matching partner row). This
  // also matches the API rule that Customer orders must not set a partnerId.
  { id: 'O1', contractId: 'CT1', type: 'Customer', amount: 200000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-02-01', invoiceNumber: 'INV-2026-0001', invoiceDate: '2026-02-01' },
  { id: 'O2', contractId: 'CT1', type: 'Purchase', partnerId: 'PT1', amount: 50000, currency: 'EUR', status: 'Confirmed', orderDate: '2026-02-15' },
  // MULTI-CURRENCY DEMO: O3 belongs to USD contract CT2, so it carries USD too.
  { id: 'O3', contractId: 'CT2', type: 'Customer', amount: 120000, currency: 'USD', status: 'Open', orderDate: '2026-03-10' },
];

export const orderLines: OrderLine[] = [
  { id: 'OL1', orderId: 'O1', projectId: '1', description: 'Phase 1 delivery', amount: 200000 },
  { id: 'OL2', orderId: 'O2', projectId: '1', description: 'Subcontracted development', amount: 50000 },
  { id: 'OL3', orderId: 'O3', projectId: '2', description: 'UI/UX work package', amount: 120000 },
];

// One representative item PER BillingType, tied to existing contracts/projects.
// Milestone item points at an existing milestone ('M2' Go-Live on project '1').
export const billingPlanItems: BillingPlanItem[] = [
  { id: 'BP1', contractId: 'CT1', projectId: '1', type: 'Milestone', label: 'SAL Go-Live milestone', milestoneId: 'M2', expectedDate: '2026-12-01', amount: 150000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned' },
  // MULTI-CURRENCY DEMO: BP2/BP3/BP4/BP7 bill against USD contract CT2, so they are in USD.
  { id: 'BP2', contractId: 'CT2', projectId: '2', type: 'Recurring', label: 'Monthly retainer', recurrence: 'Monthly', expectedDate: '2026-03-31', amount: 12000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Invoiced', issuedDate: '2026-03-31', dueDate: '2026-04-30', orderId: 'O3' },
  { id: 'BP3', contractId: 'CT2', projectId: '2', type: 'TimeAndMaterials', label: 'T&M consuntivo Q1', expectedDate: '2026-04-15', amount: 28500, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Ready' },
  { id: 'BP4', contractId: 'CT2', projectId: '2', type: 'Capped', label: 'T&M capped work package', expectedDate: '2026-06-30', amount: 45000, capAmount: 50000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP5', contractId: 'CT1', projectId: '1', type: 'Advance', label: 'Down payment / acconto', expectedDate: '2026-01-15', amount: 100000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Paid', issuedDate: '2026-01-15', dueDate: '2026-02-14', paidDate: '2026-02-10', orderId: 'O1' },
  { id: 'BP6', contractId: 'CT1', projectId: '1', type: 'Progress', label: 'Progress billing (POC 60%)', progressPct: 60, expectedDate: '2026-07-01', amount: 90000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Ready' },
  { id: 'BP7', contractId: 'CT2', projectId: '2', type: 'Expense', label: 'Re-billed travel expenses', markupPct: 5, expectedDate: '2026-05-10', amount: 3200, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP8', contractId: 'CT1', projectId: '1', type: 'CreditNote', label: 'Credit note / nota di credito', expectedDate: '2026-08-01', amount: -5000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned', notes: 'Adjustment for descoped feature' },
];

// --- Multi-currency foundation ----------------------------------------------

/**
 * FX rates expressed as the base-currency (EUR) value of 1 unit of `currency`.
 * EUR is the base, so its rateToBase is 1. Rollups that span currencies must
 * convert each amount via `amount * rateToBase` before summing.
 */
export const fxRates: FxRate[] = [
  { currency: 'EUR', rateToBase: 1 },
  { currency: 'USD', rateToBase: 0.92 },
  { currency: 'GBP', rateToBase: 1.17 },
];

// --- Approval workflow engine -----------------------------------------------

/**
 * Seeded approval requests. In server.ts these are produced by a `seed()`
 * helper that materialises the server-derived fields from the static input:
 *   - status      -> always 'Pending' at seed time
 *   - steps        -> buildApprovalSteps(kind, amount): a high-value item
 *                     (amount > 50000) routes to ['delivery-executive',
 *                     'finance']; otherwise a single approver is chosen by kind
 *                     (TimeEntry/Expense -> resource-manager;
 *                      Milestone/ChangeRequest -> delivery-executive;
 *                      Invoice -> finance). Each step starts 'Pending'.
 *   - currentStep  -> 0
 *   - slaDueAt     -> createdAt + 3 days (APPROVAL_SLA_DAYS), ISO string
 * The derived values are inlined here verbatim so the seed is self-contained
 * and does not depend on server.ts internals.
 */
export const approvalRequests: ApprovalRequest[] = [
  // AR1: TimeEntry, no amount -> single resource-manager step. SLA = createdAt + 3d.
  { id: 'AR1', kind: 'TimeEntry', refId: 'TE3', projectId: '1', requestedBy: '1', createdAt: '2026-04-08T16:00:00.000Z', note: 'Submitted hours pending approval',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-04-11T16:00:00.000Z',
    steps: [{ role: 'resource-manager', status: 'Pending' }] },
  // AR2: Invoice, amount 120000 > 50000 -> high-value chain delivery-executive then finance.
  { id: 'AR2', kind: 'Invoice', refId: 'O3', projectId: '2', amount: 120000, requestedBy: '5', createdAt: '2026-03-11T09:00:00.000Z', note: 'Customer invoice over high-value threshold',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-03-14T09:00:00.000Z',
    steps: [{ role: 'delivery-executive', status: 'Pending' }, { role: 'finance', status: 'Pending' }] },
  // AR3: ChangeRequest, amount 12000 (not high-value) -> single delivery-executive step.
  { id: 'AR3', kind: 'ChangeRequest', refId: 'CR1', projectId: '1', amount: 12000, requestedBy: '3', createdAt: '2026-04-20T10:30:00.000Z', note: 'Scope extension awaiting delivery sign-off',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-04-23T10:30:00.000Z',
    steps: [{ role: 'delivery-executive', status: 'Pending' }] },
];

// --- Audit log --------------------------------------------------------------

/**
 * The audit log is APPEND-ONLY and starts EMPTY: server.ts initialises
 * `auditLogStore` as `{ items: [] }` and only ever prepends runtime entries.
 */
export const auditLogs: AuditLog[] = [];
