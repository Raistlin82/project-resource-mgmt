import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-config';

export interface Resource {
  id: string;
  name: string;
  role: string;
  skills: { name: string; level: number }[];
  projectRoles: string[];
  externalExperience: { projectName: string; company: string; role: string; startDate: string; endDate: string; comment?: string }[];
  profilePicture?: string;
  resume?: string;
  utilization: number;
  capacity: number;
  managerId?: string;
  organization?: string;
  location?: string;
  costRate?: number;
  billRate?: number;
  /**
   * Date the resource was hired (data di assunzione), ISO 'YYYY-MM-DD'.
   * REQUIRED at create time (the server rejects a missing/invalid value), but
   * declared optional here for back-compat with pre-existing seeds/rows that
   * predate the field.
   */
  hireDate?: string;
  /**
   * Date the resource's contract was terminated (data di cessazione), ISO
   * 'YYYY-MM-DD'. Optional. A resource is considered TERMINATED when this is set
   * to a date on or before today, and ACTIVE otherwise. Logical deletion only —
   * resources are never hard-deleted; clearing this (null/empty) reactivates.
   */
  terminationDate?: string;
}

export interface ResourceRequest {
  id: string;
  name: string;
  requiredRole: string;
  requiredEffort: number;
  staffedEffort?: number;
  status: string;
  skills: string[];
  description?: string;
  startDate?: string;
  endDate?: string;
  requesterId?: string;
  projectId?: string;
}

export interface Assignment {
  id: string;
  requestId: string;
  resourceId: string;
  assignedHours: number;
  status: string;
  /** ISO booking start (YYYY-MM-DD). Falls back to the linked request's startDate when absent. */
  startDate?: string;
  /** ISO booking end (YYYY-MM-DD). Falls back to the linked request's endDate when absent. */
  endDate?: string;
  /** Percentage of the resource's weekly capacity this booking consumes. Defaults to 100. */
  allocationPct?: number;
}

export type UserRole = 'employee' | 'pm' | 'resource-manager' | 'delivery-executive' | 'finance' | 'sales' | 'admin';

export interface User {
  id: string;
  resourceId: string;
  name: string;
  role: UserRole;
}

export interface Language {
  code: string;
  name: string;
  isDefault: boolean;
}

export interface SkillCatalog {
  id: string;
  name: string;
  description: string;
  skills: string[];
}

export interface ProficiencyLevel {
  id: string;
  level: number;
  name: string;
  description: string;
}

export interface ProficiencySet {
  id: string;
  name: string;
  description: string;
  levels: ProficiencyLevel[];
}

export interface Skill {
  id: string;
  conceptUri: string;
  name: string;
  description: string;
  catalogs: string[];
  proficiencySetId?: string;
  restricted: boolean;
}

export interface ProjectRole {
  id: string;
  code: string;
  name: string;
  description: string;
  restricted: boolean;
}

export interface ServiceOrganization {
  id: string;
  code: string;
  description: string;
  costCenters: string[];
}

export interface ResourceOrganization {
  id: string;
  name: string;
  description: string;
  costCenters: string[];
  serviceOrganizationId?: string;
}

// --- Customizing catalogs (Phase F1 — additive reference data) ---
// These are simple keyed catalogs that F2 will bind consumer fields to (Resource
// location/organization, Customer industry/country, financial-plan category,
// project-partner role/company). Added here additively; no existing consumer is
// rewired yet.

/** A country, keyed by its ISO 3166-1 alpha-2 code (the id IS the code). */
export interface Country {
  /** ISO-2 code (e.g. 'IT'); doubles as the primary key. */
  code: string;
  name: string;
}

/** A city/comune belonging to a {@link Country} (FK by country code). */
export interface City {
  id: string;
  name: string;
  /** FK -> Country.code. */
  countryCode: string;
}

/** A customer industry sector (e.g. 'Technology'). */
export interface Industry {
  id: string;
  name: string;
}

/** A financial-plan cost category (e.g. 'Labor', 'Travel & Expenses'). */
export interface CostCategory {
  id: string;
  name: string;
}

