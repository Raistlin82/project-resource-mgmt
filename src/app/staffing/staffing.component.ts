import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Resource } from '../services/api.service';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import {
  rankCandidates,
  requestSkillGap,
  MATCH_WEIGHTS,
  type CandidateScore,
  type MatchDimension,
} from '../services/match.util';

interface DimensionMeter {
  key: MatchDimension;
  label: string;
  short: string;
  value: number;
  weight: number;
  pct: number;
}

@Component({
  selector: 'app-staffing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, FormsModule],
  template: `
    <div class="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight mb-8">Staff Resource Requests</h1>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <!-- Requests List -->
        <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden flex flex-col h-[800px] hover:shadow-md transition-all">
          <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
            <h2 class="text-xl font-bold text-slate-900 tracking-tight">Open Requests</h2>
            <p class="text-sm font-medium text-slate-500 mt-2">Select a request to find matching resources</p>
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
            @for (req of openRequests(); track req.id) {
              <div class="p-6 sm:p-8 hover:bg-slate-50 transition-all cursor-pointer group relative"
                   [class.bg-blue-50]="selectedRequest()?.id === req.id"
                   tabindex="0"
                   (keydown.enter)="selectRequest(req)"
                   (click)="selectRequest(req)">
                @if (selectedRequest()?.id === req.id) {
                  <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-600 rounded-r-full"></div>
                }
                <div class="flex justify-between items-start mb-3">
                  <h3 class="font-bold text-slate-900 text-lg group-hover:text-blue-700 transition-colors">{{ req.name }}</h3>
                  <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide font-mono tabular-nums bg-blue-50 text-blue-700 ring-1 ring-blue-200">{{ req.requiredEffort }}h</span>
                </div>
                <p class="text-sm font-semibold text-slate-500 mb-4 uppercase tracking-wider">{{ req.requiredRole }}</p>
                <div class="flex gap-2 flex-wrap">
                  @for (skill of req.skills; track skill) {
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-slate-100 text-slate-700 border border-slate-200">
                      {{ skill }}
                    </span>
                  }
                </div>
              </div>
            }
            @if (openRequests().length === 0) {
              <div class="p-12 text-center text-slate-500 font-medium italic">No open requests available for staffing.</div>
            }
          </div>
        </div>

        <!-- Resources List -->
        <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden flex flex-col h-[800px] hover:shadow-md transition-all">
          <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
            <div class="flex items-center justify-between mb-6">
              <div>
                <h2 class="text-xl font-bold text-slate-900 tracking-tight">
                  {{ selectedRequest() ? 'Matching Resources' : 'All Resources' }}
                </h2>
                @if (selectedRequest()) {
                  <p class="text-sm font-medium text-slate-500 mt-2">For <span class="font-bold text-slate-700">{{ selectedRequest()?.name }}</span></p>
                }
              </div>
              @if (selectedRequest()) {
                <button (click)="clearSelection()" class="text-sm text-blue-700 hover:text-blue-800 font-bold tracking-wide uppercase transition-colors bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200 px-3 py-1.5 rounded-xl">Clear Selection</button>
              }
            </div>

            <div class="relative">
              <mat-icon class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input
                type="text"
                [ngModel]="searchQuery()"
                (ngModelChange)="searchQuery.set($event)"
                placeholder="Search by name, role, or skills..."
                class="w-full pl-12 pr-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none text-sm font-medium text-slate-900 placeholder:text-slate-400 transition-all shadow-inner bg-white focus:bg-white"
              >
            </div>

            @if (missingSkillGap().length > 0) {
              <div class="mt-6 flex items-start gap-3 rounded-xl bg-amber-50 ring-1 ring-amber-200 p-4">
                <mat-icon class="text-amber-700 text-[20px] w-[20px] h-[20px] shrink-0 mt-0.5">warning_amber</mat-icon>
                <div>
                  <p class="text-sm font-bold text-amber-800">Skill gap: no available resource covers these skills</p>
                  <div class="flex gap-2 flex-wrap mt-2">
                    @for (skill of missingSkillGap(); track skill) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-white text-amber-800 ring-1 ring-amber-300">
                        {{ skill }}
                      </span>
                    }
                  </div>
                </div>
              </div>
            }
          </div>
          <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
            @if (rankedCandidates(); as candidates) {
              <!-- Ranked candidate mode: a request is selected. -->
              @for (cand of candidates; track cand.resourceId) {
                <div class="p-6 sm:p-8 hover:bg-slate-50 transition-colors group">
                  <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div class="flex items-start gap-5 min-w-0">
                      <div class="relative w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center text-white font-bold text-xl shrink-0 shadow-sm border border-slate-200">
                        {{ cand.resource.name.charAt(0) }}
                        <span class="absolute -bottom-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-white ring-1 ring-slate-200 text-[10px] font-bold font-mono tabular-nums shadow-sm"
                              [class]="scoreTextClass(cand.score)"
                              [title]="scoreTooltip(cand)">{{ cand.score | number:'1.0-0' }}</span>
                      </div>
                      <div class="min-w-0">
                        <h3 class="font-bold text-slate-900 text-lg group-hover:text-blue-700 transition-colors">{{ cand.resource.name }}</h3>
                        <p class="text-sm font-medium text-slate-500 mt-0.5">{{ cand.resource.role }} <span class="mx-1.5 text-slate-400">•</span> <span class="font-mono tabular-nums" [class.text-red-700]="cand.resource.utilization > 100" [class.text-emerald-700]="cand.resource.utilization <= 100">{{ cand.resource.utilization | number:'1.0-0' }}% Utilized</span></p>
                        <div class="flex gap-1.5 mt-3 flex-wrap">
                          @for (skill of cand.resource.skills; track skill.name) {
                            <span class="text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-700 px-2 py-1 rounded-md border border-slate-200">{{ skill.name }}</span>
                          }
                        </div>
                      </div>
                    </div>
                    <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0 w-full sm:w-auto">
                      @if (assigningResourceId() === cand.resourceId) {
                        <div class="flex items-center gap-2 w-full sm:w-auto">
                          <input type="number" [ngModel]="assignHours()" (ngModelChange)="assignHours.set($event)" class="w-20 px-3 py-2 border border-slate-300 rounded-xl text-sm font-bold font-mono tabular-nums text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none shadow-inner" min="1" [max]="selectedRequest()?.requiredEffort || 1">
                          <button (click)="confirmAssign(cand.resourceId)" class="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm hover:-translate-y-0.5">Confirm</button>
                          <button (click)="cancelAssign()" class="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors flex items-center justify-center"><mat-icon class="text-[20px] w-[20px] h-[20px]">close</mat-icon></button>
                        </div>
                      } @else {
                        <button (click)="startAssign(cand.resourceId)" class="w-full sm:w-auto bg-slate-50 border border-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-slate-100 hover:border-slate-300 transition-all shadow-sm flex items-center justify-center gap-2">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">person_add</mat-icon> Assign
                        </button>
                      }
                    </div>
                  </div>

                  <!-- Match score: overall bar + per-dimension breakdown cells -->
                  <div class="mt-5 rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-4">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[10px] font-bold tracking-wider uppercase text-slate-500">Match score</span>
                      <span class="text-sm font-bold font-mono tabular-nums" [class]="scoreTextClass(cand.score)">{{ cand.score | number:'1.0-1' }}<span class="text-slate-400"> / 100</span></span>
                    </div>
                    <div class="h-2 w-full rounded-full bg-slate-200 overflow-hidden" [title]="scoreTooltip(cand)">
                      <div class="h-full rounded-full transition-all" [class]="scoreBarClass(cand.score)" [style.width.%]="cand.score"></div>
                    </div>

                    <div class="grid grid-cols-5 gap-2 mt-4">
                      @for (m of meters(cand); track m.key) {
                        <div class="flex flex-col items-center text-center" [title]="m.label + ': ' + m.value.toFixed(1) + ' / ' + m.weight">
                          <span class="text-[10px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">{{ m.short }}</span>
                          <div class="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                            <div class="h-full rounded-full bg-blue-600" [style.width.%]="m.pct"></div>
                          </div>
                          <span class="text-[11px] font-bold font-mono tabular-nums text-slate-700 mt-1.5">{{ m.value | number:'1.0-1' }}<span class="text-slate-400">/{{ m.weight }}</span></span>
                        </div>
                      }
                    </div>

                    @if (cand.missingSkills.length > 0) {
                      <div class="flex items-center gap-2 flex-wrap mt-4 pt-3 border-t border-slate-200">
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase text-rose-700">
                          <mat-icon class="text-[14px] w-[14px] h-[14px]">error_outline</mat-icon> Missing
                        </span>
                        @for (skill of cand.missingSkills; track skill) {
                          <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide bg-rose-50 text-rose-700 ring-1 ring-rose-200">{{ skill }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
              @if (candidates.length === 0) {
                <div class="p-12 text-center text-slate-500 font-medium italic">No resources found matching your criteria.</div>
              }
            } @else {
              <!-- Plain resource list mode: no request selected. -->
              @for (res of displayedResources(); track res.id) {
                <div class="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50 transition-colors group">
                  <div class="flex items-center gap-5">
                    <div class="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center text-white font-bold text-xl shrink-0 shadow-sm border border-slate-200">
                      {{ res.name.charAt(0) }}
                    </div>
                    <div>
                      <h3 class="font-bold text-slate-900 text-lg group-hover:text-blue-700 transition-colors">{{ res.name }}</h3>
                      <p class="text-sm font-medium text-slate-500 mt-0.5">{{ res.role }} <span class="mx-1.5 text-slate-400">•</span> <span class="font-mono tabular-nums" [class.text-red-700]="res.utilization > 100" [class.text-emerald-700]="res.utilization <= 100">{{ res.utilization | number:'1.0-0' }}% Utilized</span></p>
                      <div class="flex gap-1.5 mt-3 flex-wrap">
                        @for (skill of res.skills; track skill.name) {
                          <span class="text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-700 px-2 py-1 rounded-md border border-slate-200">{{ skill.name }}</span>
                        }
                      </div>
                    </div>
                  </div>
                </div>
              }
              @if (displayedResources().length === 0) {
                <div class="p-12 text-center text-slate-500 font-medium italic">No resources found matching your criteria.</div>
              }
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class StaffingComponent {
  private api = inject(ApiService);

  private res = rxResource({
    stream: () => forkJoin({
      requests: this.api.getRequests(),
      resources: this.api.getResources()
    }),
    defaultValue: { requests: [] as ResourceRequest[], resources: [] as Resource[] }
  });

  openRequests = computed(() =>
    this.res.value().requests.filter(r => r.status === 'Open' || r.status === 'Published')
  );
  allResources = computed(() => this.res.value().resources);
  selectedRequest = signal<ResourceRequest | null>(null);
  searchQuery = signal('');

  assigningResourceId = signal<string | null>(null);
  assignHours = signal<number>(0);

  /** Resources after applying the free-text search box (name / role / skills). */
  private searchedResources = computed(() => {
    const resources = this.allResources();
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return resources;
    return resources.filter(r =>
      r.name.toLowerCase().includes(query) ||
      r.role.toLowerCase().includes(query) ||
      r.skills.some(s => s.name.toLowerCase().includes(query))
    );
  });

  /**
   * When a request is selected, rank the searched resources by match score (desc) using the
   * shared scorer. Returns null when no request is selected (plain resource list mode).
   */
  rankedCandidates = computed<CandidateScore[] | null>(() => {
    const req = this.selectedRequest();
    if (!req) return null;
    return rankCandidates(this.searchedResources(), req);
  });

  /** Plain list of resources shown when no request is selected. */
  displayedResources = computed(() => this.searchedResources());

  /**
   * Skills the request needs that NO resource in the full pool can cover.
   * Computed over allResources() (not the filtered search) so a stray search term
   * can't hide a genuine capability gap that warrants hiring / upskilling.
   */
  missingSkillGap = computed<string[]>(() => {
    const req = this.selectedRequest();
    if (!req) return [];
    return requestSkillGap(this.allResources(), req);
  });

  /** Per-dimension meters for a candidate, in display order, normalised to their own weight. */
  meters(candidate: CandidateScore): DimensionMeter[] {
    const b = candidate.breakdown;
    const order: { key: MatchDimension; label: string; short: string }[] = [
      { key: 'skillCoverage', label: 'Skill coverage', short: 'Skills' },
      { key: 'proficiency', label: 'Proficiency', short: 'Prof' },
      { key: 'roleFit', label: 'Role fit', short: 'Role' },
      { key: 'availability', label: 'Availability', short: 'Avail' },
      { key: 'marginFit', label: 'Margin', short: 'Margin' },
    ];
    return order.map(({ key, label, short }) => {
      const weight = MATCH_WEIGHTS[key];
      const value = b[key];
      return {
        key,
        label,
        short,
        value,
        weight,
        pct: weight > 0 ? Math.round((value / weight) * 100) : 0,
      };
    });
  }

  /** Tailwind bar colour for the overall score. */
  scoreBarClass(score: number): string {
    if (score >= 70) return 'bg-emerald-500';
    if (score >= 40) return 'bg-amber-500';
    return 'bg-rose-500';
  }

  /** Tailwind text colour for the overall score number (AA contrast on white). */
  scoreTextClass(score: number): string {
    if (score >= 70) return 'text-emerald-700';
    if (score >= 40) return 'text-amber-700';
    return 'text-rose-700';
  }

  /** Human-readable breakdown tooltip for a candidate's overall score. */
  scoreTooltip(candidate: CandidateScore): string {
    return this.meters(candidate)
      .map(m => `${m.label}: ${m.value.toFixed(1)} / ${m.weight}`)
      .join('\n');
  }

  selectRequest(req: ResourceRequest) {
    this.selectedRequest.set(req);
    this.cancelAssign();
  }

  clearSelection() {
    this.selectedRequest.set(null);
    this.cancelAssign();
  }

  startAssign(resourceId: string) {
    const req = this.selectedRequest();
    if (req) {
      this.assigningResourceId.set(resourceId);
      const remaining = req.requiredEffort - (req.staffedEffort || 0);
      this.assignHours.set(remaining > 0 ? remaining : req.requiredEffort);
    }
  }

  cancelAssign() {
    this.assigningResourceId.set(null);
    this.assignHours.set(0);
  }

  confirmAssign(resourceId: string) {
    const req = this.selectedRequest();
    const hours = this.assignHours();
    if (req && hours > 0) {
      this.api.createAssignment({
        requestId: req.id,
        resourceId: resourceId,
        assignedHours: hours,
        status: 'hard-booked'
      }).subscribe(() => {
        this.cancelAssign();
        this.selectedRequest.set(null);
        this.res.reload();
      });
    }
  }
}
