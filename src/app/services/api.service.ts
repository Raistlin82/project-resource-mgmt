import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { isPlatformServer } from '@angular/common';

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
}

export interface Assignment {
  id: string;
  requestId: string;
  resourceId: string;
  assignedHours: number;
  status: string;
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

export interface Project {
  id: string;
  name: string;
  location: string;
  startDate: string;
  endDate: string;
  status: string;
  description?: string;
  ownerId?: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);
  private baseUrl = isPlatformServer(this.platformId) ? 'http://localhost:3000/api' : '/api';

  getResources(): Observable<Resource[]> {
    return this.http.get<Resource[]>(`${this.baseUrl}/resources`);
  }

  getResource(id: string): Observable<Resource> {
    return this.http.get<Resource>(`${this.baseUrl}/resources/${id}`);
  }

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
}