/** A project-partner relationship role (e.g. 'Subcontractor', 'Reseller'). */
export interface PartnerRole {
  id: string;
  name: string;
}

/** A partner/supplier company in the vendor catalog. */
export interface Vendor {
  id: string;
  name: string;
  vatId?: string;
  country?: string;
}

export interface Project {
  id: string;
  name: string;
  location: string;
  startDate: string;
  endDate: string;
  status: string;
  description?: string;
  ownerId?: string;
  contractId?: string;
}

// --- Project sub-resources (shared types; import these, do not redefine locally) ---

export interface Partner {
  id: string;
  projectId: string;
  company: string;
  role: string;
  contact: string;
  status: string;
}

export interface ProjectDocument {
  id: string;
  projectId: string;
  name: string;
  type: string;
  size: string;
  uploadedAt: string;
  author: string;
  authorInitials: string;
}

export interface WorkPackage {
  id: string;
  projectId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'Planned' | 'In Progress' | 'Completed';
  progress: number;
  assignee: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  date: string;
  status: 'Pending' | 'Achieved';
  approvedBy?: string;
  approvedAt?: string;
}

export interface FinancialItem {
  id: string;
  projectId: string;
  category: string;
  budget: number;
  actual: number;
}

export interface ProjectCostCenter {
  id: string;
  projectId: string;
  name: string;
  manager: string;
  allocated: number;
  actual: number;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  assignee: string;
  assigneeType?: 'Internal' | 'Subcontractor';
  partnerId?: string;
  dueDate: string;
  status: string;
  priority: string;
}

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  type: string;
  severity: string;
  status: string;
  reportedBy: string;
  owner?: string;
  dueDate?: string;
  impact?: string;
  actionPlan?: string;
  escalated?: boolean;
}

export interface CostCenter {
  id: string;
  name: string;
  manager: string;
  allocated: number;
  actual: number;
}

// --- Commercial domain (ADR-0001) ---

export interface Customer {
  id: string;
  name: string;
  industry?: string;
  country?: string;
}

export interface Contract {
  id: string;
  customerId: string;
  name: string;
  type: 'T&M' | 'Fixed Price' | 'Framework';
  totalValue: number;
  currency: string;
  status: 'Draft' | 'Active' | 'Closed';
  startDate: string;
  endDate: string;
}

export interface Order {
  id: string;
  contractId: string;
  type: 'Customer' | 'Purchase';
  partnerId?: string;
  amount: number;
  currency: string;
  status: 'Open' | 'Confirmed' | 'Invoiced' | 'Paid';
  orderDate: string;
  // SERVER-SET (never accepted from client): a sequential, compliant invoice
  // number (e.g. 'INV-2026-0001') and its date, assigned when an order first
  // transitions to status 'Invoiced'.
  invoiceNumber?: string;
  invoiceDate?: string;
}

export interface OrderLine {
  id: string;
  orderId: string;
  projectId: string;
  description: string;
  amount: number;
}

export type BillingType =
  | 'Milestone'          // SAL — fixed-price, triggered by a project Milestone
  | 'Recurring'          // retainer billed on a fixed cadence
  | 'TimeAndMaterials'   // as-incurred: approved hours x billRate
  | 'Capped'             // T&M not-to-exceed (cap)
  | 'Advance'            // down payment taken up front
  | 'Progress'           // percentage of completion (POC)
  | 'Expense'            // pass-through / re-invoiced expenses
  | 'CreditNote';        // nota di credito (negative)

export interface BillingPlanItem {
  id: string;
  contractId: string;
  projectId?: string;
  type: BillingType;
  label: string;
  milestoneId?: string;                                  // Milestone
  recurrence?: 'Monthly' | 'Quarterly' | 'Annual';       // Recurring
  expectedDate?: string;
  amount: number;                                        // base; negative ONLY for CreditNote
  capAmount?: number;                                    // Capped
  progressPct?: number;                                  // Progress (0-100)
  markupPct?: number;                                    // Expense markup
  retentionPct?: number;                                 // ritenuta a garanzia
  taxRatePct?: number;                                   // IVA
  paymentTermsDays?: number;                             // net terms
  currency: string;
  status: 'Planned' | 'Ready' | 'Invoiced' | 'Paid' | 'Blocked';
  issuedDate?: string;
  dueDate?: string;
  paidDate?: string;
  orderId?: string;                                      // generated invoice/order
  notes?: string;
}

