import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MultiSelectChipsComponent, type MultiSelectOption } from './multi-select-chips.component';

/**
 * UX register P2-19 — `<select multiple>` needs a Ctrl/Cmd-click to hold a second
 * value, which does not exist on touch: the field held exactly one entry and picking
 * a second silently REPLACED the first.
 *
 * The replacement primitive's real risk is not markup, it is DATA. The model is the
 * raw `string[]`; any intersection with the option list silently drops stored values,
 * and the two call sites store consequential ids (a resource organization's cost
 * centres feed cost allocation; a skill's catalogs decide where it appears). So the
 * cases below weigh the orphan contract, not the chips.
 */

const OPTIONS: MultiSelectOption[] = [
  { value: 'Java', label: 'Java' },
  { value: 'JavaScript', label: 'JavaScript' },
];

@Component({
  imports: [ReactiveFormsModule, MultiSelectChipsComponent],
  template: `
    <app-multi-select-chips [formControl]="control" inputId="hostField"
                            [options]="options()"
                            pickerLabel="Skill to add"
                            placeholder="Select a skill..."
                            emptyText="Nothing here yet." />
  `,
})
class HostComponent {
  readonly control = new FormControl<string[]>([], { nonNullable: true });
  readonly options = signal<MultiSelectOption[]>(OPTIONS);
}

function setup(initial: string[] = [], options: MultiSelectOption[] = OPTIONS) {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.options.set(options);
  fixture.componentInstance.control.setValue(initial);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

function host(fixture: ComponentFixture<HostComponent>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function picker(fixture: ComponentFixture<HostComponent>): HTMLSelectElement {
  return host(fixture).querySelector<HTMLSelectElement>('[data-test="chips-picker"]')!;
}

function optionValues(fixture: ComponentFixture<HostComponent>): string[] {
  return Array.from(picker(fixture).options).map(o => o.value);
}

function chipLabels(fixture: ComponentFixture<HostComponent>): string[] {
  return Array.from(host(fixture).querySelectorAll<HTMLElement>('[data-test="chip-label"]'))
    .map(c => c.textContent!.replace(/\s+/g, ' ').trim());
}

function choose(fixture: ComponentFixture<HostComponent>, value: string): void {
  const select = picker(fixture);
  select.value = value;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

function clickAdd(fixture: ComponentFixture<HostComponent>): void {
  host(fixture).querySelector<HTMLButtonElement>('[data-test="chips-add"]')!.click();
  fixture.detectChanges();
}

function clickRemove(fixture: ComponentFixture<HostComponent>, accessibleName: string): void {
  const button = host(fixture).querySelector<HTMLButtonElement>(`button[aria-label="${accessibleName}"]`);
  expect(button, `no remove control labelled "${accessibleName}"`).not.toBeNull();
  button!.click();
  fixture.detectChanges();
}

describe('MultiSelectChipsComponent — operable without Ctrl/Cmd', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders NO multiple-selection list box of its own', () => {
    // THE NEGATIVE ASSERTION THAT CANNOT DRIFT. Chips rendered alongside a surviving
    // <select multiple> satisfy every positive-only check, so the load-bearing claim
    // is the ABSENCE of the control that required Ctrl/Cmd.
    const { fixture } = setup(['Java']);
    expect(host(fixture).querySelector('select[multiple]')).toBeNull();
    // …and the picker that replaces it is genuinely single-selection.
    expect(picker(fixture).multiple).toBe(false);
  });

  it('MUST STILL add a chosen value with one tap on Add — the positive twin', () => {
    // Without this, deleting the control outright would pass the assertion above.
    const { fixture, component } = setup();

    choose(fixture, 'Java');
    clickAdd(fixture);

    expect(component.control.value).toStrictEqual(['Java']);
    expect(chipLabels(fixture)).toStrictEqual(['Java']);
  });

  it('adds a SECOND value without replacing the first — the whole point of the swap', () => {
    // The recorded touch failure verbatim: the second pick used to replace the first.
    const { fixture, component } = setup();

    choose(fixture, 'Java');
    clickAdd(fixture);
    choose(fixture, 'JavaScript');
    clickAdd(fixture);

    expect(component.control.value).toStrictEqual(['Java', 'JavaScript']);
    expect(chipLabels(fixture)).toStrictEqual(['Java', 'JavaScript']);
  });

  it('stops offering a value already chosen — that filters the OPTIONS, never the model', () => {
    const { fixture, component } = setup();
    expect(optionValues(fixture)).toStrictEqual(['', 'Java', 'JavaScript']);

    choose(fixture, 'Java');
    clickAdd(fixture);

    expect(optionValues(fixture)).toStrictEqual(['', 'JavaScript']);
    // ABSENCE TWIN: the option left the picker, the value did NOT leave the model.
    expect(component.control.value).toStrictEqual(['Java']);
    // The picker is also reset, so it cannot show a stale selection it no longer offers.
    expect(picker(fixture).value).toBe('');
  });

  it('does nothing when Add is pressed with no value chosen, and disables Add in that state', () => {
    const { fixture, component } = setup();
    const add = host(fixture).querySelector<HTMLButtonElement>('[data-test="chips-add"]')!;
    expect(add.disabled).toBe(true);

    clickAdd(fixture);
    expect(component.control.value).toStrictEqual([]);

    // The must-still-be-ALLOWED case: a control that refused everything would pass
    // the assertion above.
    choose(fixture, 'Java');
    expect(host(fixture).querySelector<HTMLButtonElement>('[data-test="chips-add"]')!.disabled).toBe(false);
  });
});

