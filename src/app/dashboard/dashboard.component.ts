import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { ApiService, Resource, ResourceRequest } from '../services/api.service';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule],
  template: `
    <div class="max-w-7xl mx-auto space-y-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
          <p class="text-slate-500 mt-1">Welcome back. Here's what's happening today.</p>
        </div>
        <div class="flex items-center gap-3">
          <button class="bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm flex items-center gap-2">
            <mat-icon class="text-sm">filter_list</mat-icon> Filter
          </button>
          <button class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2">
            <mat-icon class="text-sm">add</mat-icon> New Request
          </button>
        </div>
      </div>
      
      <!-- KPI Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        <!-- Total Resources -->
        <div class="bg-white p-6 rounded-3xl shadow-sm border border-slate-200/60 flex items-center justify-between group hover:shadow-md hover:border-indigo-200 transition-all duration-300 relative overflow-hidden">
          <div class="absolute -right-6 -top-6 w-24 h-24 bg-indigo-50 rounded-full blur-2xl group-hover:bg-indigo-100 transition-colors"></div>
          <div class="relative z-10">
            <h2 class="text-sm font-medium text-slate-500 mb-1">Total Resources</h2>
            <p class="text-4xl font-bold text-slate-900 tracking-tight">{{ resources().length }}</p>
          </div>
          <div class="w-14 h-14 bg-indigo-50/80 text-indigo-600 rounded-2xl flex items-center justify-center relative z-10 group-hover:scale-110 transition-transform duration-300">
            <mat-icon>people</mat-icon>
          </div>
        </div>

        <!-- Open Requests -->
        <div class="bg-white p-6 rounded-3xl shadow-sm border border-slate-200/60 flex items-center justify-between group hover:shadow-md hover:border-emerald-200 transition-all duration-300 relative overflow-hidden">
          <div class="absolute -right-6 -top-6 w-24 h-24 bg-emerald-50 rounded-full blur-2xl group-hover:bg-emerald-100 transition-colors"></div>
          <div class="relative z-10">
            <h2 class="text-sm font-medium text-slate-500 mb-1">Open Requests</h2>
            <p class="text-4xl font-bold text-slate-900 tracking-tight">{{ openRequests() }}</p>
          </div>
          <div class="w-14 h-14 bg-emerald-50/80 text-emerald-600 rounded-2xl flex items-center justify-center relative z-10 group-hover:scale-110 transition-transform duration-300">
            <mat-icon>assignment</mat-icon>
          </div>
        </div>

        <!-- Overbooked Resources -->
        <div class="bg-white p-6 rounded-3xl shadow-sm border border-slate-200/60 flex items-center justify-between group hover:shadow-md hover:border-orange-200 transition-all duration-300 relative overflow-hidden sm:col-span-2 lg:col-span-1">
          <div class="absolute -right-6 -top-6 w-24 h-24 bg-orange-50 rounded-full blur-2xl group-hover:bg-orange-100 transition-colors"></div>
          <div class="relative z-10">
            <h2 class="text-sm font-medium text-slate-500 mb-1">Overbooked Resources</h2>
            <p class="text-4xl font-bold text-slate-900 tracking-tight">{{ overbookedResources() }}</p>
          </div>
          <div class="w-14 h-14 bg-orange-50/80 text-orange-600 rounded-2xl flex items-center justify-center relative z-10 group-hover:scale-110 transition-transform duration-300">
            <mat-icon>warning</mat-icon>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Recent Requests -->
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col">
          <div class="p-6 border-b border-slate-100 flex items-center justify-between bg-white/50 backdrop-blur-sm">
            <h2 class="text-lg font-semibold text-slate-900">Recent Requests</h2>
            <a href="/requests" class="text-sm font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1">View All <mat-icon class="text-[16px] w-[16px] h-[16px]">arrow_forward</mat-icon></a>
          </div>
          <div class="divide-y divide-slate-100 flex-1 overflow-y-auto">
            @for (req of recentRequests(); track req.id) {
              <div class="p-6 hover:bg-slate-50/80 transition-colors group cursor-pointer">
                <div class="flex justify-between items-start mb-3">
                  <h3 class="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors">{{ req.name }}</h3>
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide"
                        [class.bg-emerald-100]="req.status === 'Published'"
                        [class.text-emerald-800]="req.status === 'Published'"
                        [class.bg-slate-100]="req.status === 'Not Published'"
                        [class.text-slate-800]="req.status === 'Not Published'"
                        [class.bg-blue-100]="req.status === 'Open'"
                        [class.text-blue-800]="req.status === 'Open'">
                    {{ req.status }}
                  </span>
                </div>
                <div class="flex items-center gap-4 text-sm text-slate-500 mb-3">
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">badge</mat-icon> {{ req.requiredRole }}</span>
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">schedule</mat-icon> {{ req.requiredEffort }}h</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div class="h-2 rounded-full bg-indigo-500 transition-all duration-1000 ease-out" 
                       [style.width.%]="(req.staffedEffort || 0) / req.requiredEffort * 100"></div>
                </div>
              </div>
            }
            @if (!recentRequests().length) {
              <div class="p-12 flex flex-col items-center justify-center text-slate-400">
                <mat-icon class="text-4xl mb-2 opacity-50">assignment_turned_in</mat-icon>
                <p>No recent requests.</p>
              </div>
            }
          </div>
        </div>

        <!-- Overbooked Resources List -->
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col">
          <div class="p-6 border-b border-slate-100 flex items-center justify-between bg-white/50 backdrop-blur-sm">
            <h2 class="text-lg font-semibold text-slate-900">Overbooked Resources</h2>
            <a href="/utilization" class="text-sm font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1">Manage <mat-icon class="text-[16px] w-[16px] h-[16px]">arrow_forward</mat-icon></a>
          </div>
          <div class="divide-y divide-slate-100 flex-1 overflow-y-auto">
            @for (res of overbookedResourcesList(); track res.id) {
              <div class="p-6 hover:bg-slate-50/80 transition-colors flex items-center justify-between group cursor-pointer">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 bg-gradient-to-br from-slate-100 to-slate-200 rounded-full flex items-center justify-center text-slate-600 font-semibold text-lg shadow-inner">
                    {{ res.name.charAt(0) }}
                  </div>
                  <div>
                    <h3 class="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors">{{ res.name }}</h3>
                    <p class="text-sm text-slate-500">{{ res.role }}</p>
                  </div>
                </div>
                <div class="text-right flex flex-col items-end">
                  <div class="text-xl font-bold text-red-600">{{ res.utilization | number:'1.0-0' }}%</div>
                  <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Utilization</span>
                </div>
              </div>
            }
            @if (!overbookedResourcesList().length) {
              <div class="p-12 flex flex-col items-center justify-center text-slate-400">
                <mat-icon class="text-4xl mb-2 opacity-50">check_circle</mat-icon>
                <p>No overbooked resources.</p>
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class DashboardComponent implements OnInit {
  private api = inject(ApiService);
  
  resources = signal<Resource[]>([]);
  requests = signal<ResourceRequest[]>([]);

  openRequests = signal(0);
  overbookedResources = signal(0);
  recentRequests = signal<ResourceRequest[]>([]);
  overbookedResourcesList = signal<Resource[]>([]);

  ngOnInit() {
    this.api.getResources().subscribe(res => {
      this.resources.set(res);
      const overbooked = res.filter(r => r.utilization > 110);
      this.overbookedResources.set(overbooked.length);
      this.overbookedResourcesList.set(overbooked.slice(0, 5));
    });
    this.api.getRequests().subscribe(reqs => {
      this.requests.set(reqs);
      this.openRequests.set(reqs.filter(r => r.status === 'Open').length);
      this.recentRequests.set(reqs.slice(-5).reverse());
    });
  }
}
