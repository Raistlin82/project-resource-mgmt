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
    <div class="command-page space-y-6">
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Maintain Availability Data</h2>
        <div class="flex gap-3">
          <button (click)="triggerUpload()" class="command-button">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">upload_file</mat-icon> Upload CSV
          </button>
        </div>
      </div>

      <input type="file" id="csvUploadAvail" accept=".csv" class="hidden" (change)="onFileSelected($event)">

      <div class="p-6 sm:p-8">
        <div class="bg-accent-tint border border-accent rounded-lg p-5 mb-8">
          <div class="flex items-start gap-3">
            <mat-icon class="text-accent-text mt-0.5">info</mat-icon>
            <p class="text-sm text-[var(--cc-muted)] font-medium leading-relaxed">
              Maintain the workforce person availability data that is used in resource management. Download a template, edit it, and upload it back.
            </p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="w-1/4">Resource ID</th>
                <th class="w-1/3">Name</th>
                <th>Role</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (res of resources(); track res.id) {
                <tr>
                  <td><span class="text-accent-text font-mono text-xs font-bold">{{ res.id }}</span></td>
                  <td class="font-bold text-base">{{ res.name }}</td>
                  <td>
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-surface-muted text-ink-secondary ring-1 ring-line">
                      {{ res.role }}
                    </span>
                  </td>
                  <td>
                    <div class="flex justify-end">
                      <button (click)="downloadTemplate(res)" class="command-button secondary">
                        <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Template
                      </button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
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
