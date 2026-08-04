import { Component, inject, computed } from '@angular/core';
import { ApiService, Language } from '../services/api.service';
import { authGatedResource } from '../services/auth-gated-resource.util';

@Component({
  selector: 'app-set-default-language',
  imports: [],
  template: `
    <div class="command-page space-y-6">
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Set Default Language</h2>
      </div>
      <div class="p-6 sm:p-8">
        <p class="text-sm font-medium text-[var(--cc-muted)] mb-8 leading-relaxed max-w-3xl">
          Set the default language for skills and project roles. We recommend that you only set the default language once and don't change it after skills or project roles have been created.
        </p>

        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Language</th>
                <th class="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              @for (lang of languages(); track lang.code) {
                <tr>
                  <td><span class="text-accent-text font-mono font-bold tracking-wide">{{ lang.code }}</span></td>
                  <td class="font-bold text-base">
                    {{ lang.name }}
                    @if (lang.isDefault) {
                      <span class="ml-3 command-status green uppercase">
                        Default
                      </span>
                    }
                  </td>
                  <td>
                    @if (!lang.isDefault) {
                      <div class="flex justify-end">
                        <button (click)="setDefault(lang.code)" class="command-button secondary">
                          Set as Default
                        </button>
                      </div>
                    }
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
export class SetDefaultLanguageComponent {
  private api = inject(ApiService);
  private languagesRes = authGatedResource(() => this.api.getLanguages(), [] as Language[]);
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
