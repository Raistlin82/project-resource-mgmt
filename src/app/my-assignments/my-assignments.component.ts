import { ChangeDetectionStrategy, Component, inject, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Assignment, ResourceRequest, Resource } from '../services/api.service';
import { CommonModule } from '@angular/common';
import { forkJoin } from 'rxjs';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-my-assignments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule],
  template: `
    <div class="max-w-6xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">My Assignments</h1>
        <div class="flex items-center gap-2 bg-white/80 backdrop-blur-md rounded-2xl shadow-sm border border-slate-200/60 p-1.5">
          <button (click)="viewMode.set('week')" 
                  [class.bg-indigo-50]="viewMode() === 'week'"
                  [class.text-indigo-700]="viewMode() === 'week'"
                  [class.shadow-sm]="viewMode() === 'week'"
                  [class.text-slate-500]="viewMode() !== 'week'"
                  [class.hover:bg-slate-50]="viewMode() !== 'week'"
                  class="px-5 py-2 rounded-xl text-sm font-bold tracking-wide transition-all">
            Week
          </button>
          <button (click)="viewMode.set('month')" 
                  [class.bg-indigo-50]="viewMode() === 'month'"
                  [class.text-indigo-700]="viewMode() === 'month'"
                  [class.shadow-sm]="viewMode() === 'month'"
                  [class.text-slate-500]="viewMode() !== 'month'"
                  [class.hover:bg-slate-50]="viewMode() !== 'month'"
                  class="px-5 py-2 rounded-xl text-sm font-bold tracking-wide transition-all">
            Month
          </button>
        </div>
      </div>

      <!-- Overview Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div class="bg-white/80 backdrop-blur-md p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200/60 hover:shadow-md transition-all group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">assignment</mat-icon>
            </div>
            <div>
              <p class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1">Active Assignments</p>
              <p class="text-3xl font-bold text-slate-900 tracking-tight">{{ activeAssignmentsCount() }}</p>
            </div>
          </div>
        </div>
        <div class="bg-white/80 backdrop-blur-md p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200/60 hover:shadow-md transition-all group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">schedule</mat-icon>
            </div>
            <div>
              <p class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Assigned Hours</p>
              <p class="text-3xl font-bold text-slate-900 tracking-tight">{{ totalAssignedHours() }}h</p>
            </div>
          </div>
        </div>
        <div class="bg-white/80 backdrop-blur-md p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200/60 hover:shadow-md transition-all group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-orange-50 text-orange-600 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">trending_up</mat-icon>
            </div>
            <div>
              <p class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1">Current Utilization</p>
              <p class="text-3xl font-bold text-slate-900 tracking-tight" [ngClass]="getUtilizationColorText(currentUtilization())">
                {{ currentUtilization() | number:'1.0-0' }}%
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Calendar View -->
      <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <h2 class="text-xl font-bold text-slate-900 tracking-tight">
            {{ viewMode() === 'week' ? 'Weekly Schedule' : 'Monthly Overview' }}
          </h2>
          <div class="flex items-center gap-3">
            <button class="w-8 h-8 rounded-full hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_left</mat-icon>
            </button>
            <span class="text-sm font-bold tracking-wide text-slate-700 uppercase">Current {{ viewMode() === 'week' ? 'Week' : 'Month' }}</span>
            <button class="w-8 h-8 rounded-full hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_right</mat-icon>
            </button>
          </div>
        </div>
        
        <div class="p-6 sm:p-8 overflow-x-auto">
          @if (viewMode() === 'week') {
            <table class="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr class="text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200/60">
                  <th class="pb-4 pr-4 w-1/4">Project / Request</th>
                  <th class="pb-4 px-2 text-center">Mon</th>
                  <th class="pb-4 px-2 text-center">Tue</th>
                  <th class="pb-4 px-2 text-center">Wed</th>
                  <th class="pb-4 px-2 text-center">Thu</th>
                  <th class="pb-4 px-2 text-center">Fri</th>
                  <th class="pb-4 pl-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (assignment of myAssignments(); track assignment.id) {
                  <tr class="text-sm text-slate-700 hover:bg-slate-50/80 transition-colors group">
                    <td class="py-5 pr-4">
                      <div class="font-bold text-slate-900">{{ getRequestName(assignment.requestId) }}</div>
                      <div class="text-xs font-semibold tracking-wide text-slate-500 mt-1 uppercase">{{ assignment.status }}</div>
                    </td>
                    <!-- Mock daily hours distribution -->
                    <td class="py-5 px-2 text-center">
                      <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 font-bold shadow-sm group-hover:bg-indigo-100 transition-colors">
                        {{ Math.round(assignment.assignedHours / 5) }}
                      </div>
                    </td>
                    <td class="py-5 px-2 text-center">
                      <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 font-bold shadow-sm group-hover:bg-indigo-100 transition-colors">
                        {{ Math.round(assignment.assignedHours / 5) }}
                      </div>
                    </td>
                    <td class="py-5 px-2 text-center">
                      <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 font-bold shadow-sm group-hover:bg-indigo-100 transition-colors">
                        {{ Math.round(assignment.assignedHours / 5) }}
                      </div>
                    </td>
                    <td class="py-5 px-2 text-center">
                      <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 font-bold shadow-sm group-hover:bg-indigo-100 transition-colors">
                        {{ Math.round(assignment.assignedHours / 5) }}
                      </div>
                    </td>
                    <td class="py-5 px-2 text-center">
                      <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 font-bold shadow-sm group-hover:bg-indigo-100 transition-colors">
                        {{ assignment.assignedHours - (Math.round(assignment.assignedHours / 5) * 4) }}
                      </div>
                    </td>
                    <td class="py-5 pl-4 text-right font-bold text-slate-900 text-lg">
                      {{ assignment.assignedHours }}h
                    </td>
                  </tr>
                }
                @if (!myAssignments().length) {
                  <tr>
                    <td colspan="7" class="py-12 text-center text-slate-500 font-medium italic">No assignments found for this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <!-- Monthly View -->
            <div class="grid grid-cols-7 gap-px bg-slate-200 rounded-xl overflow-hidden border border-slate-200">
              <!-- Days of week header -->
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Mon</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Tue</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Wed</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Thu</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Fri</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Sat</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Sun</div>
              
              <!-- Mock Calendar Grid -->
              @for (day of mockDays; track day.date) {
                <div class="bg-white min-h-[100px] p-2 hover:bg-slate-50 transition-colors" [class.opacity-50]="!day.isCurrentMonth">
                  <div class="text-right text-xs font-medium text-slate-500 mb-2">{{ day.date }}</div>
                  @if (day.isCurrentMonth && day.date % 2 !== 0 && myAssignments().length > 0) {
                    <div class="space-y-1">
                      <div class="text-[10px] font-medium bg-indigo-100 text-indigo-700 px-2 py-1 rounded truncate" [title]="getRequestName(myAssignments()[0].requestId)">
                        {{ getRequestName(myAssignments()[0].requestId) }}
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      </div>

      <!-- Assignment Details & Editing -->
      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div class="p-6 border-b border-slate-100 bg-slate-50">
          <h2 class="text-lg font-medium text-slate-900">Assignment Details</h2>
        </div>
        <div class="p-6">
          <div class="space-y-4">
            @for (assignment of myAssignments(); track assignment.id) {
              <div class="p-5 rounded-xl border border-slate-200 bg-white hover:border-indigo-200 transition-colors">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div class="flex-1">
                    <h3 class="text-lg font-medium text-slate-900">{{ getRequestName(assignment.requestId) }}</h3>
                    <div class="flex items-center gap-4 mt-2 text-sm text-slate-500">
                      <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">business</mat-icon> Client Project</span>
                      <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">info</mat-icon> <span class="capitalize">{{ assignment.status }}</span></span>
                    </div>
                  </div>
                  
                  <div class="flex items-center gap-4">
                    @if (editingAssignmentId() === assignment.id) {
                      <div class="flex items-center gap-2">
                        <input type="number" [(ngModel)]="editHours" class="w-20 px-3 py-1.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm">
                        <span class="text-sm text-slate-500">hours</span>
                        <button (click)="saveAssignment(assignment)" class="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                          <mat-icon>check</mat-icon>
                        </button>
                        <button (click)="cancelEdit()" class="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors">
                          <mat-icon>close</mat-icon>
                        </button>
                      </div>
                    } @else {
                      <div class="text-right">
                        <div class="text-xl font-semibold text-slate-900">{{ assignment.assignedHours }}h</div>
                        <div class="text-xs text-slate-500 uppercase tracking-wider">Total Assigned</div>
                      </div>
                      <button (click)="startEdit(assignment)" class="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Edit Hours">
                        <mat-icon>edit</mat-icon>
                      </button>
                    }
                  </div>
                </div>
              </div>
            }
            @if (!myAssignments().length) {
              <div class="text-center py-8 text-slate-500">
                You don't have any active assignments.
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class MyAssignmentsComponent implements OnInit {
  private api = inject(ApiService);
  
  // Mocking current user ID
  private currentUserId = '1';

  myAssignments = signal<Assignment[]>([]);
  allRequests = signal<ResourceRequest[]>([]);
  profile = signal<Resource | null>(null);
  
  viewMode = signal<'week' | 'month'>('week');
  editingAssignmentId = signal<string | null>(null);
  editHours = 0;

  Math = Math;

  // Mock calendar days for month view
  mockDays = Array.from({ length: 35 }, (_, i) => {
    const isCurrentMonth = i >= 3 && i < 34;
    return {
      date: isCurrentMonth ? i - 2 : (i < 3 ? 28 + i : i - 33),
      isCurrentMonth
    };
  });

  activeAssignmentsCount = computed(() => this.myAssignments().filter(a => a.status !== 'completed').length);
  totalAssignedHours = computed(() => this.myAssignments().reduce((sum, a) => sum + a.assignedHours, 0));
  currentUtilization = computed(() => {
    const p = this.profile();
    if (!p || !p.capacity) return 0;
    // Assuming capacity is weekly, multiply by 4 for monthly approx
    return (this.totalAssignedHours() / (p.capacity * 4)) * 100;
  });

  ngOnInit() {
    this.loadData();
  }

  loadData() {
    forkJoin({
      assignments: this.api.getAssignments(),
      requests: this.api.getRequests(),
      profile: this.api.getResource(this.currentUserId)
    }).subscribe(({ assignments, requests, profile }) => {
      this.myAssignments.set(assignments.filter(a => a.resourceId === this.currentUserId));
      this.allRequests.set(requests);
      this.profile.set(profile);
    });
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  getUtilizationColorText(utilization: number): string {
    if (utilization > 110) return 'text-red-600';
    if (utilization >= 80) return 'text-emerald-600';
    return 'text-orange-600';
  }

  startEdit(assignment: Assignment) {
    this.editingAssignmentId.set(assignment.id);
    this.editHours = assignment.assignedHours;
  }

  cancelEdit() {
    this.editingAssignmentId.set(null);
  }

  saveAssignment(assignment: Assignment) {
    if (this.editHours >= 0) {
      this.api.updateAssignment(assignment.id, { assignedHours: this.editHours }).subscribe(() => {
        this.loadData();
        this.cancelEdit();
      });
    }
  }
}
