import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ServiceOrganization } from '../services/api.service';

@Component({
  selector: 'app-service-organization-details',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-lg font-semibold text-slate-800">Service Organization Details</h2>
        <button (click)="exportToSpreadsheet()" class="bg-white text-slate-700 border border-slate-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors flex items-center gap-2">
          <mat-icon class="text-sm">file_download</mat-icon> Export to Spreadsheet
        </button>
      </div>

      <div class="p-6">
        <p class="text-sm text-slate-500 mb-6">
          View details of service organizations replicated from SAP S/4HANA Cloud.
        </p>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200">
                <th class="pb-3 font-medium text-slate-500 text-sm w-32">Code</th>
                <th class="pb-3 font-medium text-slate-500 text-sm">Description</th>
                <th class="pb-3 font-medium text-slate-500 text-sm">Cost Centers</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (org of organizations(); track org.id) {
                <tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td class="py-4 text-slate-800 font-mono font-bold">{{ org.code }}</td>
                  <td class="py-4 text-slate-800">{{ org.description }}</td>
                  <td class="py-4 text-slate-600">
                    <div class="flex flex-wrap gap-1">
                      @for (cc of org.costCenters; track cc) {
                        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 font-mono">
                          {{ cc }}
                        </span>
                      }
                    </div>
                  </td>
                </tr>
              }
              @if (organizations().length === 0) {
                <tr>
                  <td colspan="3" class="py-8 text-center text-slate-500">No service organizations found.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
})
export class ServiceOrganizationDetailsComponent implements OnInit {
  private api = inject(ApiService);
  organizations = signal<ServiceOrganization[]>([]);

  ngOnInit() {
    this.api.getServiceOrganizations().subscribe(res => this.organizations.set(res));
  }

  exportToSpreadsheet() {
    const csvContent = "Code,Description,Cost Centers\n" +
      this.organizations().map(o => `${o.code},"${o.description}","${o.costCenters.join(', ')}"`).join('\n');
    
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
