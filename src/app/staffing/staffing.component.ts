import { ChangeDetectionStrategy, Component, inject, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Resource } from '../services/api.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-staffing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule],
  template: `
    <div class="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight mb-8">Staff Resource Requests</h1>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <!-- Requests List -->
        <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col h-[800px] hover:shadow-md transition-all">
          <div class="p-6 sm:p-8 border-b border-slate-100 bg-slate-50/50">
            <h2 class="text-xl font-bold text-slate-900 tracking-tight">Open Requests</h2>
            <p class="text-sm font-medium text-slate-500 mt-2">Select a request to find matching resources</p>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
            @for (req of openRequests(); track req.id) {
              <div class="p-6 sm:p-8 hover:bg-slate-50/80 transition-all cursor-pointer group relative" 
                   [class.bg-indigo-50]="selectedRequest()?.id === req.id"
                   tabindex="0"
                   (keydown.enter)="selectRequest(req)"
                   (click)="selectRequest(req)">
                @if (selectedRequest()?.id === req.id) {
                  <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-indigo-600 rounded-r-full"></div>
                }
                <div class="flex justify-between items-start mb-3">
                  <h3 class="font-bold text-slate-900 text-lg group-hover:text-indigo-700 transition-colors">{{ req.name }}</h3>
                  <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-indigo-100 text-indigo-800">{{ req.requiredEffort }}h</span>
                </div>
                <p class="text-sm font-semibold text-slate-500 mb-4 uppercase tracking-wider">{{ req.requiredRole }}</p>
                <div class="flex gap-2 flex-wrap">
                  @for (skill of req.skills; track skill) {
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-600 border border-slate-200/60">
                      {{ skill }}
                    </span>
                  }
                </div>
              </div>
            }
            @if (openRequests().length === 0) {
              <div class="p-12 text-center text-slate-500 font-medium italic">No open requests available for staffing.</div>
            }
          </div>
        </div>

        <!-- Resources List -->
        <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col h-[800px] hover:shadow-md transition-all">
          <div class="p-6 sm:p-8 border-b border-slate-100 bg-slate-50/50">
            <div class="flex items-center justify-between mb-6">
              <div>
                <h2 class="text-xl font-bold text-slate-900 tracking-tight">
                  {{ selectedRequest() ? 'Matching Resources' : 'All Resources' }}
                </h2>
                @if (selectedRequest()) {
                  <p class="text-sm font-medium text-slate-500 mt-2">For <span class="font-bold text-slate-700">{{ selectedRequest()?.name }}</span></p>
                }
              </div>
              @if (selectedRequest()) {
                <button (click)="clearSelection()" class="text-sm text-indigo-600 hover:text-indigo-800 font-bold tracking-wide uppercase transition-colors bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-xl">Clear Selection</button>
              }
            </div>
            
            <div class="relative">
              <mat-icon class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input 
                type="text" 
                [ngModel]="searchQuery()"
                (ngModelChange)="searchQuery.set($event)"
                placeholder="Search by name, role, or skills..." 
                class="w-full pl-12 pr-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none text-sm font-medium transition-all shadow-inner bg-white/50"
              >
            </div>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
            @for (res of displayedResources(); track res.id) {
              <div class="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors group">
                <div class="flex items-center gap-5">
                  <div class="w-14 h-14 bg-gradient-to-br from-slate-100 to-slate-200 rounded-2xl flex items-center justify-center text-slate-600 font-bold text-xl shrink-0 shadow-sm border border-white">
                    {{ res.name.charAt(0) }}
                  </div>
                  <div>
                    <h3 class="font-bold text-slate-900 text-lg group-hover:text-indigo-700 transition-colors">{{ res.name }}</h3>
                    <p class="text-sm font-medium text-slate-500 mt-0.5">{{ res.role }} <span class="mx-1.5 text-slate-300">•</span> <span [class.text-red-500]="res.utilization > 100" [class.text-emerald-600]="res.utilization <= 100">{{ res.utilization | number:'1.0-0' }}% Utilized</span></p>
                    <div class="flex gap-1.5 mt-3 flex-wrap">
                      @for (skill of res.skills; track skill.name) {
                        <span class="text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-600 px-2 py-1 rounded-md border border-slate-200/60">{{ skill.name }}</span>
                      }
                    </div>
                  </div>
                </div>
                @if (selectedRequest()) {
                  <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0 w-full sm:w-auto mt-4 sm:mt-0">
                    @if (assigningResourceId() === res.id) {
                      <div class="flex items-center gap-2 w-full sm:w-auto">
                        <input type="number" [ngModel]="assignHours()" (ngModelChange)="assignHours.set($event)" class="w-20 px-3 py-2 border border-slate-200/60 rounded-xl text-sm font-bold focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none shadow-inner" min="1" [max]="selectedRequest()?.requiredEffort || 1">
                        <button (click)="confirmAssign(res.id)" class="flex-1 sm:flex-none bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5">Confirm</button>
                        <button (click)="cancelAssign()" class="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors flex items-center justify-center"><mat-icon class="text-[20px] w-[20px] h-[20px]">close</mat-icon></button>
                      </div>
                    } @else {
                      <button (click)="startAssign(res.id)" class="w-full sm:w-auto bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm flex items-center justify-center gap-2">
                        <mat-icon class="text-[18px] w-[18px] h-[18px]">person_add</mat-icon> Assign
                      </button>
                    }
                  </div>
                }
              </div>
            }
            @if (displayedResources().length === 0) {
              <div class="p-12 text-center text-slate-500 font-medium italic">No resources found matching your criteria.</div>
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class StaffingComponent implements OnInit {
  private api = inject(ApiService);
  
  openRequests = signal<ResourceRequest[]>([]);
  allResources = signal<Resource[]>([]);
  selectedRequest = signal<ResourceRequest | null>(null);
  searchQuery = signal('');
  
  assigningResourceId = signal<string | null>(null);
  assignHours = signal<number>(0);

  displayedResources = computed(() => {
    let resources = this.allResources();
    const req = this.selectedRequest();
    
    if (req) {
      resources = resources.filter(r => {
        const roleMatch = r.role.toLowerCase() === req.requiredRole.toLowerCase();
        const skillMatch = r.skills.some(s => req.skills.includes(s.name));
        return roleMatch || skillMatch;
      });
      // Sort by utilization (lowest first)
      resources.sort((a, b) => a.utilization - b.utilization);
    }

    const query = this.searchQuery().toLowerCase().trim();
    if (query) {
      resources = resources.filter(r => 
        r.name.toLowerCase().includes(query) ||
        r.role.toLowerCase().includes(query) ||
        r.skills.some(s => s.name.toLowerCase().includes(query))
      );
    }

    return resources;
  });

  ngOnInit() {
    this.loadData();
  }

  loadData() {
    this.api.getRequests().subscribe(reqs => {
      this.openRequests.set(reqs.filter(r => r.status === 'Open' || r.status === 'Published'));
    });
    this.api.getResources().subscribe(res => {
      this.allResources.set(res);
    });
  }

  selectRequest(req: ResourceRequest) {
    this.selectedRequest.set(req);
    this.cancelAssign();
  }

  clearSelection() {
    this.selectedRequest.set(null);
    this.cancelAssign();
  }

  startAssign(resourceId: string) {
    const req = this.selectedRequest();
    if (req) {
      this.assigningResourceId.set(resourceId);
      const remaining = req.requiredEffort - (req.staffedEffort || 0);
      this.assignHours.set(remaining > 0 ? remaining : req.requiredEffort);
    }
  }

  cancelAssign() {
    this.assigningResourceId.set(null);
    this.assignHours.set(0);
  }

  confirmAssign(resourceId: string) {
    const req = this.selectedRequest();
    const hours = this.assignHours();
    if (req && hours > 0) {
      this.api.createAssignment({
        requestId: req.id,
        resourceId: resourceId,
        assignedHours: hours,
        status: 'hard-booked'
      }).subscribe(() => {
        this.cancelAssign();
        this.selectedRequest.set(null);
        this.loadData();
      });
    }
  }
}
