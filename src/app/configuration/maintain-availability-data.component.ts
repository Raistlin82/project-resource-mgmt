import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource } from '../services/api.service';

@Component({
  selector: 'app-maintain-availability-data',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Maintain Availability Data</h2>
        <div class="flex gap-3">
          <button (click)="triggerUpload()" class="bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
        </div>
      </div>

      <input type="file" id="csvUploadAvail" accept=".csv" class="hidden" (change)="onFileSelected($event)">

      <div class="p-6 sm:p-8">
        <div class="bg-indigo-50/50 border border-indigo-100/50 rounded-2xl p-5 mb-8">
          <div class="flex items-start gap-3">
            <mat-icon class="text-indigo-500 mt-0.5">info</mat-icon>
            <p class="text-sm text-slate-600 font-medium leading-relaxed">
              Maintain the workforce person availability data that is used in resource management. Download a template, edit it, and upload it back.
            </p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200/60">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/4">Resource ID</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Role</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (res of resources(); track res.id) {
                <tr class="border-b border-slate-100 hover:bg-slate-50/80 transition-colors group">
                  <td class="py-5 text-slate-500 font-mono text-xs font-bold">{{ res.id }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-indigo-700 transition-colors">{{ res.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-700 border border-slate-200/60">
                      {{ res.role }}
                    </span>
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="downloadTemplate(res)" class="text-indigo-600 hover:text-indigo-800 font-bold flex items-center justify-end gap-1.5 ml-auto bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Template
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
export class MaintainAvailabilityDataComponent implements OnInit {
  private api = inject(ApiService);
  resources = signal<Resource[]>([]);

  ngOnInit() {
    this.api.getResources().subscribe(res => this.resources.set(res));
  }

  triggerUpload() {
    document.getElementById('csvUploadAvail')?.click();
  }

  onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      alert(`File ${file.name} uploaded successfully. Availability data would be processed here.`);
      target.value = '';
    }
  }

  downloadTemplate(resource: Resource) {
    const csvContent = "resourceId,workForcePersonExternalId,firstName,lastName,s4costCenterId,companyCode,workAssignmentId,startDate,plannedWorkingHours,nonWorkingHours\n" +
      `${resource.id},EXT_${resource.id},${resource.name.split(' ')[0]},${resource.name.split(' ')[1] || ''},0012345678,COMP01,WA_01,2026-03-15,8,0\n`;
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `AvailabilityTemplate_${resource.id}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
