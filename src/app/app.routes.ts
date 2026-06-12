import { Routes } from '@angular/router';
import { commercialGuard, financeGuard, roleGuard } from './guards/role.guard';

export const routes: Routes = [
  // Resource Management
  { path: '', title: 'Dashboard', loadComponent: () => import('./dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'profile', title: 'My Profile', loadComponent: () => import('./my-profile/my-profile.component').then(m => m.MyProfileComponent) },
  { path: 'assignments', title: 'My Assignments', loadComponent: () => import('./my-assignments/my-assignments.component').then(m => m.MyAssignmentsComponent) },
  { path: 'requests', title: 'Resource Requests', loadComponent: () => import('./resource-requests/resource-requests.component').then(m => m.ResourceRequestsComponent) },
  { path: 'resources', title: 'Resources', canMatch: [roleGuard(a => a.hasAnyRole(['resource-manager', 'delivery-executive', 'admin']))], loadComponent: () => import('./resources/resources.component').then(m => m.ResourcesComponent) },
  { path: 'staffing', title: 'Staffing', loadComponent: () => import('./staffing/staffing.component').then(m => m.StaffingComponent) },
  { path: 'schedule', title: 'Schedule', canMatch: [roleGuard(a => a.hasAnyRole(['pm', 'resource-manager', 'delivery-executive', 'admin']))], loadComponent: () => import('./schedule/schedule.component').then(m => m.ScheduleComponent) },
  { path: 'utilization', title: 'Utilization', loadComponent: () => import('./utilization/utilization.component').then(m => m.UtilizationComponent) },
  { path: 'forecast', title: 'Forecast', loadComponent: () => import('./forecast/forecast').then(m => m.Forecast) },
  { path: 'what-if', title: 'What-if Analysis', loadComponent: () => import('./forecast/what-if').then(m => m.WhatIf) },
  { path: 'approvals', title: 'Approvals', loadComponent: () => import('./approvals/approvals').then(m => m.Approvals) },

  // Project Management
  { path: 'projects', title: 'Projects', loadComponent: () => import('./projects/projects/projects').then(m => m.ProjectsComponent) },
  { path: 'projects/:id', title: 'Project Details', loadComponent: () => import('./projects/project-details/project-details').then(m => m.ProjectDetailsComponent) },
  { path: 'project-partners', title: 'Project Partners', loadComponent: () => import('./projects/project-partners/project-partners').then(m => m.ProjectPartners) },
  { path: 'project-documents', title: 'Project Documents', loadComponent: () => import('./projects/project-documents/project-documents').then(m => m.ProjectDocuments) },
  { path: 'project-plans', title: 'Project Plans', loadComponent: () => import('./projects/project-plans/project-plans').then(m => m.ProjectPlans) },
  { path: 'financial-plans', title: 'Financial Plans', loadComponent: () => import('./projects/financial-plans/financial-plans').then(m => m.FinancialPlans) },
  { path: 'project-cost-centers', title: 'Project Cost Centers', loadComponent: () => import('./projects/project-cost-centers/project-cost-centers').then(m => m.ProjectCostCenters) },
  { path: 'project-tasks', title: 'Tasks', loadComponent: () => import('./projects/project-tasks/project-tasks').then(m => m.ProjectTasks) },
  { path: 'project-issues', title: 'Issues', loadComponent: () => import('./projects/project-issues/project-issues').then(m => m.ProjectIssues) },
  { path: 'change-requests', title: 'Change Control', loadComponent: () => import('./projects/change-requests/change-requests').then(m => m.ChangeRequests) },

  // Commercial (gated on commercial capability; billing additionally on finance)
  { path: 'customers', title: 'Customers', canMatch: [commercialGuard], loadComponent: () => import('./commercial/customers/customers').then(m => m.Customers) },
  { path: 'contracts', title: 'Contracts', canMatch: [commercialGuard], loadComponent: () => import('./commercial/contracts/contracts').then(m => m.Contracts) },
  { path: 'contracts/:id', title: 'Contract Details', canMatch: [commercialGuard], loadComponent: () => import('./commercial/contract-details/contract-details').then(m => m.ContractDetails) },
  { path: 'orders', title: 'Orders', canMatch: [commercialGuard], loadComponent: () => import('./commercial/orders/orders').then(m => m.Orders) },
  { path: 'billing', title: 'Billing', canMatch: [commercialGuard, financeGuard], loadComponent: () => import('./commercial/billing/billing').then(m => m.Billing) },

  // Reporting
  { path: 'reporting', title: 'Reporting', loadComponent: () => import('./reporting/reporting').then(m => m.Reporting) },

  // Configuration
  { path: 'config/language', title: 'Default Language', loadComponent: () => import('./configuration/set-default-language.component').then(m => m.SetDefaultLanguageComponent) },
  { path: 'config/skill-catalogs', title: 'Skill Catalogs', loadComponent: () => import('./configuration/manage-skill-catalogs.component').then(m => m.ManageSkillCatalogsComponent) },
  { path: 'config/proficiency-sets', title: 'Proficiency Sets', loadComponent: () => import('./configuration/manage-proficiency-sets.component').then(m => m.ManageProficiencySetsComponent) },
  { path: 'config/skills', title: 'Manage Skills', loadComponent: () => import('./configuration/manage-skills.component').then(m => m.ManageSkillsComponent) },
  { path: 'config/project-roles', title: 'Project Roles', loadComponent: () => import('./configuration/manage-project-roles.component').then(m => m.ManageProjectRolesComponent) },
  { path: 'config/cost-centers', title: 'Cost Centers', loadComponent: () => import('./configuration/manage-cost-centers.component').then(m => m.ManageCostCentersComponent) },
  { path: 'config/service-orgs', title: 'Service Organizations', loadComponent: () => import('./configuration/service-organization-details.component').then(m => m.ServiceOrganizationDetailsComponent) },
  { path: 'config/resource-orgs', title: 'Resource Organizations', loadComponent: () => import('./configuration/manage-resource-organizations.component').then(m => m.ManageResourceOrganizationsComponent) },
  // Customizing catalogs (Phase F1 — additive reference data). Gated to admin /
  // delivery-executive, mirroring the server's mutation RBAC for these catalogs.
  { path: 'config/locations', title: 'Locations', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive']))], loadComponent: () => import('./configuration/manage-locations.component').then(m => m.ManageLocationsComponent) },
  { path: 'config/industries', title: 'Industries', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive']))], loadComponent: () => import('./configuration/manage-industries.component').then(m => m.ManageIndustriesComponent) },
  { path: 'config/cost-categories', title: 'Cost Categories', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive']))], loadComponent: () => import('./configuration/manage-cost-categories.component').then(m => m.ManageCostCategoriesComponent) },
  { path: 'config/partner-roles', title: 'Partner Roles', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive']))], loadComponent: () => import('./configuration/manage-partner-roles.component').then(m => m.ManagePartnerRolesComponent) },
  { path: 'config/vendors', title: 'Vendors', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive']))], loadComponent: () => import('./configuration/manage-vendors.component').then(m => m.ManageVendorsComponent) },
  // Rate Cards (Phase E) define cost/bill rates — sensitive financial config,
  // gated to the finance-grade roles (mirrors the server's /rate-cards RBAC).
  { path: 'config/rate-cards', title: 'Rate Cards', canMatch: [roleGuard(a => a.hasAnyRole(['admin', 'delivery-executive', 'finance']))], loadComponent: () => import('./configuration/manage-rate-cards.component').then(m => m.ManageRateCardsComponent) },
  { path: 'config/availability', title: 'Availability Data', loadComponent: () => import('./configuration/maintain-availability-data.component').then(m => m.MaintainAvailabilityDataComponent) },
  // Integrations expose financial artifacts (GL journal, e-invoices, BI feed):
  // gate on the finance capability, mirroring the server's '/integrations' RBAC.
  { path: 'config/integrations', title: 'Integrations', canMatch: [financeGuard], loadComponent: () => import('./configuration/integrations.component').then(m => m.IntegrationsComponent) },

  // 404
  { path: '**', title: 'Page Not Found', loadComponent: () => import('./not-found/not-found.component').then(m => m.NotFoundComponent) },
];
