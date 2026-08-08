/**
 * The human-typeable resource code (RPT gap register, row 10).
 *
 * WHY THIS EXISTS. A resource is identified internally by a UUID v4
 * (`newEntityId`), which is correct for a primary key and useless for a person:
 * nobody dictates a UUID over the phone, types one into a search box, or
 * recognises one on a printed plan. Lutech's RPT gives every resource a short
 * code built from the name, and a planner uses it constantly. This module is
 * that convention, and ONLY that convention — the id is untouched, because it is
 * a foreign key in a dozen tables and changing it would be a migration of the
 * whole schema to buy a nicer string.
 *
 * TWO SHAPES, AND `kind` DECIDES WHICH.
 *
 *   internal   ARMJUL000001   3 letters of surname + 3 of given name + a
 *                             6-digit sequence, RPT's own format (its example
 *                             is `ROMSAL000002` for a second Romano Salvatore).
 *
 *   dummy      ZZ - Dummy - Engineering - Senior Developer
 *   subco      ZZ - Subco - Engineering - Senior Developer
 *                             A DESCRIPTION, not a name, because these rows do
 *                             not identify a person. A dummy is unfilled demand
 *                             and a subco row is vendor capacity; running either
 *                             through the person format produces a code that
 *                             LOOKS like a person and is not — which is worse
 *                             than having no code, because a planner would trust
 *                             it. RPT prints the same shape
 *                             (`ZZ - Dummy - SAP - Associate PMO`), and row 29
 *                             prefixes it with the RES number once hiring gives
 *                             the placeholder a real requisition.
 *
 * This is the one judgement call in the module. It follows how the rest of the
 * codebase already treats these rows — the bench splits internal / subco /
 * dummy, and `resource-kind.util.ts` asks about capacity rather than personhood.
 * If a NAMED subcontractor is ever modelled (a real person employed through a
 * vendor), they belong on the `internal` shape with a `vendorId`, and this rule
 * is where to revisit that.
 *
 * PURE. No I/O, no clock, no randomness: the sequence is resolved against the
 * codes the caller already holds, so the same inputs always give the same code
 * and the server can hold a lock around read-derive-write.
 */

/** How many letters of each name part the prefix carries. RPT's format. */
export const NAME_PART_LENGTH = 3;

/** Digits in the disambiguating sequence. RPT's format (`ROMSAL` + `000002`). */
export const SEQUENCE_LENGTH = 6;

/**
 * Filler for a name part shorter than {@link NAME_PART_LENGTH}.
 *
 * 'X' rather than a space or a digit: the code must stay a single typeable
 * token, and a padded position has to be visibly padding. `Li Wu` becomes
 * `WUXLIX000001`, which is odd-looking and unambiguous — where `WU LI ` would
 * silently lose its shape the first time something trimmed it.
 */
export const NAME_PAD_CHAR = 'X';

/** Placeholder-code marker, from RPT's own `ZZ - Dummy - …` form. */
export const PLACEHOLDER_MARKER = 'ZZ';

/** The separator RPT uses between the parts of a placeholder code. */
export const PLACEHOLDER_SEPARATOR = ' - ';

/** The subset of a resource this module needs. Deliberately not `Resource`. */
export interface ResourceCodeSubject {
  name: string;
  /** Absent reads as `internal` — the same safe default the rest of the app uses. */
  kind?: 'internal' | 'dummy' | 'subco';
  /** Practice / capability the placeholder belongs to. */
  organization?: string;
  /** Job role, used as the last part of a placeholder code. */
  role?: string;
}

/**
 * Strip diacritics and anything that is not A–Z, then upper-case.
 *
 * NFD + combining-mark removal, so `Ferrarì` and `Ferrari` produce the SAME
 * three letters. A code that changes because someone typed an accent is a code
 * that cannot be looked up.
 */
