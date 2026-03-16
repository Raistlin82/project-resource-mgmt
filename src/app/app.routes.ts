import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard/dashboard.component';
import { MyProfileComponent } from './my-profile/my-profile.component';
import { ResourceRequestsComponent } from './resource-requests/resource-requests.component';
import { StaffingComponent } from './staffing/staffing.component';
import { UtilizationComponent } from './utilization/utilization.component';

import { SetDefaultLanguageComponent } from './configuration/set-default-language.component';
import { ManageSkillCatalogsComponent } from './configuration/manage-skill-catalogs.component';
import { ManageProficiencySetsComponent } from './configuration/manage-proficiency-sets.component';
import { ManageSkillsComponent } from './configuration/manage-skills.component';
import { ManageProjectRolesComponent } from './configuration/manage-project-roles.component';
import { ManageCostCentersComponent } from './configuration/manage-cost-centers.component';
import { ServiceOrganizationDetailsComponent } from './configuration/service-organization-details.component';
import { ManageResourceOrganizationsComponent } from './configuration/manage-resource-organizations.component';
import { MaintainAvailabilityDataComponent } from './configuration/maintain-availability-data.component';

import { MyAssignmentsComponent } from './my-assignments/my-assignments.component';

import { ProjectsComponent } from './projects/projects/projects';
import { ProjectDetailsComponent } from './projects/project-details/project-details';
import { ProjectPartners } from './projects/project-partners/project-partners';
import { ProjectDocuments } from './projects/project-documents/project-documents';
import { ProjectPlans } from './projects/project-plans/project-plans';
import { FinancialPlans } from './projects/financial-plans/financial-plans';
import { ProjectCostCenters } from './projects/project-cost-centers/project-cost-centers';
import { ProjectTasks } from './projects/project-tasks/project-tasks';
import { ProjectIssues } from './projects/project-issues/project-issues';
import { Reporting } from './reporting/reporting';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'profile', component: MyProfileComponent },
  { path: 'assignments', component: MyAssignmentsComponent },
  { path: 'requests', component: ResourceRequestsComponent },
  { path: 'staffing', component: StaffingComponent },
  { path: 'utilization', component: UtilizationComponent },
  
  // Project Management Routes
  { path: 'projects', component: ProjectsComponent },
  { path: 'projects/:id', component: ProjectDetailsComponent },
  { path: 'project-partners', component: ProjectPartners },
  { path: 'project-documents', component: ProjectDocuments },
  { path: 'project-plans', component: ProjectPlans },
  { path: 'financial-plans', component: FinancialPlans },
  { path: 'project-cost-centers', component: ProjectCostCenters },
  { path: 'project-tasks', component: ProjectTasks },
  { path: 'project-issues', component: ProjectIssues },

  // Reporting
  { path: 'reporting', component: Reporting },

  // Configuration Routes
  { path: 'config/language', component: SetDefaultLanguageComponent },
  { path: 'config/skill-catalogs', component: ManageSkillCatalogsComponent },
  { path: 'config/proficiency-sets', component: ManageProficiencySetsComponent },
  { path: 'config/skills', component: ManageSkillsComponent },
  { path: 'config/project-roles', component: ManageProjectRolesComponent },
  { path: 'config/cost-centers', component: ManageCostCentersComponent },
  { path: 'config/service-orgs', component: ServiceOrganizationDetailsComponent },
  { path: 'config/resource-orgs', component: ManageResourceOrganizationsComponent },
  { path: 'config/availability', component: MaintainAvailabilityDataComponent },
];