export interface TimeEntry {
  id: string;
  assignmentId: string;
  requestId: string;
  resourceId: string;
  projectId: string;
  date: string;
  hours: number;
  status: 'Draft' | 'Submitted' | 'Approved' | 'Rejected';
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ChangeRequest {
  id: string;
  projectId: string;
  title: string;
  description: string;
  requestedBy: string;
  owner: string;
  status: 'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Implemented';
  impactScope: string;
  impactBudget: number;
  impactScheduleDays: number;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

// --- Approval workflow engine ---

export type ApprovalKind = 'TimeEntry' | 'Expense' | 'Milestone' | 'ChangeRequest' | 'Invoice';
export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected';

export interface ApprovalStep {
  role: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
}

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  refId: string;
  projectId?: string;
  amount?: number;
  requestedBy: string;
  status: ApprovalStatus;
  steps: ApprovalStep[];
  currentStep: number;
  createdAt: string;
  slaDueAt?: string;
  note?: string;
}

export interface AuditLog {
  id: string;
  at: string;
  actorId: string;
  actorRole: UserRole | 'unknown';
  method: string;
  path: string;
  statusCode: number;
  // AUDIT INTEGRITY: append-only entries capture which keys changed on a
  // PUT/DELETE mutation, with before/after snapshots of just those keys.
  changedKeys?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

// --- Multi-currency foundation ---

/** The reporting/base currency all monetary rollups normalise to. */
export const BASE_CURRENCY = 'EUR';

/**
 * Exchange rate for a single currency, expressed as the base-currency value of
 * 1 unit of `currency`. The base currency (EUR) therefore has rateToBase = 1.
 * To convert an amount into the base currency: amount * rateToBase.
 */
export interface FxRate {
  currency: string;
  rateToBase: number;
}

// --- Integrations (local-artifact adapters: implemented, NOT connected) ---

/** The four supported integration kinds. */
export type IntegrationKind = 'erp' | 'einvoice' | 'crm' | 'bi';

/** Server-side adapter self-description (mirror of the server contract). */
export interface IntegrationDescriptor {
  kind: IntegrationKind;
  key: string;
  name: string;
  description: string;
  /** Always false today: local-artifact adapters never contact external systems. */
  connected: boolean;
  mode: 'local-artifact';
}

/** GET /integrations response: active descriptors + per-kind active key. */
export interface IntegrationsInfo {
  adapters: IntegrationDescriptor[];
  active: Record<IntegrationKind, string>;
}

/** CRM account record inside a prepared sync payload. */
export interface CrmOutboxAccount {
  externalId: string;
  name: string;
  industry?: string;
  country?: string;
}

/** Condensed order nested under a CRM deal. */
export interface CrmOutboxOrder {
  id: string;
  type: string;
  amount: number;
  status: string;
}

/** CRM deal record inside a prepared sync payload. */
export interface CrmOutboxDeal {
  externalId: string;
  accountExternalId: string;
  name: string;
  value: number;
  currency: string;
  stage: string;
  orders: CrmOutboxOrder[];
}

/**
 * One prepared (never sent) CRM sync payload. The server keeps these in an
 * intentionally ephemeral in-memory outbox (demo state, cleared on restart).
 */
export interface CrmOutboxEntry {
  id?: string;
  preparedAt: string;
  status: string;
  target: string;
  payload: { accounts: CrmOutboxAccount[]; deals: CrmOutboxDeal[] };
}

/** A single cell of the BI feed (primitives only). */
export type BiFeedCell = string | number | boolean | null;

/** GET /integrations/bi/feed response: flat per-project financial rows. */
export interface BiFeedPreview {
  generatedAt: string;
  rowCount: number;
  rows: Record<string, BiFeedCell>[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = inject(API_BASE_URL);

  getResources(): Observable<Resource[]> {
    return this.http.get<Resource[]>(`${this.baseUrl}/resources`);
  }

  getUsers(): Observable<User[]> {
    return this.http.get<User[]>(`${this.baseUrl}/users`);
  }

  getResource(id: string): Observable<Resource> {
    return this.http.get<Resource>(`${this.baseUrl}/resources/${id}`);
  }

  /** Onboard a new employee (creazione). `hireDate` is required server-side. */
  createResource(data: Partial<Resource>): Observable<Resource> {
    return this.http.post<Resource>(`${this.baseUrl}/resources`, data);
  }

  /**
   * Edit (modifica) or terminate/reactivate (cessazione logica) a resource.
   * Terminate = set `terminationDate`; reactivate = send `terminationDate: null`.
   */
  updateResource(id: string, data: Partial<Resource>): Observable<Resource> {
    return this.http.put<Resource>(`${this.baseUrl}/resources/${id}`, data);
  }

  getRequests(): Observable<ResourceRequest[]> {
    return this.http.get<ResourceRequest[]>(`${this.baseUrl}/requests`);
  }

  createRequest(request: Partial<ResourceRequest>): Observable<ResourceRequest> {
    return this.http.post<ResourceRequest>(`${this.baseUrl}/requests`, request);
  }

  updateRequest(id: string, request: Partial<ResourceRequest>): Observable<ResourceRequest> {
    return this.http.put<ResourceRequest>(`${this.baseUrl}/requests/${id}`, request);
  }

  deleteRequest(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/requests/${id}`);
  }

  getAssignments(): Observable<Assignment[]> {
    return this.http.get<Assignment[]>(`${this.baseUrl}/assignments`);
  }

  createAssignment(assignment: Partial<Assignment>): Observable<Assignment> {
    return this.http.post<Assignment>(`${this.baseUrl}/assignments`, assignment);
  }

  updateAssignment(id: string, assignment: Partial<Assignment>): Observable<Assignment> {
    return this.http.put<Assignment>(`${this.baseUrl}/assignments/${id}`, assignment);
  }

  deleteAssignment(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/assignments/${id}`);
  }

