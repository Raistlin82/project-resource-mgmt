import { Routes } from '@angular/router';
import { commercialGuard, financeGuard } from './guards/role.guard';

export const routes: Routes = [
  // Resource Management
  { path: '', loadComponent: () => import('./dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'profile', loadComponent: () => import('./my-profile/my-profile.component').then(m => m.MyProfileComponent) },
  { path: 'assignments', loadComponent: () => import('./my-assignments/my-assignments.component').then(m => m.MyAssignmentsComponent) },
  { path: 'requests', loadComponent: () => import('./resource-requests/resource-requests.component').then(m => m.ResourceRequestsComponent) },
  { path: 'staffing', loadComponent: () => import('./staffing/staffing.component').then(m => m.StaffingComponent) },
  { path: 'utilization', loadComponent: () => import('./utilization/utilization.component').then(m => m.UtilizationComponent) },
  { path: 'forecast', loadComponent: () => import('./forecast/forecast').then(m => m.Forecast) },
  { path: 'what-if', loadComponent: () => import('./forecast/what-if').then(m => m.WhatIf) },
  { path: 'approvals', loadComponent: () => import('./approvals/approvals').then(m => m.Approvals) },

  // Project Management
  { path: 'projects', loadComponent: () => import('./projects/projects/projects').then(m => m.ProjectsComponent) },
  { path: 'projects/:id', loadComponent: () => import('./projects/project-details/project-details').then(m => m.ProjectDetailsComponent) },
  { path: 'project-partners', loadComponent: () => import('./projects/project-partners/project-partners').then(m => m.ProjectPartners) },
  { path: 'project-documents', loadComponent: () => import('./projects/project-documents/project-documents').then(m => m.ProjectDocuments) },
  { path: 'project-plans', loadComponent: () => import('./projects/project-plans/project-plans').then(m => m.ProjectPlans) },
  { path: 'financial-plans', loadComponent: () => import('./projects/financial-plans/financial-plans').then(m => m.FinancialPlans) },
  { path: 'project-cost-centers', loadComponent: () => import('./projects/project-cost-centers/project-cost-centers').then(m => m.ProjectCostCenters) },
  { path: 'project-tasks', loadComponent: () => import('./projects/project-tasks/project-tasks').then(m => m.ProjectTasks) },
  { path: 'project-issues', loadComponent: () => import('./projects/project-issues/project-issues').then(m => m.ProjectIssues) },
  { path: 'change-requests', loadComponent: () => import('./projects/change-requests/change-requests').then(m => m.ChangeRequests) },

  // Commercial (gated on commercial capability; billing additionally on finance)
  { path: 'customers', canMatch: [commercialGuard], loadComponent: () => import('./commercial/customers/customers').then(m => m.Customers) },
  { path: 'contracts', canMatch: [commercialGuard], loadComponent: () => import('./commercial/contracts/contracts').then(m => m.Contracts) },
  { path: 'contracts/:id', canMatch: [commercialGuard], loadComponent: () => import('./commercial/contract-details/contract-details').then(m => m.ContractDetails) },
  { path: 'orders', canMatch: [commercialGuard], loadComponent: () => import('./commercial/orders/orders').then(m => m.Orders) },
  { path: 'billing', canMatch: [commercialGuard, financeGuard], loadComponent: () => import('./commercial/billing/billing').then(m => m.Billing) },

  // Reporting
  { path: 'reporting', loadComponent: () => import('./reporting/reporting').then(m => m.Reporting) },

  // Configuration
  { path: 'config/language', loadComponent: () => import('./configuration/set-default-language.component').then(m => m.SetDefaultLanguageComponent) },
  { path: 'config/skill-catalogs', loadComponent: () => import('./configuration/manage-skill-catalogs.component').then(m => m.ManageSkillCatalogsComponent) },
  { path: 'config/proficiency-sets', loadComponent: () => import('./configuration/manage-proficiency-sets.component').then(m => m.ManageProficiencySetsComponent) },
  { path: 'config/skills', loadComponent: () => import('./configuration/manage-skills.component').then(m => m.ManageSkillsComponent) },
  { path: 'config/project-roles', loadComponent: () => import('./configuration/manage-project-roles.component').then(m => m.ManageProjectRolesComponent) },
  { path: 'config/cost-centers', loadComponent: () => import('./configuration/manage-cost-centers.component').then(m => m.ManageCostCentersComponent) },
  { path: 'config/service-orgs', loadComponent: () => import('./configuration/service-organization-details.component').then(m => m.ServiceOrganizationDetailsComponent) },
  { path: 'config/resource-orgs', loadComponent: () => import('./configuration/manage-resource-organizations.component').then(m => m.ManageResourceOrganizationsComponent) },
  { path: 'config/availability', loadComponent: () => import('./configuration/maintain-availability-data.component').then(m => m.MaintainAvailabilityDataComponent) },
  // Integrations expose financial artifacts (GL journal, e-invoices, BI feed):
  // gate on the finance capability, mirroring the server's '/integrations' RBAC.
  { path: 'config/integrations', canMatch: [financeGuard], loadComponent: () => import('./configuration/integrations.component').then(m => m.IntegrationsComponent) },

  // 404
  { path: '**', loadComponent: () => import('./not-found/not-found.component').then(m => m.NotFoundComponent) },
];
