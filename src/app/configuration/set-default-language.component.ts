import { Component, computed, inject, signal } from '@angular/core';
import { ApiService, Language } from '../services/api.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { NotificationService } from '../services/notification.service';
import { ConfigurationPageShellComponent } from './configuration-page-shell.component';

@Component({
  selector: 'app-set-default-language',
  imports: [ModalDialogDirective, ConfigurationPageShellComponent],
  template: `
    <app-configuration-page-shell
      title="Set Default Language"
      subtitle="Choose the default language used by skills and project roles.">
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Available languages</h2>
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
                        <button type="button" (click)="askSetDefault(lang)" class="command-button secondary"
                                [attr.aria-label]="'Set ' + lang.name + ' (' + lang.code + ') as default language'">
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

    @if (pendingLanguage(); as language) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4 backdrop-blur-sm"
           appModal ariaLabelledby="defaultLanguageConfirmTitle" (dismiss)="cancelSetDefault()">
        <div class="command-card w-full max-w-md overflow-hidden shadow-2xl" data-test="language-confirm">
          <div class="p-6 sm:p-8 text-center">
            <h2 id="defaultLanguageConfirmTitle" class="font-display text-xl font-bold text-ink break-words">
              Make {{ language.name }} the default language?
            </h2>
            <p class="mt-3 text-sm text-ink-muted">
              This changes the default for skills and project roles to
              <strong class="text-ink">{{ language.name }} ({{ language.code }})</strong>.
              Existing catalog data is not translated automatically.
            </p>
            @if (saveError()) {
              <p class="mt-4 text-sm font-semibold text-critical-text" role="alert">{{ saveError() }}</p>
            }
          </div>
          <div class="flex justify-end gap-3 border-t border-line bg-surface-muted p-4">
            <button type="button" (click)="cancelSetDefault()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
            <button type="button" (click)="confirmSetDefault()" [disabled]="saving()" class="command-button disabled:opacity-50">
              {{ saving() ? 'Applying…' : 'Change default language' }}
            </button>
          </div>
        </div>
      </div>
    }
    </app-configuration-page-shell>
  `
})
export class SetDefaultLanguageComponent {
  private api = inject(ApiService);
  private notifications = inject(NotificationService);
  private languagesRes = authGatedResource(() => this.api.getLanguages(), [] as Language[]);
  // Sort so default is at the top
  languages = computed(() =>
    [...this.languagesRes.value()].sort((a, b) => (a.isDefault === b.isDefault) ? 0 : a.isDefault ? -1 : 1)
  );

  protected pendingLanguage = signal<Language | null>(null);
  protected saving = signal(false);
  protected saveError = signal<string | null>(null);

  protected askSetDefault(language: Language): void {
    this.saveError.set(null);
    this.pendingLanguage.set(language);
  }

  protected cancelSetDefault(): void {
    if (!this.saving()) this.pendingLanguage.set(null);
  }

  protected confirmSetDefault(): void {
    const language = this.pendingLanguage();
    if (!language || this.saving()) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.api.setDefaultLanguage(language.code).subscribe({
      next: () => {
        this.saving.set(false);
        this.pendingLanguage.set(null);
        this.languagesRes.reload();
        this.notifications.show(`Default language changed to ${language.name}`, 'success');
      },
      error: () => {
        this.saving.set(false);
        this.saveError.set('The default language could not be changed. Review the error and try again.');
      },
    });
  }
}