function lettersOnly(part: string): string {
  return part
    .normalize('NFD')
    // The combining-mark block, written as escapes ON PURPOSE: literal combining
    // characters in source are invisible in a diff and are exactly the kind of
    // byte an editor silently normalises away.
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/** Exactly {@link NAME_PART_LENGTH} characters: truncated, or padded with X. */
function fixedWidth(part: string): string {
  return lettersOnly(part).slice(0, NAME_PART_LENGTH).padEnd(NAME_PART_LENGTH, NAME_PAD_CHAR);
}

/**
 * The 6-letter prefix of a person's code: surname first, then given name.
 *
 * Given name is the FIRST token and surname the LAST, matching how `Resource.name`
 * is stored throughout this codebase (`'Julie Armstrong'`). A single-token name
 * uses that token for both halves rather than failing — `Cher` becomes
 * `CHECHE`, which is stable and searchable, where an error would leave a
 * resource with no code at all.
 *
 * Tokens that carry no letters at all (an em dash, a bullet) are dropped before
 * the first/last pick, so `Anna — Rossi` is `ROSANN`, not `XXXANN`.
 */
export function personCodePrefix(name: string): string {
  const tokens = name.split(/\s+/).map(lettersOnly).filter(t => t.length > 0);
  if (tokens.length === 0) return NAME_PAD_CHAR.repeat(NAME_PART_LENGTH * 2);
  const given = tokens[0];
  const surname = tokens[tokens.length - 1];
  return fixedWidth(surname) + fixedWidth(given);
}

/** `000001`-style sequence, zero-padded to {@link SEQUENCE_LENGTH}. */
function formatSequence(n: number): string {
  return String(n).padStart(SEQUENCE_LENGTH, '0');
}

/**
 * The highest sequence already used under `prefix`, or 0 when it is free.
 *
 * Reads ONLY codes that match the person shape for this exact prefix, so a
 * placeholder code (which contains spaces and dashes) can never be mistaken for
 * a sequence and push the counter somewhere absurd.
 */
function highestSequenceFor(prefix: string, taken: Iterable<string>): number {
  const pattern = new RegExp(`^${prefix}(\\d{${SEQUENCE_LENGTH}})$`);
  let highest = 0;
  for (const code of taken) {
    const m = pattern.exec(code);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest;
}

/**
 * The placeholder code for a dummy or subco row.
 *
 * `ZZ - Dummy - <practice> - <role>`. Missing parts are dropped rather than
 * rendered empty, so a dummy with no organization reads
 * `ZZ - Dummy - Senior Developer` instead of `ZZ - Dummy -  - Senior Developer`.
 */
export function placeholderCode(subject: ResourceCodeSubject): string {
  const kindLabel = subject.kind === 'subco' ? 'Subco' : 'Dummy';
  const parts = [PLACEHOLDER_MARKER, kindLabel, subject.organization, subject.role]
    .map(p => (p ?? '').trim())
    .filter(p => p.length > 0);
  return parts.join(PLACEHOLDER_SEPARATOR);
}

/**
 * The code for `subject`, unique against `taken`.
 *
 * `taken` is every code already in use — the caller passes the whole set, and
 * the server holds a lock around fetching it and writing the result, because
 * two concurrent creates that both read "nothing under ARMJUL" would otherwise
 * both mint `ARMJUL000001`.
 *
 * A placeholder code carries no sequence (RPT's does not either): several
 * dummies for the same practice and role legitimately share a description, and
 * disambiguating them is what the id is for. Uniqueness is therefore enforced
 * on the PERSON shape only — see `resourceCodeIsUnique`.
 */
export function nextResourceCode(subject: ResourceCodeSubject, taken: Iterable<string>): string {
  if (subject.kind === 'dummy' || subject.kind === 'subco') return placeholderCode(subject);
  const prefix = personCodePrefix(subject.name);
  return prefix + formatSequence(highestSequenceFor(prefix, taken) + 1);
}

/** True when `code` has the person shape (6 letters + a 6-digit sequence). */
export function isPersonCode(code: string): boolean {
  return new RegExp(`^[A-Z]{${NAME_PART_LENGTH * 2}}\\d{${SEQUENCE_LENGTH}}$`).test(code);
}

/**
 * May `code` be assigned, given the codes already in use?
 *
 * Person codes must be unique; placeholder codes need not be, and the doc
 * comment on {@link nextResourceCode} says why. Returning a boolean rather than
 * throwing keeps this usable both as a guard on create and as a validation on a
 * client-supplied correction.
 */
export function resourceCodeIsUnique(code: string, taken: Iterable<string>): boolean {
  if (!isPersonCode(code)) return true;
  for (const existing of taken) if (existing === code) return false;
  return true;
}

/**
 * Does this resource match a typed code fragment?
 *
 * Case-insensitive substring, so a planner who remembers `ARMJUL` finds
 * `ARMJUL000001` and one who remembers only the sequence still finds it. Used by
 * the `/resources?q=` search alongside the name/role/organization/location match
 * it already had.
 */
export function codeMatches(code: string | undefined, query: string): boolean {
  if (code === undefined) return false;
  const q = query.trim().toUpperCase();
  return q.length > 0 && code.toUpperCase().includes(q);
}
