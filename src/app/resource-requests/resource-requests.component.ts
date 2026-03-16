import { ChangeDetectionStrategy, Component, inject, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Assignment, Resource } from '../services/api.service';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { forkJoin } from 'rxjs';

@Component({
  selector: 'app-resource-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, CommonModule],
  template: `
    <div class="max-w-7xl mx-auto space-y-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Manage Resource Requests</h1>
          <p class="text-slate-500 mt-1">Create and manage staffing requests for your projects.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="bg-slate-100/80 backdrop-blur-sm p-1 rounded-xl flex items-center shadow-inner">
            <button (click)="currentView.set('requests')" 
                    [class.bg-white]="currentView() === 'requests'"
                    [class.shadow-sm]="currentView() === 'requests'"
                    [class.text-slate-900]="currentView() === 'requests'"
                    [class.text-slate-500]="currentView() !== 'requests'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Requests
            </button>
            <button (click)="currentView.set('availability')" 
                    [class.bg-white]="currentView() === 'availability'"
                    [class.shadow-sm]="currentView() === 'availability'"
                    [class.text-slate-900]="currentView() === 'availability'"
                    [class.text-slate-500]="currentView() !== 'availability'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Resource Availability
            </button>
          </div>
          @if (currentView() === 'requests') {
            <button (click)="openCreateForm()" class="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition-all duration-200 shadow-sm hover:shadow-md active:scale-95">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Request
            </button>
          }
        </div>
      </div>

      @if (currentView() === 'requests') {
        @if (showForm()) {
          <div class="bg-white p-8 rounded-3xl shadow-sm border border-slate-200/60 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 to-purple-500"></div>
            <h2 class="text-2xl font-bold text-slate-900 mb-8">{{ editingId() ? 'Edit Request' : 'New Resource Request' }}</h2>
            <form [formGroup]="requestForm" (ngSubmit)="saveRequest()" class="space-y-6">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-1.5">
                  <label for="name" class="block text-sm font-semibold text-slate-700">Project Name <span class="text-red-500">*</span></label>
                  <input id="name" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none">
                </div>
                <div class="space-y-1.5">
                  <label for="requiredRole" class="block text-sm font-semibold text-slate-700">Required Role <span class="text-red-500">*</span></label>
                  <input id="requiredRole" formControlName="requiredRole" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none">
                </div>
                <div class="space-y-1.5">
                  <label for="requiredEffort" class="block text-sm font-semibold text-slate-700">Required Effort (Hours) <span class="text-red-500">*</span></label>
                  <input id="requiredEffort" type="number" formControlName="requiredEffort" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none">
                </div>
                <div class="space-y-1.5">
                  <label for="skills" class="block text-sm font-semibold text-slate-700">Required Skill</label>
                  <input id="skills" formControlName="skills" placeholder="e.g. Java, Angular, React" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none">
                </div>
                <div class="space-y-1.5">
                  <label for="startDate" class="block text-sm font-semibold text-slate-700">Start Date</label>
                  <input id="startDate" type="date" formControlName="startDate" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none text-slate-700">
                </div>
                <div class="space-y-1.5">
                  <label for="endDate" class="block text-sm font-semibold text-slate-700">End Date</label>
                  <input id="endDate" type="date" formControlName="endDate" class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none text-slate-700">
                </div>
              </div>
              <div class="space-y-1.5">
                <label for="description" class="block text-sm font-semibold text-slate-700">Description</label>
                <textarea id="description" formControlName="description" rows="4" placeholder="Provide details about the project and the role..." class="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none resize-y"></textarea>
              </div>
              <div class="flex justify-end gap-3 pt-6 border-t border-slate-100">
                <button type="button" (click)="closeForm()" class="px-6 py-2.5 rounded-xl font-semibold text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
                <button type="submit" [disabled]="!requestForm.valid" class="bg-indigo-600 text-white px-8 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition-all duration-200 shadow-sm hover:shadow-md disabled:opacity-50 disabled:hover:shadow-sm disabled:hover:bg-indigo-600 active:scale-95">Save Request</button>
              </div>
            </form>
          </div>
        }

        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr class="bg-slate-50/80 border-b border-slate-200/60">
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Project Details</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Role & Skills</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Staffing Status</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">State</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (req of myRequests(); track req.id) {
                  <tr class="hover:bg-slate-50/80 transition-colors group">
                    <td class="px-6 py-5">
                      <div class="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors">{{ req.name }}</div>
                      <div class="text-xs font-medium text-slate-500 mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon> {{ req.startDate || 'TBD' }} to {{ req.endDate || 'TBD' }}</div>
                      @if (req.description) {
                        <div class="text-xs text-slate-400 mt-1.5 truncate max-w-[200px]" [title]="req.description">{{ req.description }}</div>
                      }
                    </td>
                    <td class="px-6 py-5">
                      <div class="text-slate-900 font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-slate-400">badge</mat-icon> {{ req.requiredRole }}</div>
                      <div class="text-xs font-medium text-slate-500 mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px] text-slate-400">psychology</mat-icon> {{ req.skills.join(', ') || 'No specific skills' }}</div>
                    </td>
                    <td class="px-6 py-5">
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-slate-700">{{ req.staffedEffort || 0 }} / {{ req.requiredEffort }}h</span>
                          <span [class.text-emerald-600]="getStaffingPercentage(req) >= 100"
                                [class.text-amber-600]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                                [class.text-slate-500]="getStaffingPercentage(req) === 0">
                            {{ getStaffingPercentage(req) | number:'1.0-0' }}%
                          </span>
                        </div>
                        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                          <div class="h-2 rounded-full transition-all duration-1000 ease-out" 
                               [class.bg-emerald-500]="getStaffingPercentage(req) >= 100"
                               [class.bg-amber-500]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                               [class.bg-slate-300]="getStaffingPercentage(req) === 0"
                               [style.width.%]="getStaffingPercentage(req)"></div>
                        </div>
                      </div>
                    </td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide"
                        [class.bg-emerald-100]="req.status === 'Published'"
                        [class.text-emerald-800]="req.status === 'Published'"
                        [class.bg-slate-100]="req.status === 'Not Published'"
                        [class.text-slate-800]="req.status === 'Not Published'"
                        [class.bg-blue-100]="req.status === 'Open'"
                        [class.text-blue-800]="req.status === 'Open'"
                        [class.bg-emerald-100]="req.status === 'Fulfilled'"
                        [class.text-emerald-800]="req.status === 'Fulfilled'"
                        [class.bg-orange-100]="req.status === 'Withdrawn'"
                        [class.text-orange-800]="req.status === 'Withdrawn'">
                        {{ req.status }}
                      </span>
                    </td>
                    <td class="px-6 py-5 text-right space-x-1">
                      @if (req.status !== 'Not Published' && req.status !== 'Withdrawn') {
                        <button (click)="trackRequest(req)" class="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all" title="Track Staffing">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">analytics</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Not Published' || req.status === 'Withdrawn') {
                        <button (click)="openEditForm(req)" class="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all" title="Edit">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                        </button>
                        <button (click)="publishRequest(req)" class="p-2 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all" title="Publish">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">publish</mat-icon>
                        </button>
                        <button (click)="deleteRequest(req)" class="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all" title="Delete">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Published' || req.status === 'Open' || req.status === 'Fulfilled') {
                        <button (click)="withdrawRequest(req)" class="p-2 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all" title="Withdraw">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">undo</mat-icon>
                        </button>
                      }
                    </td>
                  </tr>
                }
                @if (!myRequests().length) {
                  <tr>
                    <td colspan="5" class="px-6 py-12 text-center text-slate-400">
                      <div class="flex flex-col items-center justify-center">
                        <mat-icon class="text-4xl mb-3 opacity-50">assignment</mat-icon>
                        <p class="font-medium">No resource requests found.</p>
                        <p class="text-sm mt-1">Create one to get started.</p>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      } @else {
        <!-- Resource Availability View -->
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col">
          <div class="p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white/50 backdrop-blur-sm">
            <h2 class="text-lg font-semibold text-slate-900">Resource Availability</h2>
            <div class="relative w-full sm:w-auto">
              <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input 
                type="text" 
                [formControl]="availabilitySearch"
                placeholder="Search by name, role, or skills..." 
                class="w-full sm:w-72 pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all duration-200 outline-none text-sm"
              >
            </div>
          </div>
          <div class="overflow-x-auto flex-1">
            <table class="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr class="bg-slate-50/80 border-b border-slate-200/60">
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Resource</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Role & Skills</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Capacity</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Utilization</th>
                  <th class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Availability</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (res of filteredAvailability(); track res.id) {
                  <tr class="hover:bg-slate-50/80 transition-colors group">
                    <td class="px-6 py-5">
                      <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-gradient-to-br from-slate-100 to-slate-200 rounded-full flex items-center justify-center text-slate-600 font-semibold text-lg shadow-inner shrink-0">
                          {{ res.name.charAt(0) }}
                        </div>
                        <div class="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors">{{ res.name }}</div>
                      </div>
                    </td>
                    <td class="px-6 py-5">
                      <div class="text-slate-900 font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-slate-400">badge</mat-icon> {{ res.role }}</div>
                      <div class="flex gap-1.5 mt-2 flex-wrap">
                        @for (skill of res.skills; track skill.name) {
                          <span class="text-[11px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md border border-slate-200/60">{{ skill.name }}</span>
                        }
                      </div>
                    </td>
                    <td class="px-6 py-5">
                      <div class="text-slate-700 font-medium flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-slate-400">schedule</mat-icon> {{ res.capacity }}h / week</div>
                    </td>
                    <td class="px-6 py-5">
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-slate-700">Utilization</span>
                          <span [class.text-emerald-600]="res.utilization >= 80 && res.utilization <= 100"
                                [class.text-amber-600]="res.utilization > 0 && res.utilization < 80"
                                [class.text-red-600]="res.utilization > 100"
                                [class.text-slate-500]="res.utilization === 0">
                            {{ res.utilization | number:'1.0-0' }}%
                          </span>
                        </div>
                        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                          <div class="h-2 rounded-full transition-all duration-1000 ease-out" 
                               [class.bg-emerald-500]="res.utilization >= 80 && res.utilization <= 100"
                               [class.bg-amber-500]="res.utilization > 0 && res.utilization < 80"
                               [class.bg-red-500]="res.utilization > 100"
                               [class.bg-slate-300]="res.utilization === 0"
                               [style.width.%]="res.utilization > 100 ? 100 : res.utilization"></div>
                        </div>
                      </div>
                    </td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-3 py-1.5 rounded-xl text-xs font-semibold tracking-wide"
                            [class.bg-emerald-100]="getAvailableHours(res) > 0"
                            [class.text-emerald-800]="getAvailableHours(res) > 0"
                            [class.bg-slate-100]="getAvailableHours(res) <= 0"
                            [class.text-slate-600]="getAvailableHours(res) <= 0">
                        {{ getAvailableHours(res) > 0 ? getAvailableHours(res) + 'h available' : 'Fully booked' }}
                      </span>
                    </td>
                  </tr>
                }
                @if (!filteredAvailability().length) {
                  <tr>
                    <td colspan="5" class="px-6 py-12 text-center text-slate-400">
                      <div class="flex flex-col items-center justify-center">
                        <mat-icon class="text-4xl mb-3 opacity-50">search_off</mat-icon>
                        <p class="font-medium">No resources found matching your search.</p>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }

      @if (trackingDetails()) {
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="p-6 sm:p-8 border-b border-slate-100 flex items-start justify-between bg-gradient-to-br from-slate-50 to-white">
              <div>
                <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Staffing Progress</h2>
                <p class="text-sm font-medium text-slate-500 mt-1.5 flex items-center gap-1.5">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">work_outline</mat-icon>
                  {{ trackingDetails()?.request?.name }}
                </p>
              </div>
              <button (click)="closeTracking()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <!-- Progress Bar -->
              <div class="mb-10 bg-slate-50 p-6 rounded-2xl border border-slate-100/60">
                <div class="flex justify-between items-end mb-3">
                  <span class="font-semibold text-slate-700">Overall Progress</span>
                  <span class="text-2xl font-bold text-indigo-600 tracking-tight">{{ getStaffingPercentage(trackingDetails()!.request) }}%</span>
                </div>
                <div class="w-full bg-slate-200/60 rounded-full h-3 overflow-hidden shadow-inner">
                  <div class="h-3 rounded-full transition-all duration-1000 ease-out relative"
                       [class.bg-emerald-500]="getStaffingPercentage(trackingDetails()!.request) >= 100"
                       [class.bg-amber-500]="getStaffingPercentage(trackingDetails()!.request) > 0 && getStaffingPercentage(trackingDetails()!.request) < 100"
                       [class.bg-slate-300]="getStaffingPercentage(trackingDetails()!.request) === 0"
                       [style.width.%]="getStaffingPercentage(trackingDetails()!.request)">
                    <div class="absolute inset-0 bg-white/20 w-full h-full"></div>
                  </div>
                </div>
                <div class="flex justify-between text-sm font-medium text-slate-500 mt-3">
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-emerald-500">check_circle</mat-icon> {{ trackingDetails()?.request?.staffedEffort || 0 }}h Staffed</span>
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-amber-500">pending</mat-icon> {{ trackingDetails()?.remaining }}h Remaining of {{ trackingDetails()?.request?.requiredEffort }}h</span>
                </div>
              </div>

              <!-- Assigned Resources -->
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-sm font-bold text-slate-900 uppercase tracking-wider">Assigned Resources</h3>
                <span class="bg-indigo-50 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-full">{{ trackingDetails()?.assignments?.length || 0 }}</span>
              </div>
              
              <div class="space-y-3">
                @for (item of trackingDetails()?.assignments; track item.assignment.id) {
                  <div class="flex items-center justify-between p-4 rounded-2xl border border-slate-100 bg-white hover:border-indigo-100 hover:shadow-md transition-all group">
                    <div class="flex items-center gap-4">
                      <div class="w-12 h-12 bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100/50 rounded-full flex items-center justify-center text-indigo-600 font-bold shadow-sm shrink-0">
                        {{ item.resource?.name?.charAt(0) || '?' }}
                      </div>
                      <div>
                        <h4 class="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors">{{ item.resource?.name || 'Unknown Resource' }}</h4>
                        <p class="text-xs font-medium text-slate-500 mt-0.5 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">badge</mat-icon> {{ item.resource?.role }}</p>
                      </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-1">
                      <div class="font-bold text-indigo-600 text-lg">{{ item.assignment.assignedHours }}h</div>
                      <div class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                           [class.bg-emerald-100]="item.assignment.status === 'confirmed'"
                           [class.text-emerald-700]="item.assignment.status === 'confirmed'"
                           [class.bg-amber-100]="item.assignment.status === 'proposed'"
                           [class.text-amber-700]="item.assignment.status === 'proposed'">
                        {{ item.assignment.status }}
                      </div>
                    </div>
                  </div>
                }
                @if (trackingDetails()?.assignments?.length === 0) {
                  <div class="text-center p-8 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
                    <div class="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-slate-100">
                      <mat-icon class="text-slate-300 text-3xl">person_add_disabled</mat-icon>
                    </div>
                    <p class="font-medium text-slate-600">No resources assigned yet</p>
                    <p class="text-sm text-slate-400 mt-1">Assignments will appear here once staffed.</p>
                  </div>
                }
              </div>
            </div>
            
            <div class="p-6 border-t border-slate-100 bg-slate-50/80 flex justify-end backdrop-blur-sm">
              <button (click)="closeTracking()" class="px-6 py-2.5 bg-white border border-slate-200 rounded-xl font-semibold text-slate-700 hover:bg-slate-50 hover:text-slate-900 shadow-sm transition-all">Close</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ResourceRequestsComponent implements OnInit {
  private api = inject(ApiService);
  
  // Mocking current user ID for authorization
  private currentUserId = '1';

  requests = signal<ResourceRequest[]>([]);
  assignments = signal<Assignment[]>([]);
  resources = signal<Resource[]>([]);
  showForm = signal(false);
  editingId = signal<string | null>(null);
  trackingRequestId = signal<string | null>(null);
  currentView = signal<'requests' | 'availability'>('requests');
  
  availabilitySearch = new FormControl('');
  searchValue = signal('');

  // Authorization: Only show requests created by the current user
  myRequests = computed(() => this.requests().filter(r => r.requesterId === this.currentUserId));

  filteredAvailability = computed(() => {
    const search = this.searchValue().toLowerCase();
    return this.resources().filter(res => {
      if (!search) return true;
      const matchesName = res.name.toLowerCase().includes(search);
      const matchesRole = res.role.toLowerCase().includes(search);
      const matchesSkills = res.skills.some(s => s.name.toLowerCase().includes(search));
      return matchesName || matchesRole || matchesSkills;
    });
  });

  getAvailableHours(res: Resource): number {
    const utilizedHours = (res.capacity * res.utilization) / 100;
    return Math.max(0, Math.round(res.capacity - utilizedHours));
  }

  trackingDetails = computed(() => {
    const reqId = this.trackingRequestId();
    if (!reqId) return null;
    const req = this.requests().find(r => r.id === reqId);
    if (!req) return null;

    const reqAssignments = this.assignments().filter(a => a.requestId === reqId);
    const staffedResources = reqAssignments.map(a => {
      const res = this.resources().find(r => r.id === a.resourceId);
      return {
        assignment: a,
        resource: res
      };
    });

    return {
      request: req,
      assignments: staffedResources,
      remaining: Math.max(0, req.requiredEffort - (req.staffedEffort || 0))
    };
  });

  requestForm = new FormGroup({
    name: new FormControl('', Validators.required),
    requiredRole: new FormControl('', Validators.required),
    requiredEffort: new FormControl(0, [Validators.required, Validators.min(1)]),
    skills: new FormControl(''),
    description: new FormControl(''),
    startDate: new FormControl(''),
    endDate: new FormControl('')
  });

  ngOnInit() {
    this.loadRequests();
    this.availabilitySearch.valueChanges.subscribe(val => {
      this.searchValue.set(val || '');
    });
  }

  loadRequests() {
    forkJoin({
      requests: this.api.getRequests(),
      assignments: this.api.getAssignments(),
      resources: this.api.getResources()
    }).subscribe(data => {
      this.requests.set(data.requests);
      this.assignments.set(data.assignments);
      this.resources.set(data.resources);
    });
  }

  trackRequest(req: ResourceRequest) {
    this.trackingRequestId.set(req.id);
  }

  closeTracking() {
    this.trackingRequestId.set(null);
  }

  openCreateForm() {
    this.editingId.set(null);
    this.requestForm.reset({ requiredEffort: 0 });
    this.showForm.set(true);
  }

  openEditForm(req: ResourceRequest) {
    this.editingId.set(req.id);
    this.requestForm.patchValue({
      name: req.name,
      requiredRole: req.requiredRole,
      requiredEffort: req.requiredEffort,
      skills: req.skills.join(', '),
      description: req.description || '',
      startDate: req.startDate || '',
      endDate: req.endDate || ''
    });
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.requestForm.reset();
  }

  saveRequest() {
    if (this.requestForm.valid) {
      const val = this.requestForm.value;
      const reqData: Partial<ResourceRequest> = {
        name: val.name || '',
        requiredRole: val.requiredRole || '',
        requiredEffort: val.requiredEffort || 0,
        skills: val.skills ? val.skills.split(',').map(s => s.trim()).filter(s => s) : [],
        description: val.description || '',
        startDate: val.startDate || '',
        endDate: val.endDate || '',
        requesterId: this.currentUserId
      };

      if (this.editingId()) {
        this.api.updateRequest(this.editingId()!, reqData).subscribe(() => {
          this.loadRequests();
          this.closeForm();
        });
      } else {
        this.api.createRequest(reqData).subscribe(() => {
          this.loadRequests();
          this.closeForm();
        });
      }
    }
  }

  publishRequest(req: ResourceRequest) {
    this.api.updateRequest(req.id, { status: 'Published' }).subscribe(() => {
      this.loadRequests();
    });
  }

  withdrawRequest(req: ResourceRequest) {
    // Can only withdraw if unstaffed or partially staffed, but let's allow it generally for the demo
    this.api.updateRequest(req.id, { status: 'Withdrawn' }).subscribe(() => {
      this.loadRequests();
    });
  }

  deleteRequest(req: ResourceRequest) {
    // In a real app, use a custom modal here instead of window.confirm
    this.api.deleteRequest(req.id).subscribe(() => {
      this.loadRequests();
    });
  }

  getStaffingPercentage(req: ResourceRequest): number {
    if (!req.requiredEffort) return 0;
    const staffed = req.staffedEffort || 0;
    return Math.min(100, Math.round((staffed / req.requiredEffort) * 100));
  }
}
