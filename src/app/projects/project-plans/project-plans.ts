import { ChangeDetectionStrategy, Component, signal, computed, input, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, WorkPackage, Milestone, Resource } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';
import { endNotBeforeStart } from '../../services/date-range.validator';

@Component({
  selector: 'app-project-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DatePipe, DecimalPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-8">
        <!-- Header -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            @if (headingLevel() === 1) {
              <div>
                <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Project Schedule & Plans</h1>
                <p class="text-sm text-[var(--cc-muted)] mt-2">Manage work packages, scheduling, and key milestones.</p>
              </div>
            } @else {
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Project Schedule & Plans</h2>
                <p class="text-sm text-[var(--cc-muted)] mt-1">Manage work packages, scheduling, and key milestones.</p>
              </div>
            }
            @if (!projectId()) {
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block w-full min-w-0 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)] sm:w-auto">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            }
          </div>
          <!-- P2-18: both controls have the same precondition, so they share ONE
               accessible description rather than repeating the same sentence
               twice — two hints reading "Select a project first." would make a
               screen reader announce it once per button. The row keeps its own
               wrapping; the hint sits under it. -->
          <div class="flex flex-col items-start gap-1">
            <div class="flex flex-wrap gap-3">
              <button (click)="openMilestoneForm()" [disabled]="!activeProjectId()"
                      [attr.aria-describedby]="activeProjectId() ? null : 'projectPlansHint'"
                      data-test="add-milestone"
                      class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
                <mat-icon class="text-sm">flag</mat-icon> Add Milestone
              </button>
              <button (click)="openWpForm()" [disabled]="!activeProjectId()"
                      [attr.aria-describedby]="activeProjectId() ? null : 'projectPlansHint'"
                      data-test="add-work-package"
                      class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                <mat-icon class="text-sm">add</mat-icon> Add Work Package
              </button>
            </div>
            @if (!activeProjectId()) {
              <p id="projectPlansHint" class="text-xs text-[var(--cc-muted)]" data-test="project-plans-hint">Select a project first.</p>
            }
          </div>
        </div>

        @if (!activeProjectId()) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view plans and milestones.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- Work Packages (Main Content) -->
          <div class="lg:col-span-2 space-y-6">
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] flex items-center gap-2">
              <mat-icon class="text-accent-text">account_tree</mat-icon> Work Packages
            </h3>

            <div class="command-card overflow-x-auto">
              <table class="command-data-table min-w-[48rem]">
                <thead>
                  <tr>
                    <th class="py-3 px-4">WBS / Name</th>
                    <th class="py-3 px-4">Timeline</th>
                    <th class="py-3 px-4">Assignee</th>
                    <th class="py-3 px-4">Progress</th>
                    <th class="py-3 px-4 text-right">Actions</th>
                  </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (wp of filteredWorkPackages(); track wp.id) {
                  <tr class="group">
                    <td class="py-4 px-4">
                      <div class="font-medium text-[var(--cc-ink)]">{{ wp.name }}</div>
                      <div class="text-xs text-accent-text font-mono mt-0.5">{{ wp.id }}</div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-1.5 text-[var(--cc-muted)] text-xs">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">calendar_today</mat-icon>
                        {{ wp.startDate | date:'MMM d' }} - {{ wp.endDate | date:'MMM d' }}
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-2">
                        <div class="w-6 h-6 rounded-full bg-accent-tint text-accent-text ring-1 ring-accent flex items-center justify-center text-xs font-bold">
                          {{ wp.assignee.charAt(0) }}
                        </div>
                        <span class="text-xs font-medium">{{ wp.assignee }}</span>
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-3">
                        <div class="flex-1 h-2 bg-surface-muted rounded-full overflow-hidden">
                          <div class="h-full rounded-full transition-all duration-500"
                               [class.bg-positive]="wp.progress === 100"
                               [class.bg-gradient-to-r]="wp.progress > 0 && wp.progress < 100"
                               [class.from-accent]="wp.progress > 0 && wp.progress < 100"
                               [class.to-accent]="wp.progress > 0 && wp.progress < 100"
                               [class.bg-surface-muted]="wp.progress === 0"
                               [style.width.%]="wp.progress"></div>
                        </div>
                        <span class="text-xs font-mono tabular-nums font-medium w-8 text-right">{{ wp.progress | number:'1.0-0' }}%</span>
                      </div>
                    </td>
                    <td class="py-4 px-4 text-right">
                      <button type="button" (click)="openEditWpForm(wp)" [attr.aria-label]="'Edit ' + wp.name" [attr.title]="'Edit ' + wp.name" class="text-ink-muted hover:text-accent-text transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                        <mat-icon class="text-sm">edit</mat-icon>
                      </button>
                    </td>
                  </tr>
                }
                @if (filteredWorkPackages().length === 0) {
                  <tr>
                    <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]">No work packages found for this project.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Milestones (Sidebar) -->
        <div class="space-y-6">
          <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] flex items-center gap-2">
            <mat-icon class="text-caution">emoji_events</mat-icon> Key Milestones
          </h3>

          <div class="command-card p-6">
            <div class="relative border-l-2 border-[var(--cc-line)] ml-3 space-y-8">
              @for (milestone of filteredMilestones(); track milestone.id; let last = $last) {
                <div class="relative pl-6">
                  <!-- Timeline Dot -->
                  <div class="absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center"
                       [class.bg-positive]="milestone.status === 'Achieved'"
                       [class.bg-surface-muted]="milestone.status === 'Pending'">
                    @if (milestone.status === 'Achieved') {
                      <mat-icon class="text-white text-[10px] w-[10px] h-[10px]">check</mat-icon>
                    }
                  </div>

                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <h4 class="text-sm font-semibold text-[var(--cc-ink)]" [class.line-through]="milestone.status === 'Achieved'">
                        {{ milestone.name }}
                      </h4>
                      <span class="text-xs font-medium px-2 py-0.5 rounded-full ring-1"
                            [class.bg-positive-tint]="milestone.status === 'Achieved'"
                            [class.text-positive-text]="milestone.status === 'Achieved'"
                            [class.ring-positive]="milestone.status === 'Achieved'"
                            [class.bg-surface-muted]="milestone.status === 'Pending'"
                            [class.text-ink-secondary]="milestone.status === 'Pending'"
                            [class.ring-line]="milestone.status === 'Pending'">
                        {{ milestone.status }}
                      </span>
                    </div>
                    <div class="flex items-center gap-1.5 text-xs text-[var(--cc-muted)]">
                      <mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon>
                      {{ milestone.date | date:'mediumDate' }}
                    </div>
                    @if (milestone.status === 'Pending') {
                      <!-- Opens the confirm below; the ellipsis is the signal that a dialog follows. -->
                      <button type="button" (click)="requestAchieveMilestone(milestone)" [attr.aria-label]="'Mark ' + milestone.name + ' achieved'" data-test="achieve-milestone" class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-positive-tint ring-1 ring-positive px-3 py-1.5 text-xs font-bold text-positive-text hover:bg-[color-mix(in_oklch,var(--color-positive)_16%,var(--color-surface))] transition-colors">
                        <mat-icon class="text-[14px] w-[14px] h-[14px]">check_circle</mat-icon>
                        Mark achieved&hellip;
                      </button>
                    } @else if (milestone.approvedBy) {
                      <p class="mt-2 text-[11px] text-[var(--cc-muted)]">Approved by {{ milestone.approvedBy }}</p>
                    }
                  </div>
                </div>
              }
              @if (filteredMilestones().length === 0) {
                <div class="pl-6 text-sm text-[var(--cc-muted)]">No milestones found.</div>
              }
            </div>
          </div>
          
          <!-- Quick Summary -->
          <div class="command-card-muted p-6">
            <h4 class="command-kpi-label mb-4">Schedule Summary</h4>
            <div class="space-y-3">
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Total Work Packages</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">{{ filteredWorkPackages().length }}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Completed</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">
                  {{ completedWorkPackagesCount() }}
                </span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-[var(--cc-muted)]">Milestones Achieved</span>
                <span class="font-mono tabular-nums font-medium text-[var(--cc-ink)]">
                  {{ achievedMilestonesCount() }} / {{ filteredMilestones().length }}
                </span>
              </div>
            </div>
          </div>
        </div>
        </div>
        }
      </div>

      <!--
        SCROLL-SAFE OVERLAY (same shape as manage-rate-cards.component.ts:104-124 and
        the billing create/edit overlay). A POSITION:FIXED box cannot be scrolled by
        the page, so "flex items-center" on a panel taller than the visual viewport
        pushed the header above y=0 AND the footer below the fold with no scroller
        anywhere: the form could be filled in and never saved. These three plan forms
        are the tallest in the app after billing's. The overlay now owns a scroller,
        anchors to the top on short viewports ("items-start") and re-centres from the
        "sm" breakpoint up; the panel stays bounded by max-h-[90vh] and its body
        scrolls, which is what keeps the pinned footer reachable.
      -->
      @if (showMilestoneForm()) {
        <div data-test="milestone-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="milestoneModalTitle" (dismiss)="closeMilestoneForm()">
          <div data-test="milestone-form-panel" class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="milestoneModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Milestone</h2>
              <button type="button" (click)="closeMilestoneForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1 min-h-0">
              <form [formGroup]="milestoneForm" (ngSubmit)="saveMilestone()" class="space-y-6">
                <!-- Rendered INLINE rather than left to the interceptor's toast, because
                     error toasts in this app auto-dismiss: a dialog that stays open with a
                     vanished toast is an unexplained refusal. Same shape as
                     project-cost-centers.ts's saveError. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="plan-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="milestoneName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Milestone Name *</label>
                  <input id="milestoneName" type="text" formControlName="name" class="command-input" placeholder="e.g. Phase 1 Completion">
                </div>

                <div>
                  <label for="milestoneDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Date *</label>
                  <input id="milestoneDate" type="date" formControlName="date" class="command-input">
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeMilestoneForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveMilestone()" [disabled]="!milestoneForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Add Work Package Modal — scroll-safe overlay, see the milestone form above. -->
      @if (showWpForm()) {
        <div data-test="wp-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="wpModalTitle" (dismiss)="closeWpForm()">
          <div data-test="wp-form-panel" class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="wpModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Add Work Package</h2>
              <button type="button" (click)="closeWpForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1 min-h-0">
              <form [formGroup]="wpForm" (ngSubmit)="saveWp()" class="space-y-6">
                <!-- Inline refusal text, see the milestone form above. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="plan-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="wpName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Work Package Name *</label>
                  <input id="wpName" type="text" formControlName="name" class="command-input" placeholder="e.g. Requirements Analysis">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="wpStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                    <input id="wpStartDate" type="date" formControlName="startDate" class="command-input">
                  </div>
                  <div>
                    <label for="wpEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                    <input id="wpEndDate" type="date" formControlName="endDate" class="command-input">
                  </div>
                </div>

                <div>
                  <label for="wpAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee *</label>
                  <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                  <select id="wpAssignee" formControlName="assignee" class="command-select">
                    <option [value]="unassigned">Unassigned</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanWpAssignee(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeWpForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveWp()" [disabled]="!wpForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Edit Work Package Modal — the tallest of the three (two extra fields);
           scroll-safe overlay, see the milestone form above. -->
      @if (showEditWpForm()) {
        <div data-test="edit-wp-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="editWpModalTitle" (dismiss)="closeEditWpForm()">
          <div data-test="edit-wp-form-panel" class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="editWpModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Edit Work Package</h2>
              <button type="button" (click)="closeEditWpForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1 min-h-0">
              <form [formGroup]="editWpForm" (ngSubmit)="saveEditWp()" class="space-y-6">
                <!-- Inline refusal text, see the milestone form above. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="plan-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="editWpName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Work Package Name *</label>
                  <input id="editWpName" type="text" formControlName="name" class="command-input" placeholder="e.g. Requirements Analysis">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="editWpStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                    <input id="editWpStartDate" type="date" formControlName="startDate" class="command-input">
                  </div>
                  <div>
                    <label for="editWpEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                    <input id="editWpEndDate" type="date" formControlName="endDate" class="command-input">
                  </div>
                </div>

                <div>
                  <label for="editWpAssignee" class="block text-sm font-semibold text-ink-secondary mb-1.5">Assignee *</label>
                  <!-- A PERSON reference: bound to the resources (people) catalog by name. -->
                  <select id="editWpAssignee" formControlName="assignee" class="command-select">
                    <option [value]="unassigned">Unassigned</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanEditWpAssignee(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="editWpStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                    <select id="editWpStatus" formControlName="status" class="command-select">
                      <option value="Planned">Planned</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div>
                    <label for="editWpProgress" class="block text-sm font-semibold text-ink-secondary mb-1.5">Progress (%) *</label>
                    <input id="editWpProgress" type="number" min="0" max="100" formControlName="progress" class="command-input">
                  </div>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeEditWpForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveEditWp()" [disabled]="!editWpForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      }

      <!--
        ACHIEVE CONFIRMATION — this chip RELEASES MONEY, so it gets the repo's
        confirm shape (deletingId + modal, projects.ts:270-286) with the
        consequence spelled out the way manage-rate-cards.component.ts does it.
        server.ts's own MILESTONE_FIELDS comment calls a milestone reaching
        'Achieved' "a document that RELEASES MONEY": the PUT flips every linked
        fixed-price BillingPlanItem from 'Planned' to 'Ready', which is precisely
        what un-gates /billing's "Generate invoice" row action. The old label said
        "Approve" and none of that, on a single unconfirmed click — and the button
        then vanishes with the Pending branch above, so there is no reversal
        affordance here OR on /billing. Copy therefore has to name the milestone,
        say the linked conditions become invoiceable, and admit the reversal does
        not exist rather than implying one.
      -->
      @if (pendingAchieve(); as pending) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="milestoneAchieveTitle" (dismiss)="cancelAchieveMilestone()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col" data-test="achieve-milestone-confirm">
            <div class="p-6 sm:p-8 text-center">
              <div class="w-16 h-16 bg-caution-tint ring-1 ring-caution rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-caution-text text-3xl">payments</mat-icon>
              </div>
              <h3 id="milestoneAchieveTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Mark &ldquo;{{ pending.name }}&rdquo; achieved?</h3>
              <p class="text-[var(--cc-muted)] text-sm">
                Achieving <strong class="text-[var(--cc-ink)]">{{ pending.name }}</strong> makes every fixed-price billing
                condition linked to it invoiceable: each one moves from Planned to Ready, and finance can then raise an
                invoice against it. This cannot be undone from this screen &mdash; nothing here, or on Billing, moves the
                milestone back to Pending or those conditions back to Planned.
              </p>
            </div>
            <div class="p-4 sm:p-5 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelAchieveMilestone()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmAchieveMilestone()" data-test="achieve-milestone-confirm-action" class="px-4 py-2 bg-caution text-white rounded-lg text-sm font-semibold hover:bg-caution-strong transition-colors shadow-sm">
                Release for invoicing
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectPlans {
  projectId = input<string>();
  /**
   * Which element carries this panel's own title: `<h1>` when it stands alone on
   * its route, `<h2>` when project-details embeds it as a tab panel beneath the
   * project-name `<h1>`.
   *
   * ONE mechanism, applied identically by all eight embeddable project panels;
   * the `[headingLevel]="2"` bindings and the full rationale live in
   * project-details.ts. Adding a plain `<h1>` here instead would have put TWO h1
   * elements on /projects/:id — trading the missing-h1 defect for a duplicate-h1
   * one. Typed `1 | 2` so no caller can ask for the `<h3>` that would skip a
   * level under the page `<h1>`. The size classes are unchanged in both
   * branches: the heading LEVEL is what moves, never the type scale.
   */
  headingLevel = input<1 | 2>(1);
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);

  /** Exposed to the template for the explicit "Unassigned" empty option. */
  protected readonly unassigned = 'Unassigned';

  projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  /**
   * The project in scope: the routed one when this panel is embedded in
   * project-details, else the one picked in the standalone page's selector.
   * Empty means none, which is what disables the create control (P2-18).
   *
   * Declared right after its own dependency, and the SINGLE source of truth for
   * the question — the inline `projectId() || selectedProjectId()` it replaces
   * appeared in the template, in the filtered list and in every save handler,
   * so the disabled state and the empty state could drift apart.
   */
  activeProjectId = computed(() => this.projectId() || this.selectedProjectId());

  // Work-package assignee is a PERSON reference bound to the resources (people) catalog
  // by name (Phase D). /resources is a principal-gated read, so key the load on authReady
  // to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  showMilestoneForm = signal(false);
  showWpForm = signal(false);
  showEditWpForm = signal(false);
  editingWpId = signal<string | null>(null);

  milestoneForm = new FormGroup({
    name: new FormControl('', Validators.required),
    date: new FormControl('', Validators.required)
  });

  // P2-35: a work package is the "piani" half of the issue — both the create and
  // the edit form, since either can invert the pair.
  wpForm = new FormGroup({
    name: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    assignee: new FormControl('', Validators.required)
  }, { validators: endNotBeforeStart('startDate', 'endDate') });

  editWpForm = new FormGroup({
    name: new FormControl('', Validators.required),
    startDate: new FormControl('', Validators.required),
    endDate: new FormControl('', Validators.required),
    assignee: new FormControl('', Validators.required),
    status: new FormControl<WorkPackage['status']>('Planned', Validators.required),
    progress: new FormControl(0, Validators.required)
  }, { validators: endNotBeforeStart('startDate', 'endDate') });

  // ORPHAN VALUES: a stored assignee that isn't a current resource name (and isn't the
  // 'Unassigned' sentinel) is surfaced as a disabled option so editing never drops it.
  private wpAssigneeValue = toSignal(this.wpForm.controls.assignee.valueChanges, { initialValue: this.wpForm.controls.assignee.value });
  private editWpAssigneeValue = toSignal(this.editWpForm.controls.assignee.valueChanges, { initialValue: this.editWpForm.controls.assignee.value });
  orphanWpAssignee = computed<string | null>(() => this.orphanAssignee(this.wpAssigneeValue()));
  orphanEditWpAssignee = computed<string | null>(() => this.orphanAssignee(this.editWpAssigneeValue()));
  private orphanAssignee(value: string | null | undefined): string | null {
    if (!value || value === this.unassigned) return null;
    return this.resourceOptions().some(r => r.name === value) ? null : value;
  }

  private wpRes = authGatedResource(() => this.api.getWorkPackages(), [] as WorkPackage[]);
  workPackages = this.wpRes.value;

  private milestoneRes = authGatedResource(() => this.api.getMilestones(), [] as Milestone[]);
  milestones = this.milestoneRes.value;

  filteredWorkPackages = computed(() => {
    const pId = this.activeProjectId();
    if (!pId) return [];
    return this.workPackages().filter(wp => wp.projectId === pId);
  });

  filteredMilestones = computed(() => {
    const pId = this.activeProjectId();
    if (!pId) return [];
    return this.milestones().filter(m => m.projectId === pId);
  });

  completedWorkPackagesCount = computed(() => this.filteredWorkPackages().filter(wp => wp.status === 'Completed').length);
  achievedMilestonesCount = computed(() => this.filteredMilestones().filter(m => m.status === 'Achieved').length);

  openMilestoneForm() {
    this.showMilestoneForm.set(true);
  }

  /**
   * Server refusal text for whichever plan dialog is open, or null. One signal is
   * enough because the three dialogs are mutually exclusive, and each close handler
   * clears it. See the milestone form's template comment.
   */
  saveError = signal<string | null>(null);

  /** Turns a failed write into inline dialog text without closing the dialog. */
  private planSaveError(fallback: string) {
    return (e: unknown) => {
      this.saveError.set((e as { error?: { error?: string } })?.error?.error ?? fallback);
    };
  }

  closeMilestoneForm() {
    this.showMilestoneForm.set(false);
    this.saveError.set(null);
    this.milestoneForm.reset();
  }

  saveMilestone() {
    if (this.milestoneForm.invalid) return;
    const pId = this.activeProjectId();
    if (!pId) return;

    this.saveError.set(null);
    const v = this.milestoneForm.getRawValue();
    this.api.createMilestone({
      projectId: pId,
      name: v.name ?? '',
      date: v.date ?? '',
      status: 'Pending',
      // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — same rule as
      // project-cost-centers.ts's saveCostCenter(). The close/reset used to run
      // unconditionally right after firing the POST, so the typed values were wiped
      // while the request was still in flight and a refusal left a toast over an
      // empty screen.
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.milestoneRes.reload();
        this.closeMilestoneForm();
      },
      error: this.planSaveError('Could not save the milestone.'),
    });
  }

  openWpForm() {
    this.showWpForm.set(true);
  }

  closeWpForm() {
    this.showWpForm.set(false);
    this.saveError.set(null);
    this.wpForm.reset();
  }

  saveWp() {
    if (this.wpForm.invalid) return;
    const pId = this.activeProjectId();
    if (!pId) return;

    this.saveError.set(null);
    const v = this.wpForm.getRawValue();
    this.api.createWorkPackage({
      projectId: pId,
      name: v.name ?? '',
      startDate: v.startDate ?? '',
      endDate: v.endDate ?? '',
      status: 'Planned',
      progress: 0,
      assignee: v.assignee ?? '',
      // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — see saveMilestone() above.
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.wpRes.reload();
        this.closeWpForm();
      },
      error: this.planSaveError('Could not save the work package.'),
    });
  }

  openEditWpForm(wp: WorkPackage) {
    this.editingWpId.set(wp.id);
    this.editWpForm.setValue({
      name: wp.name,
      startDate: wp.startDate,
      endDate: wp.endDate,
      assignee: wp.assignee,
      status: wp.status,
      progress: wp.progress,
    });
    this.showEditWpForm.set(true);
  }

  closeEditWpForm() {
    this.showEditWpForm.set(false);
    this.editingWpId.set(null);
    this.saveError.set(null);
    this.editWpForm.reset();
  }

  saveEditWp() {
    if (this.editWpForm.invalid) return;
    const id = this.editingWpId();
    if (!id) return;

    this.saveError.set(null);
    const v = this.editWpForm.getRawValue();
    this.api.updateWorkPackage(id, {
      name: v.name ?? '',
      startDate: v.startDate ?? '',
      endDate: v.endDate ?? '',
      assignee: v.assignee ?? '',
      status: v.status ?? 'Planned',
      progress: v.progress ?? 0,
      // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — see saveMilestone() above. This
      // form is the worst case of the three: `closeEditWpForm()` also clears
      // editingWpId, so a refusal both emptied the dialog AND lost which work package
      // was being edited.
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.wpRes.reload();
        this.closeEditWpForm();
      },
      error: this.planSaveError('Could not save the work package.'),
    });
  }

  /**
   * The milestone awaiting confirmation. Holds the WHOLE milestone, not just an
   * id, so the dialog can name it without re-finding it in a list that may have
   * reloaded underneath.
   */
  pendingAchieve = signal<Milestone | null>(null);

  /** First click: arm the confirm ONLY. No PUT goes out from here. */
  requestAchieveMilestone(milestone: Milestone) {
    this.pendingAchieve.set(milestone);
  }

  cancelAchieveMilestone() {
    this.pendingAchieve.set(null);
  }

  confirmAchieveMilestone() {
    const milestone = this.pendingAchieve();
    if (!milestone) return;
    // Cleared BEFORE the request so a double-click on the confirm control cannot
    // issue the money-releasing PUT twice.
    this.pendingAchieve.set(null);
    this.achieveMilestone(milestone);
  }

  private achieveMilestone(milestone: Milestone) {
    // `status` ONLY. `approvedBy`/`approvedAt` are deliberately NOT sent: they are
    // absent from server.ts's MILESTONE_FIELDS allow-list and pinned to the verified
    // principal by `milestoneApprovalPatch` on the transition itself, so a body
    // carrying them was both inert and a standing invitation to forge an approver.
    this.api.updateMilestone(milestone.id, { status: 'Achieved' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.milestoneRes.reload();
        // Names what was released, not just that something was approved.
        this.notificationService.show(
          `Milestone “${milestone.name}” achieved — linked fixed-price billing conditions are now invoiceable.`,
          'success',
        );
      });
  }
}