describe('MultiSelectChipsComponent — the ORPHAN-VALUE contract', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps a stored value absent from the options, and removing the known one leaves EXACTLY the orphan', () => {
    // THE DATA RISK, as recorded: control ['Java','LegacySkill'] against options
    // ['Java','JavaScript'] — removing 'Java' must leave EXACTLY ['LegacySkill'].
    // Any intersection with the option list (in writeValue, in a computed, or on the
    // way out) silently drops the orphan on the next save, and nothing on screen says
    // so. Asserted with toStrictEqual, not a length or a `toContain`: [] and
    // ['Java','LegacySkill'] are the two wrong answers this must separate.
    const { fixture, component } = setup(['Java', 'LegacySkill']);

    expect(component.control.value).toStrictEqual(['Java', 'LegacySkill']);
    // The orphan renders as a chip like any other — selectable state is the model, not
    // the catalog — and is flagged so the user knows why it is unusual.
    expect(chipLabels(fixture)).toStrictEqual(['Java', 'LegacySkill (not in catalog)']);

    clickRemove(fixture, 'Remove Java');

    expect(component.control.value).toStrictEqual(['LegacySkill']);
    expect(chipLabels(fixture)).toStrictEqual(['LegacySkill (not in catalog)']);
  });

  it('never offers the orphan back in the picker, and never re-adds it as a duplicate', () => {
    const { fixture, component } = setup(['LegacySkill']);
    // The orphan is not an option (it is not in the catalog) but it IS in the model.
    expect(optionValues(fixture)).toStrictEqual(['', 'Java', 'JavaScript']);
    expect(component.control.value).toStrictEqual(['LegacySkill']);

    choose(fixture, 'Java');
    clickAdd(fixture);
    expect(component.control.value).toStrictEqual(['LegacySkill', 'Java']);
  });

  it('the orphan survives the options arriving late — the async-catalog case', () => {
    // Both call sites load their catalog over HTTP, so the control renders with EMPTY
    // options first and every stored value looks like an orphan at that moment. If the
    // model were rebuilt from the options, the values would be gone before the catalog
    // ever landed.
    const { fixture, component } = setup(['Java', 'LegacySkill'], []);
    expect(chipLabels(fixture)).toStrictEqual(['Java (not in catalog)', 'LegacySkill (not in catalog)']);
    expect(component.control.value).toStrictEqual(['Java', 'LegacySkill']);

    component.options.set(OPTIONS);
    fixture.detectChanges();

    expect(component.control.value).toStrictEqual(['Java', 'LegacySkill']);
    expect(chipLabels(fixture)).toStrictEqual(['Java', 'LegacySkill (not in catalog)']);
  });

  it('gives every remove control its own aria-label naming the value', () => {
    const { fixture } = setup(['Java', 'LegacySkill']);
    const labels = Array.from(host(fixture).querySelectorAll<HTMLElement>('[data-test="chip"] button'))
      .map(b => b.getAttribute('aria-label'));
    // Not a presence check: an icon-only button with no accessible name is exactly
    // what this asserts against, and every chip must be distinguishable from the next.
    expect(labels).toStrictEqual(['Remove Java', 'Remove LegacySkill']);
  });

  it('gives each compact remove control a 24px minimum target', () => {
    const { fixture } = setup(['Java']);
    const button = host(fixture).querySelector<HTMLButtonElement>('[aria-label="Remove Java"]');
    expect(button?.className).toContain('size-6');
  });

  it('shows the empty copy only while nothing is selected', () => {
    const { fixture } = setup();
    expect(host(fixture).querySelector('[data-test="chips-empty"]')!.textContent!.trim()).toBe('Nothing here yet.');

    choose(fixture, 'Java');
    clickAdd(fixture);
    // ABSENCE TWIN: the placeholder must go away once there is something to show, or
    // the field reads as empty while holding a value.
    expect(host(fixture).querySelector('[data-test="chips-empty"]')).toBeNull();
  });
});

