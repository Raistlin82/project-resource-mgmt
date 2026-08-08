import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Consistent document outline and spacing for every standalone Configuration route. */
@Component({
  selector: 'app-configuration-page-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div class="min-w-0">
          <p class="command-eyebrow">Configuration</p>
          <h1 class="command-title break-words">{{ title }}</h1>
          @if (subtitle) {
            <p class="command-subtitle">{{ subtitle }}</p>
          }
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <ng-content select="[configuration-actions]" />
        </div>
      </header>
      <ng-content />
    </div>
  `,
})
export class ConfigurationPageShellComponent {
  @Input({ required: true }) title = '';
  @Input() subtitle = '';
}
