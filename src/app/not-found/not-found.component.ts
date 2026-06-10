import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <div class="min-h-[60vh] flex flex-col items-center justify-center text-center p-8">
      <div class="w-20 h-20 bg-white shadow-sm ring-1 ring-slate-900/5 border border-slate-200 rounded-full flex items-center justify-center mb-6">
        <mat-icon class="text-slate-400 text-4xl">explore_off</mat-icon>
      </div>
      <h1 class="text-5xl font-bold font-mono tabular-nums text-slate-900 tracking-tight mb-2">404</h1>
      <p class="text-slate-500 mb-6">The page you are looking for does not exist.</p>
      <a routerLink="/" class="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm flex items-center gap-2">
        <mat-icon class="text-[20px] w-[20px] h-[20px]">dashboard</mat-icon> Back to Dashboard
      </a>
    </div>
  `,
})
export class NotFoundComponent {}
