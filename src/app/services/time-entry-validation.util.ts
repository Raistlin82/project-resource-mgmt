import type { Assignment, ResourceRequest, TimeEntry } from './api.service';
import { exceedsDailyCapacity } from './calendar.util';

type AssignmentWindow = Pick<Assignment, 'startDate' | 'endDate'>;
type RequestWindow = Pick<ResourceRequest, 'startDate' | 'endDate'>;
type ExistingTimeEntry = Pick<TimeEntry, 'id' | 'date' | 'hours' | 'status'>;

export interface TimeEntryDateBounds {
  /** Latest available start across the assignment and its request. */
  minDate?: string;
  /** Earliest available end, always capped at the caller-provided local today. */
  maxDate: string;
  /** No calendar day can satisfy both the lower and upper bounds. */
  emptyIntersection: boolean;
}

export interface TimeEntryValidationInput {
  assignment: AssignmentWindow;
  request?: RequestWindow;
  date: unknown;
  hours: unknown;
  /** The caller owns the clock so browser and server can both use todayLocalIso(). */
  today: string;
  /** Already resolved through the domain's effective daily-cap policy. */
  dailyCap: number;
  /** Entries for the same resource; Rejected entries do not consume worked hours. */
  existingEntries: readonly ExistingTimeEntry[];
  /** Used by edit workflows so the row being replaced is not counted twice. */
  excludeEntryId?: string;
}

export interface TimeEntryValidationResult {
  valid: boolean;
  message: string;
  dateError: string;
  hoursError: string;
  bounds: TimeEntryDateBounds;
  existingHours: number;
  remainingHours: number;
}

/** Strict, real-calendar YYYY-MM-DD check. Lexical comparison is then safe. */
export function isValidIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validBoundary(value: string | undefined): string | undefined {
  return isValidIsoCalendarDate(value) ? value : undefined;
}

/**
 * The writable date interval is the intersection of every available assignment
 * and request boundary, further intersected with (-infinity, today].
 */
export function timeEntryDateBounds(
  assignment: AssignmentWindow,
  request: RequestWindow | undefined,
  today: string,
): TimeEntryDateBounds {
  const starts = [validBoundary(assignment.startDate), validBoundary(request?.startDate)]
    .filter((date): date is string => date !== undefined);
  const ends = [validBoundary(assignment.endDate), validBoundary(request?.endDate)]
    .filter((date): date is string => date !== undefined);
  const minDate = starts.length > 0 ? starts.sort().at(-1) : undefined;
  const maxDate = [today, ...ends].sort()[0];
  return {
    minDate,
    maxDate,
    emptyIntersection: minDate !== undefined && minDate > maxDate,
  };
}

function hoursLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function hoursAlreadyLogged(
  entries: readonly ExistingTimeEntry[],
  date: string,
  excludeEntryId?: string,
): number {
  return entries
    .filter(entry => entry.id !== excludeEntryId && entry.date === date && entry.status !== 'Rejected')
    .reduce((total, entry) => total + (Number.isFinite(entry.hours) ? entry.hours : 0), 0);
}

/** One validation result consumed unchanged by the browser form and API write. */
export function validateTimeEntry(input: TimeEntryValidationInput): TimeEntryValidationResult {
  const bounds = timeEntryDateBounds(input.assignment, input.request, input.today);
  let dateError = '';
  if (!isValidIsoCalendarDate(input.date)) {
    dateError = 'Enter a valid calendar date.';
  } else if (bounds.emptyIntersection) {
    dateError = 'The assignment and request date windows do not overlap.';
  } else if (input.date > input.today) {
    dateError = `Date cannot be later than today (${input.today}).`;
  } else if (bounds.minDate !== undefined && input.date < bounds.minDate) {
    dateError = `Date must be on or after ${bounds.minDate}.`;
  } else if (input.date > bounds.maxDate) {
    dateError = `Date must be on or before ${bounds.maxDate}.`;
  }

  const dateForTotal = isValidIsoCalendarDate(input.date) ? input.date : '';
  const existingHours = dateForTotal
    ? hoursAlreadyLogged(input.existingEntries, dateForTotal, input.excludeEntryId)
    : 0;
  const capAvailable = typeof input.dailyCap === 'number'
    && Number.isFinite(input.dailyCap)
    && input.dailyCap > 0;
  const remainingHours = capAvailable ? Math.max(0, input.dailyCap - existingHours) : 0;

  let hoursError = '';
  if (typeof input.hours !== 'number' || !Number.isFinite(input.hours) || input.hours <= 0) {
    hoursError = 'Enter finite hours greater than zero.';
  } else if (!capAvailable) {
    hoursError = 'The daily-hours policy is unavailable; try again later.';
  } else if (exceedsDailyCapacity(existingHours + input.hours, input.dailyCap)) {
    const dateLabel = dateForTotal || 'the selected date';
    hoursError = remainingHours > 0
      ? `${hoursLabel(existingHours)}h already logged on ${dateLabel}; enter at most ${hoursLabel(remainingHours)}h to stay within the ${hoursLabel(input.dailyCap)}h daily limit.`
      : `The ${hoursLabel(input.dailyCap)}h daily limit is already reached on ${dateLabel}.`;
  }

  const message = dateError || hoursError;
  return {
    valid: message === '',
    message,
    dateError,
    hoursError,
    bounds,
    existingHours,
    remainingHours,
  };
}
