import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, CommonModule],
  template: `
    <div class="min-h-screen bg-slate-50 flex flex-col lg:flex-row font-sans">
      
      <!-- Mobile Header -->
      <header class="lg:hidden bg-slate-900 text-white p-4 flex items-center justify-between sticky top-0 z-40 shadow-md">
        <div class="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <mat-icon>schedule</mat-icon>
          Resource Mgmt
        </div>
        <button (click)="toggleMenu()" class="p-2 -mr-2 rounded-lg hover:bg-slate-800 transition-colors">
          <mat-icon>{{ isMobileMenuOpen() ? 'close' : 'menu' }}</mat-icon>
        </button>
      </header>

      <!-- Backdrop for mobile sidebar -->
      @if (isMobileMenuOpen()) {
        <div 
          class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          (click)="closeMenu()"
          (keydown.enter)="closeMenu()"
          tabindex="0"
          role="button"
          aria-label="Close menu">
        </div>
      }

      <!-- Sidebar -->
      <aside 
        class="fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 text-slate-300 flex flex-col transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 overflow-y-auto shadow-2xl lg:shadow-none"
        [class.-translate-x-full]="!isMobileMenuOpen()"
        [class.translate-x-0]="isMobileMenuOpen()">
        
        <div class="hidden lg:flex p-6 text-white text-xl font-semibold tracking-tight items-center gap-2 sticky top-0 bg-slate-900 z-10">
          <mat-icon>schedule</mat-icon>
          Resource Mgmt
        </div>

        <nav class="flex-1 px-4 py-6 lg:pt-0 space-y-1.5">
          <div class="pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Resource Management
          </div>
          <a routerLink="/" routerLinkActive="bg-indigo-600 text-white" [routerLinkActiveOptions]="{exact: true}" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>dashboard</mat-icon> Dashboard
          </a>
          <a routerLink="/profile" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>person</mat-icon> My Profile & Experience
          </a>
          <a routerLink="/assignments" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>event_note</mat-icon> My Assignments
          </a>
          <a routerLink="/requests" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>assignment</mat-icon> Resource Requests
          </a>
          <a routerLink="/staffing" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>group_add</mat-icon> Staffing
          </a>
          
          <div class="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Project Management
          </div>
          <a routerLink="/projects" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>folder</mat-icon> Projects
          </a>
          <a routerLink="/project-partners" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>handshake</mat-icon> Project Partners
          </a>
          <a routerLink="/project-documents" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>description</mat-icon> Documents
          </a>
          <a routerLink="/project-plans" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>account_tree</mat-icon> Project Plans
          </a>
          <a routerLink="/financial-plans" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>payments</mat-icon> Financial Plans
          </a>
          <a routerLink="/project-cost-centers" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>account_balance</mat-icon> Cost Centers
          </a>
          <a routerLink="/project-tasks" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>task</mat-icon> Tasks
          </a>
          <a routerLink="/project-issues" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>bug_report</mat-icon> Issues
          </a>
          
          <div class="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Analytics & Reporting
          </div>
          <a routerLink="/utilization" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>bar_chart</mat-icon> Utilization
          </a>
          <a routerLink="/reporting" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200">
            <mat-icon>insights</mat-icon> Reporting
          </a>
          
          <div class="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Configuration
          </div>
          <a routerLink="/config/language" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">language</mat-icon> Default Language
          </a>
          <a routerLink="/config/skill-catalogs" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">category</mat-icon> Skill Catalogs
          </a>
          <a routerLink="/config/proficiency-sets" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">military_tech</mat-icon> Proficiency Sets
          </a>
          <a routerLink="/config/skills" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">psychology</mat-icon> Manage Skills
          </a>
          <a routerLink="/config/project-roles" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">badge</mat-icon> Project Roles
          </a>
          <a routerLink="/config/cost-centers" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">account_balance</mat-icon> Cost Centers
          </a>
          <a routerLink="/config/service-orgs" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">business</mat-icon> Service Orgs
          </a>
          <a routerLink="/config/resource-orgs" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">domain</mat-icon> Resource Orgs
          </a>
          <a routerLink="/config/availability" routerLinkActive="bg-indigo-600 text-white" (click)="closeMenu()" class="flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-slate-800 hover:text-white transition-all duration-200 text-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">event_available</mat-icon> Availability Data
          </a>
        </nav>
      </aside>

      <!-- Main Content -->
      <main class="flex-1 overflow-y-auto lg:h-screen">
        <div class="p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto">
          <router-outlet></router-outlet>
        </div>
      </main>
    </div>
  `,
})
export class App {
  isMobileMenuOpen = signal(false);

  toggleMenu() {
    this.isMobileMenuOpen.update(v => !v);
  }

  closeMenu() {
    this.isMobileMenuOpen.set(false);
  }
}