  // --- Configuration APIs ---

  getLanguages(): Observable<Language[]> {
    return this.http.get<Language[]>(`${this.baseUrl}/languages`);
  }

  setDefaultLanguage(code: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/languages/default`, { code });
  }

  getSkillCatalogs(): Observable<SkillCatalog[]> {
    return this.http.get<SkillCatalog[]>(`${this.baseUrl}/skill-catalogs`);
  }

  createSkillCatalog(catalog: Partial<SkillCatalog>): Observable<SkillCatalog> {
    return this.http.post<SkillCatalog>(`${this.baseUrl}/skill-catalogs`, catalog);
  }

  updateSkillCatalog(id: string, catalog: Partial<SkillCatalog>): Observable<SkillCatalog> {
    return this.http.put<SkillCatalog>(`${this.baseUrl}/skill-catalogs/${id}`, catalog);
  }

  deleteSkillCatalog(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/skill-catalogs/${id}`);
  }

  getProficiencySets(): Observable<ProficiencySet[]> {
    return this.http.get<ProficiencySet[]>(`${this.baseUrl}/proficiency-sets`);
  }

  createProficiencySet(set: Partial<ProficiencySet>): Observable<ProficiencySet> {
    return this.http.post<ProficiencySet>(`${this.baseUrl}/proficiency-sets`, set);
  }

  deleteProficiencySet(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/proficiency-sets/${id}`);
  }

  getSkills(): Observable<Skill[]> {
    return this.http.get<Skill[]>(`${this.baseUrl}/skills`);
  }

  createSkill(skill: Partial<Skill>): Observable<Skill> {
    return this.http.post<Skill>(`${this.baseUrl}/skills`, skill);
  }

  updateSkill(id: string, skill: Partial<Skill>): Observable<Skill> {
    return this.http.put<Skill>(`${this.baseUrl}/skills/${id}`, skill);
  }

  deleteSkill(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/skills/${id}`);
  }

