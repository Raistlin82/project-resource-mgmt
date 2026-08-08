import { Component, inject, computed, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ConfigurationPageShellComponent } from './configuration-page-shell.component';

@Component({
  selector: 'app-maintain-availability-data',
  imports: [MatIconModule, ConfigurationPageShellComponent],
  template: `
    <app-configuration-page-shell
      title="Maintain Availability Data"
      subtitle="Download workforce availability templates and review the resources they apply to.">
      <button configuration-actions type="button" disabled aria-describedby="availabilityImportStatus"
              class="command-button secondary disabled:cursor-not-allowed disabled:opacity-60">
        <mat-icon class="text-[18px] w-[18px] h-[18px]">hourglass_top</mat-icon> CSV import coming soon
      </button>
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Availability records</h2>
      </div>

      <div class="p-6 sm:p-8">
        <div class="bg-accent-tint border border-accent rounded-lg p-5 mb-8">
          <div class="flex items-start gap-3">
            <mat-icon class="text-accent-text mt-0.5">info</mat-icon>
            <p class="text-sm text-[var(--cc-muted)] font-medium leading-relaxed">
              Maintain the workforce person availability data used in resource management. Templates can be downloaded now; CSV import is not available in this release.
            </p>
          </div>
          <p id="availabilityImportStatus" class="mt-3 text-sm font-semibold text-accent-text">Import is visibly disabled so selecting a local file never ends in an unsupported flow.</p>
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
    </app-configuration-page-shell>
  `
})
export class MaintainAvailabilityDataComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private platformId = inject(PLATFORM_ID);

  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [],
  });
  resources = computed(() => this.resourcesRes.value());

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
