import { Component, inject, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ApiService, Language } from '../services/api.service';

@Component({
  selector: 'app-set-default-language',
  imports: [],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Set Default Language</h2>
      </div>
      <div class="p-6 sm:p-8">
        <p class="text-sm font-medium text-slate-500 mb-8 leading-relaxed max-w-3xl">
          Set the default language for skills and project roles. We recommend that you only set the default language once and don't change it after skills or project roles have been created.
        </p>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Code</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Language</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Action</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (lang of languages(); track lang.code) {
                <tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors group">
                  <td class="py-5 text-blue-700 font-mono font-bold tracking-wide">{{ lang.code }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">
                    {{ lang.name }}
                    @if (lang.isDefault) {
                      <span class="ml-3 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 uppercase">
                        Default
                      </span>
                    }
                  </td>
                  <td class="py-5 text-right">
                    @if (!lang.isDefault) {
                      <button (click)="setDefault(lang.code)" class="text-blue-700 hover:text-blue-800 font-bold tracking-wide uppercase transition-colors bg-blue-50 ring-1 ring-blue-200 hover:bg-blue-100 px-4 py-2 rounded-xl text-xs">
                        Set as Default
                      </button>
                    }
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
export class SetDefaultLanguageComponent {
  private api = inject(ApiService);
  private languagesRes = rxResource({ stream: () => this.api.getLanguages(), defaultValue: [] as Language[] });
  // Sort so default is at the top
  languages = computed(() =>
    [...this.languagesRes.value()].sort((a, b) => (a.isDefault === b.isDefault) ? 0 : a.isDefault ? -1 : 1)
  );

  setDefault(code: string) {
    this.api.setDefaultLanguage(code).subscribe(() => {
      this.languagesRes.reload();
    });
  }
}