describe('MultiSelectChipsComponent — Reactive Forms wiring', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('follows a control reset in both directions', () => {
    const { fixture, component } = setup(['Java']);
    expect(chipLabels(fixture)).toStrictEqual(['Java']);

    component.control.setValue([]);
    fixture.detectChanges();
    expect(chipLabels(fixture)).toStrictEqual([]);

    component.control.setValue(['JavaScript', 'Ghost']);
    fixture.detectChanges();
    expect(chipLabels(fixture)).toStrictEqual(['JavaScript', 'Ghost (not in catalog)']);
  });

  it('puts inputId on the picker so the call site label still points at a real control', () => {
    // Both call sites keep their own <label for="…">; the primitive owns no label of
    // its own, so the id has to land on the focusable element.
    const { fixture } = setup();
    expect(picker(fixture).id).toBe('hostField');
    expect(picker(fixture).getAttribute('aria-label')).toBe('Skill to add');
  });

  it('disables the picker, Add and every remove control when the form control is disabled', () => {
    const { fixture, component } = setup(['Java']);
    component.control.disable();
    fixture.detectChanges();

    expect(picker(fixture).disabled).toBe(true);
    expect(host(fixture).querySelector<HTMLButtonElement>('[data-test="chips-add"]')!.disabled).toBe(true);
    expect(host(fixture).querySelector<HTMLButtonElement>('[data-test="chip"] button')!.disabled).toBe(true);

    // The must-still-be-ALLOWED half: re-enabling has to restore the control, or a
    // permanently dead field passes every assertion above.
    component.control.enable();
    fixture.detectChanges();
    expect(picker(fixture).disabled).toBe(false);
    expect(host(fixture).querySelector<HTMLButtonElement>('[data-test="chip"] button')!.disabled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Static scan — no `<select … multiple>` may return anywhere under src/app.
//
// The three sites P2-19 named are fixed in their own specs; this is the guard that
// stops a fourth being written. It is a source scan, not a DOM assertion: a new
// screen's <select multiple> would be caught here with no spec of its own.
// -----------------------------------------------------------------------------

const APP_DIR = resolve(process.cwd(), 'src/app');

function componentSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return componentSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * Comment bodies blanked out, newlines kept, so a `<select multiple>` DISCUSSED in
 * prose (this file's own class comment, and the "this used to be …" notes left at the
 * two fixed call sites) is not mistaken for one that ships — while reported line
 * numbers still match the real file.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** 1-indexed lines carrying a real `<select … multiple …>` open tag. */
function multipleSelectLines(src: string): number[] {
  const stripped = stripComments(src);
  const lines: number[] = [];
  for (const m of stripped.matchAll(/<select\b[^>]*>/g)) {
    if (!/\bmultiple\b/.test(m[0])) continue;
    lines.push(stripped.slice(0, m.index).split('\n').length);
  }
  return lines;
}

function multipleSelectSites(): string[] {
  return componentSources(APP_DIR).flatMap(file =>
    multipleSelectLines(readFileSync(file, 'utf8'))
      .map(line => `${relative(process.cwd(), file)}:${line}`));
}

describe('no <select multiple> survives under src/app (static scan)', () => {
  it('finds the shipped tag and skips the one described in a comment, so the scan is no tautology', () => {
    // THE NEGATIVE CONTROL, and the reason the sweep below means anything. Lines 3 and
    // 4 are manage-skills' and manage-resource-organizations' EXACT markup before this
    // fix; lines 1 and 6 are prose about it, which must NOT count, or the guard would
    // fire forever on its own explanation; line 5 is a single-selection select that
    // must stay untouched.
    const fixture = [
      '<!-- this used to be a <select multiple>, which needed Ctrl/Cmd -->',
      '<div>',
      '<select id="skillCatalogs" formControlName="catalogs" multiple class="command-select min-h-[120px]">',
      '<select id="orgCostCenters" formControlName="costCenters" multiple class="command-select min-h-[120px]">',
      '<select id="skillProficiencySet" formControlName="proficiencySetId" class="command-select">',
      '/** A doc comment naming <select multiple> as the thing replaced. */',
    ].join('\n');
    expect(multipleSelectLines(fixture)).toStrictEqual([3, 4]);
    // A multi-line open tag is reached too — attributes wrap in this codebase.
    expect(multipleSelectLines('<select\n  formControlName="x"\n  multiple>')).toStrictEqual([1]);
    // …and an empty source finds nothing, which is what the sweep asserts of every file.
    expect(multipleSelectLines('<div></div>')).toStrictEqual([]);
  });

  it('leaves none in the tree', () => {
    expect(multipleSelectSites()).toStrictEqual([]);
  });

  it('scans a real, non-empty set of files (guards against an empty sweep passing)', () => {
    // A walk that silently returned nothing would make the assertion above vacuous.
    const sources = componentSources(APP_DIR);
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some(f => f.endsWith('manage-skills.component.ts'))).toBe(true);
    expect(sources.some(f => f.endsWith('manage-resource-organizations.component.ts'))).toBe(true);
  });
});
