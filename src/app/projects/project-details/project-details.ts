import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, Project } from '../../services/api.service';
import { ProjectPartners } from '../project-partners/project-partners';
import { ProjectDocuments } from '../project-documents/project-documents';
import { ProjectPlans } from '../project-plans/project-plans';
import { FinancialPlans } from '../financial-plans/financial-plans';
import { ProjectCostCenters } from '../project-cost-centers/project-cost-centers';
import { ProjectTasks } from '../project-tasks/project-tasks';
import { ProjectIssues } from '../project-issues/project-issues';

@Component({
  selector: 'app-project-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule, 
    CommonModule, 
    RouterLink,
    ProjectPartners,
    ProjectDocuments,
    ProjectPlans,
    FinancialPlans,
    ProjectCostCenters,
    ProjectTasks,
    ProjectIssues
  ],
  template: `
    <div class="max-w-7xl mx-auto space-y-6 sm:space-y-8 p-4 sm:p-6 lg:p-8">
      <!-- Header & Main Info -->
      <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-start gap-6">
          <a routerLink="/projects" class="w-12 h-12 bg-slate-50 rounded-2xl border border-slate-200/60 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-100 transition-all shrink-0 mt-1">
            <mat-icon>arrow_back</mat-icon>
          </a>
          <div class="flex-1 min-w-0 space-y-6">
            <div>
              <div class="flex flex-wrap items-center gap-3 mb-2">
                <h1 class="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 tracking-tight truncate">{{ project()?.name || 'Loading...' }}</h1>
                @if (project()) {
                  <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide"
                        [class.bg-blue-100]="project()!.status === 'In Planning'"
                        [class.text-blue-800]="project()!.status === 'In Planning'"
                        [class.bg-emerald-100]="project()!.status === 'In Execution'"
                        [class.text-emerald-800]="project()!.status === 'In Execution'"
                        [class.bg-slate-100]="project()!.status === 'Completed'"
                        [class.text-slate-800]="project()!.status === 'Completed'">
                    {{ project()!.status }}
                  </span>
                }
              </div>
              <p class="text-sm text-slate-500 font-mono bg-slate-100 inline-block px-2.5 py-1 rounded-lg">{{ project()?.id }}</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 border-t border-slate-100">
              <div class="md:col-span-2">
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</h3>
                <p class="text-slate-700 leading-relaxed">{{ project()?.description || 'No description provided.' }}</p>
              </div>
              <div class="space-y-4">
                <div>
                  <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Location</h3>
                  <div class="flex items-center gap-2 text-slate-700 font-medium">
                    <mat-icon class="text-indigo-500 text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                    {{ project()?.location }}
                  </div>
                </div>
                <div>
                  <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Timeline</h3>
                  <div class="flex items-center gap-2 text-slate-700 font-medium">
                    <mat-icon class="text-emerald-500 text-[18px] w-[18px] h-[18px]">date_range</mat-icon>
                    {{ project()?.startDate | date:'mediumDate' }} - {{ project()?.endDate | date:'mediumDate' }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs Navigation -->
      <div class="flex overflow-x-auto hide-scrollbar border-b border-slate-200/60 bg-white/50 backdrop-blur-sm rounded-t-2xl px-2 sm:px-4">
        @for (tab of tabs; track tab.id) {
          <button (click)="activeTab.set(tab.id)"
                  class="px-4 py-4 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors"
                  [class.border-indigo-600]="activeTab() === tab.id"
                  [class.text-indigo-600]="activeTab() === tab.id"
                  [class.border-transparent]="activeTab() !== tab.id"
                  [class.text-slate-500]="activeTab() !== tab.id"
                  [class.hover:text-slate-700]="activeTab() !== tab.id"
                  [class.hover:border-slate-300]="activeTab() !== tab.id">
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Tab Content -->
      <div class="mt-6">
        @if (activeTab() === 'partners') {
          <app-project-partners [projectId]="project()?.id" />
        }
        @if (activeTab() === 'documents') {
          <app-project-documents [projectId]="project()?.id" />
        }
        @if (activeTab() === 'plans') {
          <app-project-plans [projectId]="project()?.id" />
        }
        @if (activeTab() === 'financials') {
          <app-financial-plans [projectId]="project()?.id" />
        }
        @if (activeTab() === 'cost-centers') {
          <app-project-cost-centers [projectId]="project()?.id" />
        }
        @if (activeTab() === 'tasks') {
          <app-project-tasks [projectId]="project()?.id" />
        }
        @if (activeTab() === 'issues') {
          <app-project-issues [projectId]="project()?.id" />
        }
      </div>
    </div>
  `,
  styles: `
    .hide-scrollbar::-webkit-scrollbar {
      display: none;
    }
    .hide-scrollbar {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
  `
})
export class ProjectDetailsComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);

  project = signal<Project | null>(null);
  activeTab = signal('partners');

  tabs = [
    { id: 'partners', label: 'Partners' },
    { id: 'documents', label: 'Documents' },
    { id: 'plans', label: 'Plans' },
    { id: 'financials', label: 'Financials' },
    { id: 'cost-centers', label: 'Cost Centers' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'issues', label: 'Issues' }
  ];

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.api.getProjects().subscribe(projects => {
        const proj = projects.find(p => p.id === id);
        if (proj) {
          this.project.set(proj);
        }
      });
    }
  }
}
