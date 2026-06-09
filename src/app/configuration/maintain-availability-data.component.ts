import { Component, inject, computed, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-maintain-availability-data',
  imports: [MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Maintain Availability Data</h2>
        <div class="flex gap-3">
          <button (click)="triggerUpload()" class="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 shadow-sm hover:-translate-y-0.5">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
        </div>
      </div>

      <input type="file" id="csvUploadAvail" accept=".csv" class="hidden" (change)="onFileSelected($event)">

      <div class="p-6 sm:p-8">
        <div class="bg-blue-50 border border-blue-200 rounded-2xl p-5 mb-8">
          <div class="flex items-start gap-3">
            <mat-icon class="text-blue-700 mt-0.5">info</mat-icon>
            <p class="text-sm text-slate-600 font-medium leading-relaxed">
              Maintain the workforce person availability data that is used in resource management. Download a template, edit it, and upload it back.
            </p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/4">Resource ID</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Role</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (res of resources(); track res.id) {
                <tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors group">
                  <td class="py-5 text-blue-700 font-mono text-xs font-bold">{{ res.id }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ res.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-700 ring-1 ring-slate-200">
                      {{ res.role }}
                    </span>
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="downloadTemplate(res)" class="text-blue-700 hover:text-blue-800 font-bold flex items-center justify-end gap-1.5 ml-auto bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200 px-3 py-1.5 rounded-lg transition-colors">
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
export class MaintainAvailabilityDataComponent {
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private platformId = inject(PLATFORM_ID);

  private resourcesRes = rxResource({ stream: () => this.api.getResources(), defaultValue: [] });
  resources = computed(() => this.resourcesRes.value());

  triggerUpload() {
    if (!isPlatformBrowser(this.platformId)) return;
    document.getElementById('csvUploadAvail')?.click();
  }

  onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      this.notificationService.show('Availability upload is not available yet', 'info');
      target.value = '';
    }
  }

  private escapeCsv(value: string): string {
    let escaped = value;
    if (/^[=+\-@\t\r]/.test(escaped)) {
      escaped = `'${escaped}`;
    }
    if (/[",\n\r]/.test(escaped)) {
      escaped = `"${escaped.replace(/"/g, '""')}"`;
    }
    return escaped;
  }

  downloadTemplate(resource: Resource) {
    if (!isPlatformBrowser(this.platformId)) return;

    const id = this.escapeCsv(resource.id);
    const firstName = this.escapeCsv(resource.name.split(' ')[0]);
    const lastName = this.escapeCsv(resource.name.split(' ')[1] || '');
    const externalId = this.escapeCsv(`EXT_${resource.id}`);

    const csvContent = "resourceId,workForcePersonExternalId,firstName,lastName,s4costCenterId,companyCode,workAssignmentId,startDate,plannedWorkingHours,nonWorkingHours\n" +
      `${id},${externalId},${firstName},${lastName},0012345678,COMP01,WA_01,2026-03-15,8,0\n`;

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