  getProjectRoles(): Observable<ProjectRole[]> {
    return this.http.get<ProjectRole[]>(`${this.baseUrl}/project-roles`);
  }

  createProjectRole(role: Partial<ProjectRole>): Observable<ProjectRole> {
    return this.http.post<ProjectRole>(`${this.baseUrl}/project-roles`, role);
  }

  updateProjectRole(id: string, role: Partial<ProjectRole>): Observable<ProjectRole> {
    return this.http.put<ProjectRole>(`${this.baseUrl}/project-roles/${id}`, role);
  }

  getServiceOrganizations(): Observable<ServiceOrganization[]> {
    return this.http.get<ServiceOrganization[]>(`${this.baseUrl}/service-organizations`);
  }

  getResourceOrganizations(): Observable<ResourceOrganization[]> {
    return this.http.get<ResourceOrganization[]>(`${this.baseUrl}/resource-organizations`);
  }

  createResourceOrganization(org: Partial<ResourceOrganization>): Observable<ResourceOrganization> {
    return this.http.post<ResourceOrganization>(`${this.baseUrl}/resource-organizations`, org);
  }

  updateResourceOrganization(id: string, org: Partial<ResourceOrganization>): Observable<ResourceOrganization> {
    return this.http.put<ResourceOrganization>(`${this.baseUrl}/resource-organizations/${id}`, org);
  }

