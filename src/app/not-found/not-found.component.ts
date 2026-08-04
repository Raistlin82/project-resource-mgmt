import { ChangeDetectionStrategy, Component, RESPONSE_INIT, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <div class="min-h-[60vh] flex flex-col items-center justify-center text-center p-8">
      <div class="w-20 h-20 bg-surface shadow-sm ring-1 ring-ink/5 border border-line rounded-full flex items-center justify-center mb-6">
        <mat-icon class="text-ink-muted text-4xl">explore_off</mat-icon>
      </div>
      <h1 class="text-5xl font-bold font-mono tabular-nums text-ink tracking-tight mb-2">404</h1>
      <p class="text-ink-muted mb-6">The page you are looking for does not exist.</p>
      <a routerLink="/" class="bg-accent hover:bg-accent-strong text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center gap-2">
        <mat-icon class="text-[20px] w-[20px] h-[20px]">dashboard</mat-icon> Back to Dashboard
      </a>
    </div>
  `,
})
export class NotFoundComponent {
  private readonly responseInit = inject(RESPONSE_INIT, { optional: true });

  constructor() {
    if (this.responseInit) this.responseInit.status = 404;
  }
}
