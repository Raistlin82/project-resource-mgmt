import { ChangeDetectionStrategy, Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-project-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Tasks</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Tasks</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">add</mat-icon> Create Task
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view tasks.</p>
          </div>
        } @else {
        <div class="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-100 text-slate-500">
              <tr>
                <th class="px-6 py-4 font-medium">Task</th>
                <th class="px-6 py-4 font-medium">Assignee</th>
                <th class="px-6 py-4 font-medium">Due Date</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium">Priority</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (task of filteredTasks(); track task.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ task.name }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ task.assignee }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ task.dueDate }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          [class.bg-emerald-50]="task.status === 'Done'" [class.text-emerald-700]="task.status === 'Done'"
                          [class.bg-blue-50]="task.status === 'In Progress'" [class.text-blue-700]="task.status === 'In Progress'"
                          [class.bg-slate-100]="task.status === 'To Do'" [class.text-slate-700]="task.status === 'To Do'">
                      {{ task.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          [class.bg-red-50]="task.priority === 'High'" [class.text-red-700]="task.priority === 'High'"
                          [class.bg-orange-50]="task.priority === 'Medium'" [class.text-orange-700]="task.priority === 'Medium'"
                          [class.bg-emerald-50]="task.priority === 'Low'" [class.text-emerald-700]="task.priority === 'Low'">
                      {{ task.priority }}
                    </span>
                  </td>
                </tr>
              }
              @if (filteredTasks().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-slate-500">No tasks found for this project.</td>
                </tr>
              }
            </tbody>
        </table>
      </div>
      }
    </div>

    <!-- Create Task Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
            <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Create Task</h2>
            <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          
          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="taskForm" (ngSubmit)="saveTask()" class="space-y-6">
              <div>
                <label for="taskName" class="block text-sm font-semibold text-slate-700 mb-1.5">Task Name *</label>
                <input id="taskName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Design Database Schema">
              </div>
              
              <div>
                <label for="taskAssignee" class="block text-sm font-semibold text-slate-700 mb-1.5">Assignee</label>
                <input id="taskAssignee" type="text" formControlName="assignee" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Jane Doe">
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label for="taskDueDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Due Date *</label>
                  <input id="taskDueDate" type="date" formControlName="dueDate" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                </div>
                
                <div>
                  <label for="taskPriority" class="block text-sm font-semibold text-slate-700 mb-1.5">Priority *</label>
                  <select id="taskPriority" formControlName="priority" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white">
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </div>
              </div>
            </form>
          </div>
          
          <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="saveTask()" [disabled]="!taskForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
              Create Task
            </button>
          </div>
        </div>
      </div>
    }
    </div>
  `
})
export class ProjectTasks implements OnInit {
  projectId = input<string>();
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  taskForm = new FormGroup({
    name: new FormControl('', Validators.required),
    assignee: new FormControl('Unassigned'),
    dueDate: new FormControl('', Validators.required),
    priority: new FormControl('Medium', Validators.required),
    status: new FormControl('To Do')
  });
  
  tasks = signal([
    { id: 'T1', projectId: 'P-1001', name: 'Finalize Requirements Document', assignee: 'Jane Doe', dueDate: 'Oct 15, 2023', status: 'Done', priority: 'High' },
    { id: 'T2', projectId: 'P-1001', name: 'Design Database Schema', assignee: 'John Smith', dueDate: 'Oct 25, 2023', status: 'In Progress', priority: 'Medium' },
    { id: 'T3', projectId: 'P-1002', name: 'Setup CI/CD Pipeline', assignee: 'Unassigned', dueDate: 'Nov 5, 2023', status: 'To Do', priority: 'Medium' }
  ]);

  filteredTasks = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.tasks().filter(t => t.projectId === pId);
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
    this.taskForm.reset({ priority: 'Medium', status: 'To Do', assignee: 'Unassigned' });
  }

  saveTask() {
    if (this.taskForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newTask = {
      id: 'T' + Math.floor(Math.random() * 10000),
      projectId: pId,
      ...this.taskForm.value
    } as any;

    this.tasks.update(t => [...t, newTask]);
    this.closeForm();
  }
}