  deleteResourceOrganization(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/resource-organizations/${id}`);
  }

  // --- Customizing catalogs (Phase F1 — additive reference data) ---

  getCountries(): Observable<Country[]> { return this.http.get<Country[]>(`${this.baseUrl}/countries`); }
  createCountry(c: Partial<Country>): Observable<Country> { return this.http.post<Country>(`${this.baseUrl}/countries`, c); }
  updateCountry(code: string, c: Partial<Country>): Observable<Country> { return this.http.put<Country>(`${this.baseUrl}/countries/${code}`, c); }
  deleteCountry(code: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/countries/${code}`); }

  getCities(): Observable<City[]> { return this.http.get<City[]>(`${this.baseUrl}/cities`); }
  createCity(c: Partial<City>): Observable<City> { return this.http.post<City>(`${this.baseUrl}/cities`, c); }
  updateCity(id: string, c: Partial<City>): Observable<City> { return this.http.put<City>(`${this.baseUrl}/cities/${id}`, c); }
  deleteCity(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cities/${id}`); }

  getIndustries(): Observable<Industry[]> { return this.http.get<Industry[]>(`${this.baseUrl}/industries`); }
  createIndustry(i: Partial<Industry>): Observable<Industry> { return this.http.post<Industry>(`${this.baseUrl}/industries`, i); }
  updateIndustry(id: string, i: Partial<Industry>): Observable<Industry> { return this.http.put<Industry>(`${this.baseUrl}/industries/${id}`, i); }
  deleteIndustry(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/industries/${id}`); }

  getCostCategories(): Observable<CostCategory[]> { return this.http.get<CostCategory[]>(`${this.baseUrl}/cost-categories`); }
  createCostCategory(c: Partial<CostCategory>): Observable<CostCategory> { return this.http.post<CostCategory>(`${this.baseUrl}/cost-categories`, c); }
  updateCostCategory(id: string, c: Partial<CostCategory>): Observable<CostCategory> { return this.http.put<CostCategory>(`${this.baseUrl}/cost-categories/${id}`, c); }
  deleteCostCategory(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cost-categories/${id}`); }

  getPartnerRoles(): Observable<PartnerRole[]> { return this.http.get<PartnerRole[]>(`${this.baseUrl}/partner-roles`); }
  createPartnerRole(r: Partial<PartnerRole>): Observable<PartnerRole> { return this.http.post<PartnerRole>(`${this.baseUrl}/partner-roles`, r); }
  updatePartnerRole(id: string, r: Partial<PartnerRole>): Observable<PartnerRole> { return this.http.put<PartnerRole>(`${this.baseUrl}/partner-roles/${id}`, r); }
  deletePartnerRole(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/partner-roles/${id}`); }

  getVendors(): Observable<Vendor[]> { return this.http.get<Vendor[]>(`${this.baseUrl}/vendors`); }
  createVendor(v: Partial<Vendor>): Observable<Vendor> { return this.http.post<Vendor>(`${this.baseUrl}/vendors`, v); }
  updateVendor(id: string, v: Partial<Vendor>): Observable<Vendor> { return this.http.put<Vendor>(`${this.baseUrl}/vendors/${id}`, v); }
  deleteVendor(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/vendors/${id}`); }

  getProjects(): Observable<Project[]> {
    return this.http.get<Project[]>(`${this.baseUrl}/projects`);
  }

  createProject(project: Partial<Project>): Observable<Project> {
    return this.http.post<Project>(`${this.baseUrl}/projects`, project);
  }

  updateProject(id: string, project: Partial<Project>): Observable<Project> {
    return this.http.put<Project>(`${this.baseUrl}/projects/${id}`, project);
  }

  deleteProject(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/projects/${id}`);
  }

  // --- Project sub-resources (B1: real persistence) ---

  getProjectPartners(): Observable<Partner[]> { return this.http.get<Partner[]>(`${this.baseUrl}/project-partners`); }
  createProjectPartner(p: Partial<Partner>): Observable<Partner> { return this.http.post<Partner>(`${this.baseUrl}/project-partners`, p); }
  updateProjectPartner(id: string, p: Partial<Partner>): Observable<Partner> { return this.http.put<Partner>(`${this.baseUrl}/project-partners/${id}`, p); }
  deleteProjectPartner(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-partners/${id}`); }

  getProjectDocuments(): Observable<ProjectDocument[]> { return this.http.get<ProjectDocument[]>(`${this.baseUrl}/project-documents`); }
  createProjectDocument(d: Partial<ProjectDocument>): Observable<ProjectDocument> { return this.http.post<ProjectDocument>(`${this.baseUrl}/project-documents`, d); }
  deleteProjectDocument(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-documents/${id}`); }

  getWorkPackages(): Observable<WorkPackage[]> { return this.http.get<WorkPackage[]>(`${this.baseUrl}/work-packages`); }
  createWorkPackage(w: Partial<WorkPackage>): Observable<WorkPackage> { return this.http.post<WorkPackage>(`${this.baseUrl}/work-packages`, w); }
  updateWorkPackage(id: string, w: Partial<WorkPackage>): Observable<WorkPackage> { return this.http.put<WorkPackage>(`${this.baseUrl}/work-packages/${id}`, w); }

  getMilestones(): Observable<Milestone[]> { return this.http.get<Milestone[]>(`${this.baseUrl}/milestones`); }
  createMilestone(m: Partial<Milestone>): Observable<Milestone> { return this.http.post<Milestone>(`${this.baseUrl}/milestones`, m); }
  updateMilestone(id: string, m: Partial<Milestone>): Observable<Milestone> { return this.http.put<Milestone>(`${this.baseUrl}/milestones/${id}`, m); }

  getProjectFinancials(): Observable<FinancialItem[]> { return this.http.get<FinancialItem[]>(`${this.baseUrl}/project-financials`); }
  createProjectFinancial(f: Partial<FinancialItem>): Observable<FinancialItem> { return this.http.post<FinancialItem>(`${this.baseUrl}/project-financials`, f); }
  updateProjectFinancial(id: string, f: Partial<FinancialItem>): Observable<FinancialItem> { return this.http.put<FinancialItem>(`${this.baseUrl}/project-financials/${id}`, f); }
  deleteProjectFinancial(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-financials/${id}`); }

  getProjectCostCenters(): Observable<ProjectCostCenter[]> { return this.http.get<ProjectCostCenter[]>(`${this.baseUrl}/project-cost-centers`); }
  createProjectCostCenter(c: Partial<ProjectCostCenter>): Observable<ProjectCostCenter> { return this.http.post<ProjectCostCenter>(`${this.baseUrl}/project-cost-centers`, c); }
  updateProjectCostCenter(id: string, c: Partial<ProjectCostCenter>): Observable<ProjectCostCenter> { return this.http.put<ProjectCostCenter>(`${this.baseUrl}/project-cost-centers/${id}`, c); }
  deleteProjectCostCenter(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-cost-centers/${id}`); }

  getProjectTasks(): Observable<Task[]> { return this.http.get<Task[]>(`${this.baseUrl}/project-tasks`); }
  createProjectTask(t: Partial<Task>): Observable<Task> { return this.http.post<Task>(`${this.baseUrl}/project-tasks`, t); }
  updateProjectTask(id: string, t: Partial<Task>): Observable<Task> { return this.http.put<Task>(`${this.baseUrl}/project-tasks/${id}`, t); }

  getProjectIssues(): Observable<Issue[]> { return this.http.get<Issue[]>(`${this.baseUrl}/project-issues`); }
  createProjectIssue(i: Partial<Issue>): Observable<Issue> { return this.http.post<Issue>(`${this.baseUrl}/project-issues`, i); }
  updateProjectIssue(id: string, i: Partial<Issue>): Observable<Issue> { return this.http.put<Issue>(`${this.baseUrl}/project-issues/${id}`, i); }

  getChangeRequests(): Observable<ChangeRequest[]> { return this.http.get<ChangeRequest[]>(`${this.baseUrl}/change-requests`); }
  createChangeRequest(c: Partial<ChangeRequest>): Observable<ChangeRequest> { return this.http.post<ChangeRequest>(`${this.baseUrl}/change-requests`, c); }
  updateChangeRequest(id: string, c: Partial<ChangeRequest>): Observable<ChangeRequest> { return this.http.put<ChangeRequest>(`${this.baseUrl}/change-requests/${id}`, c); }
  deleteChangeRequest(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/change-requests/${id}`); }

  getCostCenters(): Observable<CostCenter[]> { return this.http.get<CostCenter[]>(`${this.baseUrl}/cost-centers`); }
  createCostCenter(c: Partial<CostCenter>): Observable<CostCenter> { return this.http.post<CostCenter>(`${this.baseUrl}/cost-centers`, c); }
  updateCostCenter(id: string, c: Partial<CostCenter>): Observable<CostCenter> { return this.http.put<CostCenter>(`${this.baseUrl}/cost-centers/${id}`, c); }
  deleteCostCenter(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cost-centers/${id}`); }

  // --- Commercial domain (ADR-0001) ---

  getCustomers(): Observable<Customer[]> { return this.http.get<Customer[]>(`${this.baseUrl}/customers`); }
  createCustomer(c: Partial<Customer>): Observable<Customer> { return this.http.post<Customer>(`${this.baseUrl}/customers`, c); }
  updateCustomer(id: string, c: Partial<Customer>): Observable<Customer> { return this.http.put<Customer>(`${this.baseUrl}/customers/${id}`, c); }
  deleteCustomer(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/customers/${id}`); }

  getContracts(): Observable<Contract[]> { return this.http.get<Contract[]>(`${this.baseUrl}/contracts`); }
  createContract(c: Partial<Contract>): Observable<Contract> { return this.http.post<Contract>(`${this.baseUrl}/contracts`, c); }
  updateContract(id: string, c: Partial<Contract>): Observable<Contract> { return this.http.put<Contract>(`${this.baseUrl}/contracts/${id}`, c); }
  deleteContract(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/contracts/${id}`); }

  getOrders(): Observable<Order[]> { return this.http.get<Order[]>(`${this.baseUrl}/orders`); }
  createOrder(o: Partial<Order>): Observable<Order> { return this.http.post<Order>(`${this.baseUrl}/orders`, o); }
  updateOrder(id: string, o: Partial<Order>): Observable<Order> { return this.http.put<Order>(`${this.baseUrl}/orders/${id}`, o); }
  deleteOrder(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/orders/${id}`); }

  getOrderLines(): Observable<OrderLine[]> { return this.http.get<OrderLine[]>(`${this.baseUrl}/order-lines`); }
  createOrderLine(l: Partial<OrderLine>): Observable<OrderLine> { return this.http.post<OrderLine>(`${this.baseUrl}/order-lines`, l); }
  updateOrderLine(id: string, l: Partial<OrderLine>): Observable<OrderLine> { return this.http.put<OrderLine>(`${this.baseUrl}/order-lines/${id}`, l); }
  deleteOrderLine(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/order-lines/${id}`); }

  getBillingPlanItems(): Observable<BillingPlanItem[]> { return this.http.get<BillingPlanItem[]>(`${this.baseUrl}/billing-plan-items`); }
  createBillingPlanItem(i: Partial<BillingPlanItem>): Observable<BillingPlanItem> { return this.http.post<BillingPlanItem>(`${this.baseUrl}/billing-plan-items`, i); }
  updateBillingPlanItem(id: string, i: Partial<BillingPlanItem>): Observable<BillingPlanItem> { return this.http.put<BillingPlanItem>(`${this.baseUrl}/billing-plan-items/${id}`, i); }
  deleteBillingPlanItem(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/billing-plan-items/${id}`); }

  getTimeEntries(): Observable<TimeEntry[]> { return this.http.get<TimeEntry[]>(`${this.baseUrl}/time-entries`); }
  createTimeEntry(t: Partial<TimeEntry>): Observable<TimeEntry> { return this.http.post<TimeEntry>(`${this.baseUrl}/time-entries`, t); }
  updateTimeEntry(id: string, t: Partial<TimeEntry>): Observable<TimeEntry> { return this.http.put<TimeEntry>(`${this.baseUrl}/time-entries/${id}`, t); }
  deleteTimeEntry(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/time-entries/${id}`); }

  // --- Approval workflow engine ---

  getApprovalRequests(): Observable<ApprovalRequest[]> { return this.http.get<ApprovalRequest[]>(`${this.baseUrl}/approval-requests`); }
  createApprovalRequest(a: Partial<ApprovalRequest>): Observable<ApprovalRequest> { return this.http.post<ApprovalRequest>(`${this.baseUrl}/approval-requests`, a); }
  decideApprovalRequest(id: string, decision: 'Approved' | 'Rejected', by: string): Observable<ApprovalRequest> {
    return this.http.put<ApprovalRequest>(`${this.baseUrl}/approval-requests/${id}/decision`, { decision, by });
  }

  getAuditLogs(): Observable<AuditLog[]> { return this.http.get<AuditLog[]>(`${this.baseUrl}/audit-logs`); }

  // --- Multi-currency foundation ---

  getFxRates(): Observable<FxRate[]> { return this.http.get<FxRate[]>(`${this.baseUrl}/fx-rates`); }

  // --- Integrations (local-artifact adapters: implemented, NOT connected) ---

  getIntegrations(): Observable<IntegrationsInfo> { return this.http.get<IntegrationsInfo>(`${this.baseUrl}/integrations`); }

  getCrmOutbox(): Observable<CrmOutboxEntry[]> { return this.http.get<CrmOutboxEntry[]>(`${this.baseUrl}/integrations/crm/outbox`); }

  prepareCrmSync(): Observable<CrmOutboxEntry> { return this.http.post<CrmOutboxEntry>(`${this.baseUrl}/integrations/crm/outbox`, {}); }

  getBiFeedPreview(): Observable<BiFeedPreview> { return this.http.get<BiFeedPreview>(`${this.baseUrl}/integrations/bi/feed`); }

  /** URL of the ERP GL-journal export download (the page fetch-blobs it). */
  erpJournalExportUrl(format: 'csv' | 'json'): string {
    return `${this.baseUrl}/integrations/erp/journal-export?format=${format}`;
  }

  /** URL of the FatturaPA XML download for an invoiced order (fetch-blob). */
  einvoiceXmlUrl(orderId: string): string {
    return `${this.baseUrl}/integrations/einvoice/orders/${encodeURIComponent(orderId)}`;
  }
}
