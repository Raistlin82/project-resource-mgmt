import { ChangeDetectionStrategy, Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-project-issues',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Issues</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Issues</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">add</mat-icon> Create Issue
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view issues.</p>
          </div>
        } @else {
        <div class="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-100 text-slate-500">
              <tr>
                <th class="px-6 py-4 font-medium">Issue</th>
                <th class="px-6 py-4 font-medium">Type</th>
                <th class="px-6 py-4 font-medium">Severity</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium">Reported By</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (issue of filteredIssues(); track issue.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ issue.title }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ issue.type }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          [ngClass]="{
                            'bg-red-50 text-red-700': issue.severity === 'High',
                            'bg-orange-50 text-orange-700': issue.severity === 'Medium',
                            'bg-green-50 text-green-700': issue.severity === 'Low'
                          }">
                      {{ issue.severity }}
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          [ngClass]="{
                            'bg-blue-50 text-blue-700': issue.status === 'Open',
                            'bg-slate-100 text-slate-700': issue.status === 'Mitigated' || issue.status === 'Closed'
                          }">
                      {{ issue.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-slate-600">{{ issue.reportedBy }}</td>
                </tr>
              }
              @if (filteredIssues().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-slate-500">No issues found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Report Issue Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Report Issue</h2>
              <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="issueForm" (ngSubmit)="saveIssue()" class="space-y-6">
                <div>
                  <label for="issueTitle" class="block text-sm font-semibold text-slate-700 mb-1.5">Title *</label>
                  <input id="issueTitle" type="text" formControlName="title" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. API Rate Limiting">
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="issueType" class="block text-sm font-semibold text-slate-700 mb-1.5">Type *</label>
                    <select id="issueType" formControlName="type" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                      <option value="Bug">Bug</option>
                      <option value="Risk">Risk</option>
                      <option value="Task">Task</option>
                    </select>
                  </div>
                  
                  <div>
                    <label for="issueSeverity" class="block text-sm font-semibold text-slate-700 mb-1.5">Severity *</label>
                    <select id="issueSeverity" formControlName="severity" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                      <option value="Critical">Critical</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label for="issueReportedBy" class="block text-sm font-semibold text-slate-700 mb-1.5">Reported By</label>
                  <input id="issueReportedBy" type="text" formControlName="reportedBy" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Jane Doe">
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveIssue()" [disabled]="!issueForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Report Issue
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectIssues implements OnInit {
  projectId = input<string>();
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  issueForm = new FormGroup({
    title: new FormControl('', Validators.required),
    type: new FormControl('Bug', Validators.required),
    severity: new FormControl('Medium', Validators.required),
    reportedBy: new FormControl('Current User')
  });
  
  issues = signal([
    { id: 'I1', projectId: 'P-1001', title: 'API Rate Limiting', type: 'Bug', severity: 'High', status: 'Open', reportedBy: 'Jane Doe' },
    { id: 'I2', projectId: 'P-1001', title: 'Delay in Hardware Delivery', type: 'Risk', severity: 'Medium', status: 'Mitigated', reportedBy: 'John Smith' },
    { id: 'I3', projectId: 'P-1002', title: 'UI Inconsistencies', type: 'Bug', severity: 'Low', status: 'Open', reportedBy: 'Alice Johnson' }
  ]);

  filteredIssues = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.issues().filter(i => i.projectId === pId);
  });

  ngOnInit() {
    this.api.getProjects().subscribe(p => this.projects.set(p));
  }

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      alert('Please select a project first.');
      return;
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.issueForm.reset({ type: 'Bug', severity: 'Medium', reportedBy: 'Current User' });
  }

  saveIssue() {
    if (this.issueForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newIssue = {
      id: 'I' + Math.floor(Math.random() * 10000),
      projectId: pId,
      status: 'Open',
      ...this.issueForm.value
    } as any;

    this.issues.update(i => [...i, newIssue]);
    this.closeForm();
  }
}
