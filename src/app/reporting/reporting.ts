import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-reporting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Analytics & Reporting</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Cross-functional insights across Resource and Project Management.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <select class="w-full sm:w-auto bg-white/80 backdrop-blur-md border border-slate-200/60 text-slate-700 px-4 py-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-sm transition-all text-sm font-medium">
            <option>Last 30 Days</option>
            <option>This Quarter</option>
            <option>This Year</option>
          </select>
          <button class="w-full sm:w-auto bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 shadow-sm">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">download</mat-icon> Export Report
          </button>
        </div>
      </div>

      <!-- KPI Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        @for (kpi of kpis(); track kpi.label) {
          <div class="bg-white/80 backdrop-blur-md p-6 rounded-3xl shadow-sm border border-slate-200/60 hover:shadow-md transition-all group">
            <div class="flex items-center justify-between mb-4">
              <div class="w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform" [ngClass]="kpi.colorClass">
                <mat-icon class="text-white">{{ kpi.icon }}</mat-icon>
              </div>
              <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide" 
                    [ngClass]="kpi.trend > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'">
                {{ kpi.trend > 0 ? '+' : '' }}{{ kpi.trend }}%
              </span>
            </div>
            <h3 class="text-slate-500 text-sm font-semibold uppercase tracking-wider mb-1">{{ kpi.label }}</h3>
            <p class="text-3xl font-bold text-slate-900 tracking-tight">{{ kpi.value }}</p>
          </div>
        }
      </div>

      <!-- Charts Area -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Resource Utilization Trend -->
        <div class="bg-white/80 backdrop-blur-md p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200/60">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Resource Utilization Trend</h3>
            <button class="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"><mat-icon class="text-[20px] w-[20px] h-[20px]">more_vert</mat-icon></button>
          </div>
          <div class="h-64 flex items-end gap-2 sm:gap-4">
            @for (bar of utilizationData(); track bar.month) {
              <div class="flex-1 flex flex-col items-center gap-3 group relative h-full justify-end">
                <!-- Tooltip -->
                <div class="absolute -top-12 bg-slate-900 text-white text-xs font-bold py-1.5 px-3 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform group-hover:-translate-y-1 pointer-events-none whitespace-nowrap z-10 shadow-xl">
                  {{ bar.value }}%
                  <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-900 rotate-45"></div>
                </div>
                <div class="w-full bg-indigo-50/50 rounded-t-xl relative flex-1 flex items-end overflow-hidden group-hover:bg-indigo-50 transition-colors">
                  <div class="w-full bg-gradient-to-t from-indigo-600 to-indigo-400 rounded-t-xl transition-all duration-700 ease-out group-hover:opacity-90" [style.height.%]="bar.value"></div>
                </div>
                <span class="text-xs text-slate-500 font-semibold uppercase tracking-wider">{{ bar.month }}</span>
              </div>
            }
          </div>
        </div>

        <!-- Project Budget Variance -->
        <div class="bg-white/80 backdrop-blur-md p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200/60">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Project Budget Variance</h3>
            <button class="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"><mat-icon class="text-[20px] w-[20px] h-[20px]">more_vert</mat-icon></button>
          </div>
          <div class="space-y-6">
            @for (project of budgetVariance(); track project.name) {
              <div class="group">
                <div class="flex justify-between items-end mb-2">
                  <span class="font-bold text-slate-700 group-hover:text-slate-900 transition-colors">{{ project.name }}</span>
                  <span class="text-sm font-bold tracking-wide" [class.text-red-600]="project.variance > 0" [class.text-emerald-600]="project.variance <= 0">
                    {{ project.variance > 0 ? '+' : '' }}{{ project.variance }}%
                  </span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-3 overflow-hidden shadow-inner">
                  <div class="h-full rounded-full transition-all duration-1000 ease-out relative" 
                       [class.bg-gradient-to-r]="true"
                       [class.from-emerald-500]="project.variance <= 0" [class.to-emerald-400]="project.variance <= 0"
                       [class.from-red-500]="project.variance > 0" [class.to-red-400]="project.variance > 0"
                       [style.width.%]="project.spent">
                       <div class="absolute inset-0 bg-white/20 w-full h-full" style="background-image: linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent); background-size: 1rem 1rem;"></div>
                  </div>
                </div>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Detailed Reports Table -->
      <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">Available Reports</h3>
          <div class="flex gap-2">
            <button class="w-8 h-8 rounded-full hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors"><mat-icon class="text-[20px] w-[20px] h-[20px]">filter_list</mat-icon></button>
            <button class="w-8 h-8 rounded-full hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors"><mat-icon class="text-[20px] w-[20px] h-[20px]">search</mat-icon></button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50/80 border-b border-slate-100 text-slate-500">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Report Name</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Category</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Last Generated</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (report of reports(); track report.name) {
                <tr class="hover:bg-slate-50/80 transition-colors group">
                  <td class="px-6 sm:px-8 py-5 font-bold text-slate-900 flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">description</mat-icon>
                    </div>
                    {{ report.name }}
                  </td>
                  <td class="px-6 sm:px-8 py-5">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide"
                          [class.bg-indigo-100]="report.category === 'Resource Management'" [class.text-indigo-800]="report.category === 'Resource Management'"
                          [class.bg-emerald-100]="report.category === 'Project Management'" [class.text-emerald-800]="report.category === 'Project Management'"
                          [class.bg-blue-100]="report.category === 'Cross-Functional'" [class.text-blue-800]="report.category === 'Cross-Functional'">
                      {{ report.category }}
                    </span>
                  </td>
                  <td class="px-6 sm:px-8 py-5 text-slate-600 font-medium">{{ report.lastGenerated }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right">
                    <button class="text-indigo-600 hover:text-indigo-800 font-semibold text-sm transition-colors opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center justify-end gap-1 ml-auto">
                      View <mat-icon class="text-[16px] w-[16px] h-[16px]">arrow_forward</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
})
export class Reporting {
  kpis = signal([
    { label: 'Total Active Projects', value: '24', trend: 12, icon: 'folder', colorClass: 'bg-blue-500' },
    { label: 'Avg Resource Utilization', value: '86%', trend: 4, icon: 'bar_chart', colorClass: 'bg-emerald-500' },
    { label: 'Open Resource Requests', value: '18', trend: -5, icon: 'person_add', colorClass: 'bg-amber-500' },
    { label: 'Total Budget Variance', value: '+2.4%', trend: -1.2, icon: 'account_balance', colorClass: 'bg-red-500' },
  ]);

  utilizationData = signal([
    { month: 'Jan', value: 75 },
    { month: 'Feb', value: 82 },
    { month: 'Mar', value: 88 },
    { month: 'Apr', value: 85 },
    { month: 'May', value: 92 },
    { month: 'Jun', value: 86 },
  ]);

  budgetVariance = signal([
    { name: 'Cloud Migration', spent: 85, variance: -2 },
    { name: 'ERP Implementation', spent: 95, variance: 5 },
    { name: 'Security Audit', spent: 60, variance: -10 },
    { name: 'Mobile App V2', spent: 110, variance: 15 },
  ]);

  reports = signal([
    { name: 'Monthly Resource Utilization', category: 'Resource Management', lastGenerated: '2 days ago' },
    { name: 'Project Financial Summary', category: 'Project Management', lastGenerated: '1 week ago' },
    { name: 'Skills Gap Analysis', category: 'Resource Management', lastGenerated: '3 weeks ago' },
    { name: 'Cross-Project Issue Tracking', category: 'Project Management', lastGenerated: 'Yesterday' },
  ]);
}
