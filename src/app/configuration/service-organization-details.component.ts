import { Component, inject, computed, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ServiceOrganization } from '../services/api.service';

@Component({
  selector: 'app-service-organization-details',
  imports: [MatIconModule],
  template: `
    <div class="bg-surface rounded-xl shadow-sm ring-1 ring-line border border-line overflow-hidden hover:shadow-md transition-shadow">
      <div class="p-6 border-b border-line flex justify-between items-center bg-surface-muted">
        <h2 class="text-lg font-semibold text-ink">Service Organization Details</h2>
        <button (click)="exportToSpreadsheet()" class="bg-surface text-ink-secondary border border-line-strong px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface-muted transition-colors flex items-center gap-2">
          <mat-icon class="text-sm">file_download</mat-icon> Export to Spreadsheet
        </button>
      </div>

      <div class="p-6">
        <p class="text-sm text-ink-muted mb-6">
          View details of service organizations replicated from SAP S/4HANA Cloud.
        </p>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-line bg-surface-muted">
                <th class="pb-3 font-medium text-ink-muted text-sm uppercase tracking-wider w-32">Code</th>
                <th class="pb-3 font-medium text-ink-muted text-sm uppercase tracking-wider">Description</th>
                <th class="pb-3 font-medium text-ink-muted text-sm uppercase tracking-wider">Cost Centers</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (org of organizations(); track org.id) {
                <tr class="border-b border-line hover:bg-surface-muted transition-colors">
                  <td class="py-4 text-accent-text font-mono font-bold">{{ org.code }}</td>
                  <td class="py-4 text-ink-secondary">{{ org.description }}</td>
                  <td class="py-4 text-ink-secondary">
                    <div class="flex flex-wrap gap-1">
                      @for (cc of org.costCenters; track cc) {
                        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface-muted text-ink-secondary font-mono">
                          {{ cc }}
                        </span>
                      }
                    </div>
                  </td>
                </tr>
              }
              @if (organizations().length === 0) {
                <tr>
                  <td colspan="3" class="py-8 text-center text-ink-muted">No service organizations found.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
})
export class ServiceOrganizationDetailsComponent {
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);
  private orgsRes = rxResource({ stream: () => this.api.getServiceOrganizations(), defaultValue: [] as ServiceOrganization[] });
  organizations = computed(() => this.orgsRes.value());

  private escapeCsv(value: string): string {
    let v = value ?? '';
    if (/^[=+\-@\t\r]/.test(v)) {
      v = "'" + v;
    }
    if (/[",\n\r]/.test(v)) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }

  exportToSpreadsheet() {
    if (!isPlatformBrowser(this.platformId)) return;

    const csvContent = "Code,Description,Cost Centers\n" +
      this.organizations().map(o =>
        [
          this.escapeCsv(o.code),
          this.escapeCsv(o.description),
          this.escapeCsv(o.costCenters.join(', '))
        ].join(',')
      ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "ServiceOrganizations.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
