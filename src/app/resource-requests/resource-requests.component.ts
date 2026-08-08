import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceRequest, Assignment, Resource, ProjectRole, Skill } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { AllocationCalendarComponent } from '../allocation-calendar/allocation-calendar.component';
import { endNotBeforeStart } from '../services/date-range.validator';

interface RequestsData {
  requests: ResourceRequest[];
  assignments: Assignment[];
  resources: Resource[];
}

@Component({
  selector: 'app-resource-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, DecimalPipe, ModalDialogDirective, AllocationCalendarComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Manage Resource Requests</h1>
          <p class="text-sm text-[var(--cc-muted)] mt-1">Create and manage staffing requests for your projects.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <!-- SEGMENTED CONTROL: which view is active was communicated by background
               and text colour ONLY, so a screen-reader user heard two identical plain
               buttons and could not tell which one they were already on.
               aria-pressed is the toggle-button state; it must be present on BOTH
               buttons (an attribute only on the active one is indistinguishable from
               a control that is never pressed). -->
          <div class="command-card-muted p-1 flex items-center" role="group" aria-label="Select view">
            <button type="button" (click)="currentView.set('requests')"
                    data-test="view-requests"
                    [attr.aria-pressed]="currentView() === 'requests'"
                    [class.bg-surface]="currentView() === 'requests'"
                    [class.shadow-sm]="currentView() === 'requests'"
                    [class.text-ink]="currentView() === 'requests'"
                    [class.text-ink-muted]="currentView() !== 'requests'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Requests
            </button>
            <button type="button" (click)="currentView.set('availability')"
                    data-test="view-availability"
                    [attr.aria-pressed]="currentView() === 'availability'"
                    [class.bg-surface]="currentView() === 'availability'"
                    [class.shadow-sm]="currentView() === 'availability'"
                    [class.text-ink]="currentView() === 'availability'"
                    [class.text-ink-muted]="currentView() !== 'availability'"
                    class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
              Resource Availability
            </button>
          </div>
          @if (currentView() === 'requests') {
            <button type="button" (click)="openCreateForm()" class="command-button w-full sm:w-auto"
                    aria-controls="requestEditor" [attr.aria-expanded]="showForm()">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create Request
            </button>
          }
        </div>
      </div>

      @if (currentView() === 'requests') {
        @if (showForm()) {
          <section id="requestEditor" class="command-card p-8 relative overflow-hidden" aria-labelledby="requestEditorTitle">
            <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent to-accent"></div>
            <h2 #requestFormHeading id="requestEditorTitle" tabindex="-1"
                class="font-display text-2xl font-bold text-[var(--cc-ink)] mb-8 outline-none">
              {{ editingId() ? 'Edit Request' : 'New Resource Request' }}
            </h2>
            <form [formGroup]="requestForm" (ngSubmit)="saveRequest()" class="space-y-6">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-1.5">
                  <label for="name" class="block text-sm font-semibold text-ink-secondary">Project Name <span class="text-critical">*</span></label>
                  <input id="name" formControlName="name" class="command-input" required aria-required="true"
                         [attr.aria-invalid]="showFieldError('name') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('name') ? 'requestNameError' : null">
                  @if (showFieldError('name')) {
                    <p id="requestNameError" class="command-field-error" role="alert">Project name is required.</p>
                  }
                </div>
                <div class="space-y-1.5">
                  <label for="requiredRole" class="block text-sm font-semibold text-ink-secondary">Required Role <span class="text-critical">*</span></label>
                  <select id="requiredRole" formControlName="requiredRole" class="command-select" required aria-required="true"
                          [attr.aria-invalid]="showFieldError('requiredRole') ? 'true' : null"
                          [attr.aria-describedby]="showFieldError('requiredRole') ? 'requestRoleError' : null">
                    <option value="" disabled>Select a role...</option>
                    @for (role of roleOptions(); track role.id) {
                      <option [value]="role.name">{{ role.name }}</option>
                    }
                    <!-- ORPHAN VALUE: a stored requiredRole not in the catalog (e.g. legacy free
                         text) stays selectable as a disabled option so editing never wipes it.
                         requiredRole feeds match-scoring, so preserving the exact value matters. -->
                    @if (orphanRole(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                  @if (showFieldError('requiredRole')) {
                    <p id="requestRoleError" class="command-field-error" role="alert">Select a required role.</p>
                  }
                </div>
                <div class="space-y-1.5">
                  <label for="requiredEffort" class="block text-sm font-semibold text-ink-secondary">Required Effort (Hours) <span class="text-critical">*</span></label>
                  <input id="requiredEffort" type="number" formControlName="requiredEffort" class="command-input"
                         min="1" required aria-required="true"
                         [attr.aria-invalid]="showFieldError('requiredEffort') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('requiredEffort') ? 'requestEffortError' : null">
                  @if (showFieldError('requiredEffort')) {
                    <p id="requestEffortError" class="command-field-error" role="alert">Required effort must be at least 1 hour.</p>
                  }
                </div>
                <div class="space-y-1.5">
                  <label for="skills" class="block text-sm font-semibold text-ink-secondary">Required Skills</label>
                  <!--
                    Skills are catalog values, never free text: the stored value is the
                    skill NAME, which is what match-scoring compares against.

                    This used to be a multiple-selection list box: picking more than one entry
                    required Ctrl/Cmd-click, which does not exist on touch, so on a
                    phone or tablet the field could hold exactly one skill and picking a
                    second silently replaced the first. Replaced by the repo's existing
                    choose-then-add + removable-chip pattern
                    (my-profile.component.ts:132-178), which is operable with taps and
                    with the keyboard alone.

                    ORPHAN VALUES: the model is the RAW string[] and is never
                    intersected with the option list — a stored skill absent from
                    today's catalog (legacy free text) therefore renders as a chip like
                    any other and stays removable. Filtering the model against
                    skillOptions() anywhere here would silently drop saved values on
                    the next save, which is the actual data-loss risk in this control.
                  -->
                  <div class="flex gap-2">
                    <select #skillPicker id="skills" aria-label="Skill to add" class="command-select flex-1"
                            (change)="skillToAdd.set(skillPicker.value)">
                      <option value="">Select a skill...</option>
                      @for (skill of addableSkillOptions(); track skill.id) {
                        <option [value]="skill.name">{{ skill.name }}</option>
                      }
                    </select>
                    <button type="button" data-test="add-skill" (click)="addSkill(skillPicker)" [disabled]="!skillToAdd()"
                            class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Add
                    </button>
                  </div>
                  <div class="flex flex-wrap gap-2 pt-1" data-test="selected-skills">
                    @for (skill of selectedSkills(); track skill) {
                      <span class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs font-medium text-ink-secondary"
                            data-test="selected-skill">
                        <!-- The label is its own element so a test can read it without
                             picking up the remove button's mat-icon ligature text. -->
                        <span data-test="selected-skill-label">{{ skill }}@if (isOrphanSkill(skill)) {<span class="text-ink-muted italic"> (not in catalog)</span>}</span>
                        <button type="button" (click)="removeSkill(skill)" [attr.aria-label]="'Remove ' + skill" [attr.title]="'Remove ' + skill"
                                class="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-muted hover:text-critical-text transition-colors">
                          <mat-icon class="text-[14px] w-[14px] h-[14px]">close</mat-icon>
                        </button>
                      </span>
                    }
                    @if (!selectedSkills().length) {
                      <p class="text-xs font-medium text-[var(--cc-muted)]">No skills required yet.</p>
                    }
                  </div>
                </div>
                <div class="space-y-1.5">
                  <label for="startDate" class="block text-sm font-semibold text-ink-secondary">Start Date</label>
                  <input id="startDate" type="date" formControlName="startDate" class="command-input">
                </div>
                <div class="space-y-1.5">
                  <label for="endDate" class="block text-sm font-semibold text-ink-secondary">End Date</label>
                  <input id="endDate" type="date" formControlName="endDate" class="command-input"
                         [min]="requestForm.controls.startDate.value || null"
                         [attr.aria-invalid]="showFieldError('endDate') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('endDate') ? 'requestEndDateError' : null">
                  @if (showFieldError('endDate')) {
                    <p id="requestEndDateError" class="command-field-error" role="alert">End date must be on or after the start date.</p>
                  }
                </div>
              </div>
              <div class="space-y-1.5">
                <label for="description" class="block text-sm font-semibold text-ink-secondary">Description</label>
                <textarea id="description" formControlName="description" rows="4" placeholder="Provide details about the project and the role..." class="command-textarea"></textarea>
              </div>
              <div class="pt-6 border-t border-[var(--cc-line)]">
                @if (confirmingFormDiscard()) {
                  <div role="alert" class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <p class="font-semibold text-ink">Discard unsaved request changes?</p>
                      <p class="text-sm text-ink-muted">Your edits have not been saved.</p>
                    </div>
                    <div class="flex justify-end gap-3">
                      <button type="button" (click)="confirmingFormDiscard.set(false)" class="command-button secondary">Continue editing</button>
                      <button type="button" (click)="closeForm(true)" class="command-button">Discard changes</button>
                    </div>
                  </div>
                } @else {
                  <div class="flex justify-end gap-3">
                    <button type="button" (click)="closeForm()" [disabled]="savingRequest()" class="command-button secondary disabled:opacity-50">Cancel</button>
                    <button type="submit" [disabled]="savingRequest()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                      {{ savingRequest() ? 'Saving request…' : 'Save Request' }}
                    </button>
                  </div>
                }
              </div>
            </form>
          </section>
        }

        @if (requestsLoading()) {
          <div class="space-y-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading resource requests">
            @for (row of [1, 2, 3, 4]; track row) {
              <div class="command-skeleton h-14"></div>
            }
          </div>
        } @else if (requestsReadFailed()) {
          <div class="command-card border-critical! p-10 text-center" role="alert">
            <mat-icon class="text-critical-text text-3xl">error_outline</mat-icon>
            <h2 class="mt-3 font-display text-lg font-bold text-ink">Couldn't load resource requests</h2>
            <p class="mt-1 text-sm text-ink-muted">Requests, assignments, or resource data could not be retrieved.</p>
            <button type="button" (click)="reloadRequests()" class="command-button mt-4">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
            </button>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="command-data-table min-w-[800px]">
              <thead>
                <tr>
                  <th>Project Details</th>
                  <th>Role & Skills</th>
                  <th>Staffing Status</th>
                  <th>State</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (req of myRequests(); track req.id) {
                  <tr class="transition-colors group">
                    <td>
                      <div class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ req.name }}</div>
                      <div class="text-xs font-medium text-[var(--cc-muted)] mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">event</mat-icon> {{ req.startDate || 'TBD' }} to {{ req.endDate || 'TBD' }}</div>
                      @if (req.description) {
                        <div class="text-xs text-[var(--cc-muted)] mt-1.5 truncate max-w-[200px]" [title]="req.description">{{ req.description }}</div>
                      }
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">badge</mat-icon> {{ req.requiredRole }}</div>
                      <div class="text-xs font-medium text-[var(--cc-muted)] mt-1 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px] text-ink-muted">psychology</mat-icon> {{ req.skills.join(', ') || 'No specific skills' }}</div>
                    </td>
                    <td>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-[var(--cc-ink)] font-mono tabular-nums">{{ req.staffedEffort || 0 }} / {{ req.requiredEffort }}h</span>
                          <span class="font-mono tabular-nums"
                                [class.text-positive-text]="getStaffingPercentage(req) >= 100"
                                [class.text-caution-text]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                                [class.text-ink-muted]="getStaffingPercentage(req) === 0">
                            {{ getStaffingPercentage(req) | number:'1.0-0' }}%
                          </span>
                        </div>
                        <!-- Two-value staffing bar: CONFIRMED (staffedEffort, solid) with a
                             lighter hatched PLANNED overlay (staffedEffortPlanned = requested +
                             allocated). Planned falls back to confirmed when absent, so the
                             overlay simply vanishes. The confirmed layer paints last (on top). -->
                        <div class="relative w-full bg-surface-muted rounded-full h-2 overflow-hidden"
                             role="img" [attr.aria-label]="staffingBarLabel(req)" [title]="staffingBarLabel(req)">
                          @if (getPlannedStaffingPercentage(req) > getStaffingPercentage(req)) {
                            <div class="absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-out"
                                 [style.width.%]="getPlannedStaffingPercentage(req)"
                                 [style.background]="plannedStripe"></div>
                          }
                          <div class="absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-out"
                               [class.bg-positive]="getStaffingPercentage(req) >= 100"
                               [class.bg-caution]="getStaffingPercentage(req) > 0 && getStaffingPercentage(req) < 100"
                               [class.bg-line-strong]="getStaffingPercentage(req) === 0"
                               [style.width.%]="getStaffingPercentage(req)"></div>
                        </div>
                        @if (getPlannedStaffingPercentage(req) > getStaffingPercentage(req)) {
                          <span class="text-[10px] font-medium text-caution-text flex items-center gap-1">
                            <mat-icon class="text-[12px] w-[12px] h-[12px]">hourglass_empty</mat-icon>
                            {{ req.staffedEffortPlanned }}h planned (pending approval)
                          </span>
                        }
                      </div>
                    </td>
                    <td>
                      <span class="command-chip" [class]="statusChipTone(req.status)">
                        {{ req.status }}
                      </span>
                    </td>
                    <td class="text-right space-x-1">
                      @if (req.status !== 'Not Published' && req.status !== 'Withdrawn') {
                        <button (click)="trackRequest(req)" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-all" [attr.aria-label]="'Track staffing for ' + req.name" [attr.title]="'Track staffing for ' + req.name">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">analytics</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Not Published' || req.status === 'Withdrawn') {
                        <button (click)="openEditForm(req)" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-all" [attr.aria-label]="'Edit request ' + req.name" [attr.title]="'Edit request ' + req.name">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                        </button>
                        <button type="button" (click)="askRequestTransition(req, 'Published')" class="p-2 text-ink-muted hover:text-positive-text hover:bg-positive-tint rounded-lg transition-all" [attr.aria-label]="'Publish request ' + req.name + ' (' + req.id + ')'" [attr.title]="'Publish request ' + req.name">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">publish</mat-icon>
                        </button>
                        <!-- Arms the confirm below; nothing is deleted from here. -->
                        <button type="button" (click)="askDeleteRequest(req)" class="p-2 text-ink-muted hover:text-critical-text hover:bg-critical-tint rounded-lg transition-all" [attr.aria-label]="'Delete request ' + req.name" [attr.title]="'Delete request ' + req.name">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                        </button>
                      }
                      @if (req.status === 'Published' || req.status === 'Open' || req.status === 'Fulfilled') {
                        <button type="button" (click)="askRequestTransition(req, 'Withdrawn')" class="p-2 text-ink-muted hover:text-caution-text hover:bg-caution-tint rounded-lg transition-all" [attr.aria-label]="'Withdraw request ' + req.name + ' (' + req.id + ')'" [attr.title]="'Withdraw request ' + req.name">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">undo</mat-icon>
                        </button>
                      }
                    </td>
                  </tr>
                }
                @if (!myRequests().length) {
                  <tr>
                    <td colspan="5" class="text-center text-[var(--cc-muted)]">
                      <div class="flex flex-col items-center justify-center px-6 py-12">
                        <mat-icon class="text-4xl mb-3 opacity-50">assignment</mat-icon>
                        <p class="font-medium">No resource requests found.</p>
                        <p class="text-sm mt-1">Create one to get started.</p>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
        }
      } @else {
        <!-- Resource Availability View -->
        @if (requestsLoading()) {
          <div class="space-y-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading resource availability">
            @for (row of [1, 2, 3, 4]; track row) {
              <div class="command-skeleton h-14"></div>
            }
          </div>
        } @else if (requestsReadFailed()) {
          <div class="command-card border-critical! p-10 text-center" role="alert">
            <mat-icon class="text-critical-text text-3xl">error_outline</mat-icon>
            <h2 class="mt-3 font-display text-lg font-bold text-ink">Couldn't load resource availability</h2>
            <p class="mt-1 text-sm text-ink-muted">Resource capacity could not be retrieved.</p>
            <button type="button" (click)="reloadRequests()" class="command-button mt-4">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
            </button>
          </div>
        } @else {
        <div class="command-card overflow-hidden flex flex-col">
          <div class="p-6 border-b border-[var(--cc-line)] flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[var(--cc-panel-muted)]">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resource Availability</h2>
            <div class="relative w-full sm:w-auto">
              <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-[20px] w-[20px] h-[20px]">search</mat-icon>
              <input
                type="text"
                [formControl]="availabilitySearch"
                placeholder="Search by name, role, or skills..."
                aria-label="Search resource availability"
                class="command-input sm:w-72 pl-10"
              >
            </div>
          </div>
          <div class="overflow-x-auto flex-1">
            <table class="command-data-table min-w-[800px]">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Role & Skills</th>
                  <th>Capacity</th>
                  <th>Utilization</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (res of filteredAvailability(); track res.id) {
                  <tr class="transition-colors group">
                    <td>
                      <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-gradient-to-br from-accent to-accent rounded-full flex items-center justify-center text-white font-semibold text-lg shadow-inner shrink-0">
                          {{ res.name.charAt(0) }}
                        </div>
                        <div class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ res.name }}</div>
                      </div>
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-semibold flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">badge</mat-icon> {{ res.role }}</div>
                      <div class="flex gap-1.5 mt-2 flex-wrap">
                        @for (skill of res.skills; track skill.name) {
                          <span class="text-[11px] font-medium bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-md border border-line">{{ skill.name }}</span>
                        }
                      </div>
                    </td>
                    <td>
                      <div class="text-[var(--cc-ink)] font-medium flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">schedule</mat-icon> <span class="font-mono tabular-nums">{{ res.capacity }}h</span> / week</div>
                    </td>
                    <td>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between text-xs font-semibold">
                          <span class="text-ink-secondary">Utilization</span>
                          <span class="font-mono tabular-nums"
                                [class.text-positive-text]="res.utilization >= 80 && res.utilization <= 100"
                                [class.text-caution-text]="res.utilization > 0 && res.utilization < 80"
                                [class.text-critical-text]="res.utilization > 100"
                                [class.text-ink-muted]="res.utilization === 0">
                            {{ res.utilization | number:'1.0-0' }}%
                          </span>
                        </div>
                        <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden">
                          <div class="h-2 rounded-full transition-all duration-1000 ease-out"
                               [class.bg-positive]="res.utilization >= 80 && res.utilization <= 100"
                               [class.bg-caution]="res.utilization > 0 && res.utilization < 80"
                               [class.bg-critical]="res.utilization > 100"
                               [class.bg-line-strong]="res.utilization === 0"
                               [style.width.%]="res.utilization > 100 ? 100 : res.utilization"></div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="command-chip" [class]="getAvailableHours(res) > 0 ? 'is-positive' : 'is-neutral'">
                        {{ getAvailableHours(res) > 0 ? getAvailableHours(res) + 'h available' : 'Fully booked' }}
                      </span>
                    </td>
                  </tr>
                }
                @if (!filteredAvailability().length) {
                  <tr>
                    <td colspan="5" class="text-center text-[var(--cc-muted)]">
                      <div class="flex flex-col items-center justify-center px-6 py-12">
                        <mat-icon class="text-4xl mb-3 opacity-50">{{ resources().length ? 'search_off' : 'group_off' }}</mat-icon>
                        @if (resources().length) {
                          <p class="font-medium">No resources match “{{ searchValue().trim() }}”.</p>
                          <button type="button" (click)="clearAvailabilitySearch()" class="command-button secondary mt-3">Clear search</button>
                        } @else {
                          <p class="font-medium">No resource availability data yet.</p>
                          <p class="text-sm mt-1">Resources will appear here after they are added.</p>
                        }
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
        }
      }

      @if (trackingDetails() && !calendarTarget()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6"
             appModal ariaLabelledby="trackingModalTitle" (dismiss)="closeTracking()">
          <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] flex items-start justify-between bg-gradient-to-br from-surface-muted to-transparent">
              <div>
                <h2 id="trackingModalTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] tracking-tight">Staffing Progress</h2>
                <p class="text-sm font-medium text-[var(--cc-muted)] mt-1.5 flex items-center gap-1.5">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">work_outline</mat-icon>
                  {{ trackingDetails()?.request?.name }}
                </p>
              </div>
              <button type="button" (click)="closeTracking()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <!-- Progress Bar -->
              <div class="command-card-muted mb-10 p-6">
                <div class="flex justify-between items-end mb-3">
                  <span class="font-semibold text-ink-secondary">Overall Progress</span>
                  <span class="text-2xl font-bold text-[var(--cc-primary-text)] tracking-tight font-mono tabular-nums">{{ getStaffingPercentage(trackingDetails()!.request) }}%</span>
                </div>
                <div class="w-full bg-surface-muted rounded-full h-3 overflow-hidden shadow-inner">
                  <div class="h-3 rounded-full transition-all duration-1000 ease-out relative"
                       [class.bg-positive]="getStaffingPercentage(trackingDetails()!.request) >= 100"
                       [class.bg-caution]="getStaffingPercentage(trackingDetails()!.request) > 0 && getStaffingPercentage(trackingDetails()!.request) < 100"
                       [class.bg-line-strong]="getStaffingPercentage(trackingDetails()!.request) === 0"
                       [style.width.%]="getStaffingPercentage(trackingDetails()!.request)">
                    <div class="absolute inset-0 bg-surface/20 w-full h-full"></div>
                  </div>
                </div>
                <div class="flex justify-between text-sm font-medium text-ink-muted mt-3">
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-positive-text">check_circle</mat-icon> {{ trackingDetails()?.request?.staffedEffort || 0 }}h Staffed</span>
                  <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px] text-caution-text">pending</mat-icon> {{ trackingDetails()?.remaining }}h Remaining of {{ trackingDetails()?.request?.requiredEffort }}h</span>
                </div>
              </div>

              <!-- Assigned Resources -->
              <div class="flex items-center justify-between mb-4">
                <h3 class="command-section-label">Assigned Resources</h3>
                <span class="command-status">{{ trackingDetails()?.assignments?.length || 0 }}</span>
              </div>

              <div class="space-y-3">
                @for (item of trackingDetails()?.assignments; track item.assignment.id) {
                  <div class="command-card-muted flex items-center justify-between p-4 hover:shadow-md transition-all group">
                    <div class="flex items-center gap-4">
                      <div class="w-12 h-12 bg-accent-tint border border-accent rounded-full flex items-center justify-center text-accent-text font-bold shadow-sm shrink-0">
                        {{ item.resource?.name?.charAt(0) || '?' }}
                      </div>
                      <div>
                        <h4 class="font-semibold text-[var(--cc-ink)] group-hover:text-accent-text transition-colors">{{ item.resource?.name || 'Unknown Resource' }}</h4>
                        <p class="text-xs font-medium text-[var(--cc-muted)] mt-0.5 flex items-center gap-1"><mat-icon class="text-[14px] w-[14px] h-[14px]">badge</mat-icon> {{ item.resource?.role }}</p>
                      </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-1.5">
                      <div class="font-bold text-[var(--cc-primary-text)] text-lg font-mono tabular-nums">{{ item.assignment.assignedHours }}h</div>
                      <!-- Allocation status: Draft (neutral) · Requested (amber) ·
                           Allocated (green) · Rejected (red). command-status tones
                           carry the -text accent colour (WCAG AA). -->
                      <div class="command-status uppercase" [class]="assignmentStatusClass(item.assignment.status)">
                        {{ item.assignment.status }}
                      </div>
                      <!-- Time-phased allocation (B1): open the per-day calendar for this
                           assignment. Swaps overlays (tracking hidden while open) so a
                           single focus trap is active; closing returns to tracking. -->
                      <button type="button" (click)="openCalendar(item)"
                              class="inline-flex items-center gap-1 text-xs font-semibold text-accent-text hover:bg-accent-tint px-2 py-1 rounded-md transition-colors"
                              [attr.aria-label]="'Open the allocation calendar for ' + (item.resource?.name || 'resource')">
                        <mat-icon class="text-[16px] w-[16px] h-[16px]">calendar_month</mat-icon> Calendar
                      </button>
                    </div>
                  </div>
                }
                @if (trackingDetails()?.assignments?.length === 0) {
                  <div class="text-center p-8 border-2 border-dashed border-line rounded-lg bg-[var(--cc-panel-muted)]">
                    <div class="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-line">
                      <mat-icon class="text-ink-muted text-3xl">person_add_disabled</mat-icon>
                    </div>
                    <p class="font-medium text-ink-secondary">No resources assigned yet</p>
                    <p class="text-sm text-[var(--cc-muted)] mt-1">Assignments will appear here once staffed.</p>
                  </div>
                }
              </div>
            </div>

            <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end">
              <button (click)="closeTracking()" class="command-button secondary">Close</button>
            </div>
          </div>
        </div>
      }

      <!--
        DELETE CONFIRMATION. The trash icon fired the DELETE on a single click; the
        only comment in its handler read "In a real app, use a custom modal here
        instead of window.confirm" — and there was no window.confirm either.
        Delete is offered for 'Not Published' and 'Withdrawn' requests, and a
        Withdrawn request has usually been STAFFED already, so the copy has to name
        the request, its effort, and how many assignments are hanging off it: those
        assignments are not deleted with it, and the request record that carries the
        staffing history is not shown anywhere else once it is gone.
        Short dialog, so the plain centred overlay is deliberate.
      -->
      @if (pendingDelete(); as pending) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="requestDeleteTitle" (dismiss)="cancelDeleteRequest()">
          <div class="command-card shadow-2xl w-full max-w-md overflow-hidden flex flex-col" data-test="request-delete-confirm">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="requestDeleteTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Delete resource request</h3>
              <p class="text-[var(--cc-muted)] text-sm">
                <strong class="text-ink">{{ pending.name }}</strong> &mdash;
                {{ pending.requiredRole }}, {{ pending.requiredEffort | number:'1.0-2' }}h &mdash; is deleted,
                together with its staffing record.
                @if (pendingAssignmentCount() > 0) {
                  <span data-test="request-delete-staffed">
                    {{ pendingAssignmentCount() | number:'1.0-0' }} assignment(s) have already been made against it;
                    they are NOT deleted with the request and are left pointing at a request that no longer exists.
                  </span>
                } @else {
                  <span data-test="request-delete-unstaffed">Nothing is staffed against it yet.</span>
                }
                This cannot be undone.
              </p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelDeleteRequest()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmDeleteRequest()" data-test="request-delete-confirm-action" class="px-4 py-2 bg-critical text-ink-inverse rounded-lg text-sm font-semibold hover:bg-critical-strong transition-colors shadow-sm">
                Delete request
              </button>
            </div>
          </div>
        </div>
      }

      @if (pendingTransition(); as transition) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="requestTransitionTitle" (dismiss)="cancelRequestTransition()">
          <div class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col" data-test="request-transition-confirm">
            <div class="p-6 sm:p-8">
              <div class="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ring-1"
                   [class.bg-positive-tint]="transition.target === 'Published'"
                   [class.ring-positive]="transition.target === 'Published'"
                   [class.bg-caution-tint]="transition.target === 'Withdrawn'"
                   [class.ring-caution]="transition.target === 'Withdrawn'">
                <mat-icon [class.text-positive-text]="transition.target === 'Published'"
                          [class.text-caution-text]="transition.target === 'Withdrawn'">
                  {{ transition.target === 'Published' ? 'publish' : 'undo' }}
                </mat-icon>
              </div>
              <h2 id="requestTransitionTitle" class="font-display text-xl font-bold text-center text-[var(--cc-ink)] break-words">
                {{ transition.target === 'Published' ? 'Publish' : 'Withdraw' }} {{ transition.request.name }}?
              </h2>
              <div class="command-card-muted mt-5 p-4 text-sm text-[var(--cc-muted)] space-y-2">
                <p><strong class="text-ink">Request:</strong> {{ transition.request.name }} (<span class="font-mono break-all">{{ transition.request.id }}</span>)</p>
                <p><strong class="text-ink">Role and effort:</strong> {{ transition.request.requiredRole }}, {{ transition.request.requiredEffort | number:'1.0-2' }}h total, {{ transitionRemainingEffort() | number:'1.0-2' }}h remaining</p>
                <p><strong class="text-ink">Window:</strong> {{ transition.request.startDate || 'TBD' }} to {{ transition.request.endDate || 'TBD' }}</p>
                @if (transition.target === 'Published') {
                  <p>Publishing makes this request available to staffing and matching workflows.</p>
                } @else {
                  <p data-test="withdraw-consequence">
                    Withdrawing removes the request from active staffing. It does not remove
                    {{ transitionAssignmentCount() | number:'1.0-0' }} existing assignment(s) or their recorded hours.
                  </p>
                  @if (transition.request.status === 'Fulfilled') {
                    <p class="font-semibold text-caution-text">This request is fulfilled; withdrawing it changes its visible lifecycle while staffed work remains linked.</p>
                  }
                }
              </div>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelRequestTransition()" [disabled]="transitionPending()" class="command-button secondary disabled:opacity-50">Cancel</button>
              <button type="button" (click)="confirmRequestTransition()" [disabled]="transitionPending()"
                      data-test="request-transition-confirm-action" class="command-button disabled:opacity-50">
                {{ transitionPending() ? 'Updating…' : (transition.target === 'Published' ? 'Publish request' : 'Withdraw request') }}
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Time-phased allocation calendar (B1). Rendered as its own modal overlay;
           while it is open the tracking modal above is hidden so only one focus trap
           is active. The panel content lives in AllocationCalendarComponent. -->
      @if (calendarTarget(); as target) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6"
             appModal ariaLabelledby="allocCalTitle" (dismiss)="closeCalendar()">
          <app-allocation-calendar
            [assignmentId]="target.assignmentId"
            [resourceName]="target.resourceName"
            (closed)="closeCalendar()" />
        </div>
      }
    </div>
  `
})
export class ResourceRequestsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  // Read LIVE, never snapshot at field-init (see auth.service note): a captured
  // value freezes the anonymous default and shows the wrong user's data on reload.
  private get currentUserId(): string { return this.auth.userId(); }

  // The resources read is principal-gated server-side (401 until the Keycloak JWT
  // is restored). On reload the OIDC token restores async; firing the forkJoin
  // immediately 401s and the rxResource latches on the error. Key the load on auth
  // readiness so it fires only AFTER the OAuth bootstrap has settled and the bearer
  // token is attached.
  private res = rxResource<RequestsData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          requests: this.api.getRequests(),
          assignments: this.api.getAssignments(),
          resources: this.api.getResources()
        })
      : of<RequestsData>({ requests: [], assignments: [], resources: [] }),
    defaultValue: { requests: [], assignments: [], resources: [] }
  });

  protected requestsLoading = computed(() => !this.auth.authReady() || this.res.isLoading());
  protected requestsReadFailed = computed(() => this.res.status() === 'error');
  private requestData = computed<RequestsData>(() => this.requestsReadFailed()
    ? { requests: [], assignments: [], resources: [] }
    : this.res.value());
  requests = computed(() => this.requestData().requests);
  assignments = computed(() => this.requestData().assignments);
  resources = computed(() => this.requestData().resources);

  protected reloadRequests(): void {
    this.res.reload();
  }

  // Required-role option source: the canonical /project-roles catalog. Stored value
  // = name (Phase A), which is what match-scoring compares against. Keyed on
  // authReady to mirror the principal-gated config reads elsewhere.
  private rolesRes = rxResource<ProjectRole[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjectRoles() : of<ProjectRole[]>([])),
    defaultValue: [] as ProjectRole[],
  });
  roleOptions = this.rolesRes.value;

  // ORPHAN VALUE: when editing a request whose stored requiredRole isn't in the
  // catalog, expose it so the select still shows it and saving doesn't wipe it.
  orphanRole = computed<string | null>(() => {
    const current = this.editingRole();
    if (!current) return null;
    return this.roleOptions().some(r => r.name === current) ? null : current;
  });
  /** The requiredRole value currently loaded into the form (drives orphan detection). */
  private editingRole = signal<string>('');

  // Required-skills option source: the canonical /skills catalog. Stored value =
  // skill name, which is what match-scoring compares against. Keyed on authReady
  // to mirror the principal-gated reads above.
  private skillsRes = rxResource<Skill[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getSkills() : of<Skill[]>([])),
    defaultValue: [] as Skill[],
  });
  skillOptions = this.skillsRes.value;
  // The skills chip model and its helpers live beside `requestForm` below: field
  // initialisers run in declaration order, so anything reading
  // requestForm.controls.skills has to be declared after it.

  showForm = signal(false);
  editingId = signal<string | null>(null);
  savingRequest = signal(false);
  formSubmitAttempted = signal(false);
  confirmingFormDiscard = signal(false);
  private requestFormHeading = viewChild<ElementRef<HTMLElement>>('requestFormHeading');
  private focusEditorOnRender = false;
  private focusInvalidVersion = signal(0);
  private handledInvalidVersion = 0;
  trackingRequestId = signal<string | null>(null);
  currentView = signal<'requests' | 'availability'>('requests');

  availabilitySearch = new FormControl('');
  searchValue = signal('');

  constructor() {
    this.availabilitySearch.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(v => this.searchValue.set(v || ''));

    afterRenderEffect(() => {
      const heading = this.requestFormHeading()?.nativeElement;
      const invalidVersion = this.focusInvalidVersion();
      if (this.showForm() && this.focusEditorOnRender && heading) {
        this.focusEditorOnRender = false;
        heading.focus();
      }
      if (this.showForm() && invalidVersion > this.handledInvalidVersion) {
        const invalid = this.hostEl.nativeElement.querySelector<HTMLElement>(
          '#requestEditor input.ng-invalid, #requestEditor select.ng-invalid, #requestEditor textarea.ng-invalid',
        );
        if (invalid) {
          this.handledInvalidVersion = invalidVersion;
          invalid.focus();
        }
      }
    });
  }

  // Authorization: Only show requests created by the current user
  myRequests = computed(() => this.requests().filter(r => r.requesterId === this.currentUserId));

  filteredAvailability = computed(() => {
    const search = this.searchValue().trim().toLowerCase();
    return this.resources().filter(res => {
      if (!search) return true;
      const matchesName = res.name.toLowerCase().includes(search);
      const matchesRole = res.role.toLowerCase().includes(search);
      const matchesSkills = res.skills.some(s => s.name.toLowerCase().includes(search));
      return matchesName || matchesRole || matchesSkills;
    });
  });

  protected clearAvailabilitySearch(): void {
    this.availabilitySearch.setValue('');
  }

  getAvailableHours(res: Resource): number {
    const utilizedHours = (res.capacity * res.utilization) / 100;
    return Math.max(0, Math.round(res.capacity - utilizedHours));
  }

  trackingDetails = computed(() => {
    const reqId = this.trackingRequestId();
    if (!reqId) return null;
    const req = this.requests().find(r => r.id === reqId);
    if (!req) return null;

    const reqAssignments = this.assignments().filter(a => a.requestId === reqId);
    const staffedResources = reqAssignments.map(a => {
      const res = this.resources().find(r => r.id === a.resourceId);
      return {
        assignment: a,
        resource: res
      };
    });

    return {
      request: req,
      assignments: staffedResources,
      remaining: Math.max(0, req.requiredEffort - (req.staffedEffort || 0))
    };
  });

  requestForm = new FormGroup({
    name: new FormControl('', Validators.required),
    requiredRole: new FormControl('', Validators.required),
    requiredEffort: new FormControl(0, [Validators.required, Validators.min(1)]),
    skills: new FormControl<string[]>([], { nonNullable: true }),
    description: new FormControl(''),
    startDate: new FormControl(''),
    endDate: new FormControl('')
    // P2-35: dates are optional here, but an inverted pair is still refused by
    // resourceRequestUpdateError server-side.
  }, { validators: endNotBeforeStart('startDate', 'endDate') });

  /**
   * The skills currently on the request, read straight off the form control — the
   * RAW `string[]` that will be saved. Deliberately NOT intersected with
   * `skillOptions()`: a stored skill absent from today's catalog must survive an
   * edit, and an intersection here would silently drop it on the next save. That is
   * the whole data risk in this control.
   */
  selectedSkills = toSignal(this.requestForm.controls.skills.valueChanges, {
    initialValue: this.requestForm.controls.skills.value,
  });

  /** The catalog value highlighted in the "add a skill" picker, or '' for none. */
  skillToAdd = signal<string>('');

  /**
   * Catalog entries not already on the request. This filters the OPTIONS, never the
   * model, so it cannot lose data — a skill already chosen simply stops being
   * offered a second time (same rule as my-profile's addableSkillOptions).
   */
  addableSkillOptions = computed(() => {
    const chosen = new Set(this.selectedSkills());
    return this.skillOptions().filter(s => !chosen.has(s.name));
  });

  /** True for a chip whose skill name is not (or no longer) in the /skills catalog. */
  isOrphanSkill(name: string): boolean {
    return !this.skillOptions().some(s => s.name === name);
  }

  addSkill(picker: HTMLSelectElement) {
    const name = this.skillToAdd();
    if (!name) return;
    const current = this.selectedSkills();
    if (!current.includes(name)) {
      this.requestForm.controls.skills.setValue([...current, name]);
    }
    // Reset the picker so the just-added entry (now filtered out of the options)
    // cannot leave the control showing a stale selection.
    this.skillToAdd.set('');
    picker.value = '';
  }

  removeSkill(name: string) {
    this.requestForm.controls.skills.setValue(this.selectedSkills().filter(s => s !== name));
  }

  trackRequest(req: ResourceRequest) {
    this.trackingRequestId.set(req.id);
  }

  closeTracking() {
    this.trackingRequestId.set(null);
  }

  // Time-phased allocation calendar (B1): the assignment whose per-day calendar is
  // open, or null when closed. Set from a tracking-modal row (the assignment id +
  // resource name are already in hand there). Closing returns to the still-open
  // tracking modal.
  calendarTarget = signal<{ assignmentId: string; resourceName: string } | null>(null);

  openCalendar(item: { assignment: Assignment; resource?: Resource }) {
    this.calendarTarget.set({
      assignmentId: item.assignment.id,
      resourceName: item.resource?.name ?? '',
    });
  }

  closeCalendar() {
    this.calendarTarget.set(null);
  }

  openCreateForm() {
    this.editingId.set(null);
    this.editingRole.set('');
    this.skillToAdd.set('');
    this.requestForm.reset({ requiredEffort: 0, skills: [] });
    this.formSubmitAttempted.set(false);
    this.confirmingFormDiscard.set(false);
    this.focusEditorOnRender = true;
    this.showForm.set(true);
  }

  openEditForm(req: ResourceRequest) {
    this.editingId.set(req.id);
    this.editingRole.set(req.requiredRole ?? '');
    this.skillToAdd.set('');
    // `skills` is patched below and `selectedSkills` reads the control, so the stored
    // array — orphan values included — is what the chips render and what saves.
    this.requestForm.patchValue({
      name: req.name,
      requiredRole: req.requiredRole,
      requiredEffort: req.requiredEffort,
      skills: [...(req.skills ?? [])],
      description: req.description || '',
      startDate: req.startDate || '',
      endDate: req.endDate || ''
    });
    this.requestForm.markAsPristine();
    this.formSubmitAttempted.set(false);
    this.confirmingFormDiscard.set(false);
    this.focusEditorOnRender = true;
    this.showForm.set(true);
  }

  closeForm(discard = false) {
    if (this.savingRequest()) return;
    if (!discard && this.requestForm.dirty) {
      this.confirmingFormDiscard.set(true);
      return;
    }
    this.showForm.set(false);
    this.editingId.set(null);
    this.editingRole.set('');
    this.formSubmitAttempted.set(false);
    this.confirmingFormDiscard.set(false);
    this.requestForm.reset();
  }

  showFieldError(controlName: 'name' | 'requiredRole' | 'requiredEffort' | 'endDate'): boolean {
    const control = this.requestForm.controls[controlName];
    return control.invalid && (control.touched || this.formSubmitAttempted());
  }

  saveRequest() {
    this.formSubmitAttempted.set(true);
    if (this.requestForm.invalid) {
      this.requestForm.markAllAsTouched();
      this.focusInvalidVersion.update(version => version + 1);
      return;
    }
    if (!this.savingRequest()) {
      this.savingRequest.set(true);
      const val = this.requestForm.value;
      const reqData: Partial<ResourceRequest> = {
        name: val.name || '',
        requiredRole: val.requiredRole || '',
        requiredEffort: val.requiredEffort || 0,
        // Multi-select already yields the selected skill NAMES; preserve any orphan
        // values the user kept (disabled options aren't auto-removed on save).
        skills: val.skills ?? [],
        description: val.description || '',
        startDate: val.startDate || '',
        endDate: val.endDate || '',
        requesterId: this.currentUserId
      };

      if (this.editingId()) {
        this.api.updateRequest(this.editingId()!, reqData).subscribe({
          next: () => {
            this.savingRequest.set(false);
            this.res.reload();
            this.closeForm(true);
          },
          error: () => this.savingRequest.set(false),
        });
      } else {
        this.api.createRequest(reqData).subscribe({
          next: () => {
            this.savingRequest.set(false);
            this.res.reload();
            this.closeForm(true);
          },
          error: () => this.savingRequest.set(false),
        });
      }
    }
  }

  pendingTransition = signal<{ request: ResourceRequest; target: 'Published' | 'Withdrawn' } | null>(null);
  transitionPending = signal(false);

  transitionAssignmentCount = computed(() => {
    const transition = this.pendingTransition();
    return transition
      ? this.assignments().filter(assignment => assignment.requestId === transition.request.id).length
      : 0;
  });

  transitionRemainingEffort = computed(() => {
    const request = this.pendingTransition()?.request;
    return request ? Math.max(0, request.requiredEffort - (request.staffedEffort ?? 0)) : 0;
  });

  /** Publishing and withdrawing are consequential lifecycle changes, never row-level one-click actions. */
  askRequestTransition(request: ResourceRequest, target: 'Published' | 'Withdrawn'): void {
    if (this.transitionPending()) return;
    this.pendingTransition.set({ request, target });
  }

  cancelRequestTransition(): void {
    if (!this.transitionPending()) this.pendingTransition.set(null);
  }

  confirmRequestTransition(): void {
    const transition = this.pendingTransition();
    if (!transition || this.transitionPending()) return;
    this.transitionPending.set(true);
    this.api.updateRequest(transition.request.id, { status: transition.target }).subscribe({
      next: () => {
        this.transitionPending.set(false);
        this.pendingTransition.set(null);
        this.res.reload();
      },
      error: () => this.transitionPending.set(false),
    });
  }

  /**
   * The request awaiting confirmation. Holds the WHOLE record, not just an id: the
   * dialog quotes its name, role and effort, and an id alone would force a second
   * lookup that a concurrent reload could miss.
   */
  pendingDelete = signal<ResourceRequest | null>(null);

  /** How many assignments already hang off the armed request — the consequence the
   *  dialog states. Derived from the same read the table uses, so it cannot drift. */
  pendingAssignmentCount = computed(() => {
    const pending = this.pendingDelete();
    if (!pending) return 0;
    return this.assignments().filter(a => a.requestId === pending.id).length;
  });

  /** First click: arm the confirm ONLY. No DELETE goes out from here. */
  askDeleteRequest(req: ResourceRequest) {
    this.pendingDelete.set(req);
  }

  cancelDeleteRequest() {
    this.pendingDelete.set(null);
  }

  /** The only place the DELETE is issued. */
  confirmDeleteRequest() {
    const req = this.pendingDelete();
    if (!req) return;
    // Cleared BEFORE the request so a double-click on the confirm control cannot
    // fire two DELETEs for the same row.
    this.pendingDelete.set(null);
    this.api.deleteRequest(req.id).subscribe(() => {
      this.res.reload();
    });
  }

  getStaffingPercentage(req: ResourceRequest): number {
    if (!req.requiredEffort) return 0;
    const staffed = req.staffedEffort || 0;
    return Math.min(100, Math.round((staffed / req.requiredEffort) * 100));
  }

  /**
   * PLANNED staffing % (staffedEffortPlanned = requested + allocated), capped at
   * 100. Falls back to the confirmed effort when staffedEffortPlanned is absent,
   * so the planned overlay then equals confirmed and simply doesn't render.
   */
  getPlannedStaffingPercentage(req: ResourceRequest): number {
    if (!req.requiredEffort) return 0;
    const planned = req.staffedEffortPlanned ?? req.staffedEffort ?? 0;
    return Math.min(100, Math.round((planned / req.requiredEffort) * 100));
  }

  /** Accessible description of the two-value (confirmed + planned) staffing bar. */
  staffingBarLabel(req: ResourceRequest): string {
    const confirmed = req.staffedEffort ?? 0;
    const planned = req.staffedEffortPlanned ?? confirmed;
    const base = `${confirmed}h confirmed of ${req.requiredEffort}h`;
    return planned > confirmed ? `${base}; ${planned}h planned (pending approval)` : base;
  }

  /** Diagonal hatch marking the planned-but-not-yet-confirmed portion of the bar. */
  protected readonly plannedStripe =
    'repeating-linear-gradient(45deg, var(--color-caution) 0 3px, transparent 3px 6px)';

  /** command-status tone modifier for an assignment's allocation status. */
  assignmentStatusClass(status: Assignment['status']): string {
    switch (status) {
      case 'Allocated':
        return 'green';
      case 'Requested':
        return 'amber';
      case 'Rejected':
        return 'red';
      case 'Draft':
      default:
        return 'neutral';
    }
  }

  /** command-chip tone modifier for a request's lifecycle status. */
  statusChipTone(status: ResourceRequest['status']): string {
    switch (status) {
      case 'Published':
      case 'Fulfilled':
        return 'is-positive';
      case 'Open':
        return 'is-info';
      case 'Withdrawn':
        return 'is-caution';
      case 'Not Published':
      default:
        return 'is-neutral';
    }
  }
}
