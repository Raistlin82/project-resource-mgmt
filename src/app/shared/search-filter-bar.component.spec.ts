import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SearchFilterBarComponent, type Facet } from './search-filter-bar.component';

const FACETS: Facet[] = [
  { id: 'kind', label: 'Kind', options: [{ value: 'internal', label: 'Internal' }, { value: 'subco', label: 'Subco' }], value: '' },
];

describe('SearchFilterBarComponent', () => {
  async function setup(query = '', facets: readonly Facet[] = FACETS) {
    await TestBed.configureTestingModule({
      imports: [SearchFilterBarComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchFilterBarComponent);
    fixture.componentRef.setInput('query', query);
    fixture.componentRef.setInput('facets', facets);
    fixture.detectChanges();
    return fixture;
  }

  it('emits queryChange when the text box changes', async () => {
    const fixture = await setup();
    let emitted = '';
    fixture.componentInstance.queryChange.subscribe(v => (emitted = v));
    const input = (fixture.nativeElement as HTMLElement).querySelector('input[data-test="filter-bar-query"]') as HTMLInputElement;
    input.value = 'Julie';
    input.dispatchEvent(new Event('input'));
    expect(emitted).toBe('Julie');
  });

  it('emits facetChange with the facet id and selected value', async () => {
    const fixture = await setup();
    let emitted: { id: string; value: string } | undefined;
    fixture.componentInstance.facetChange.subscribe(v => (emitted = v));
    const select = (fixture.nativeElement as HTMLElement).querySelector('select[data-test="filter-bar-facet-kind"]') as HTMLSelectElement;
    select.value = 'subco';
    select.dispatchEvent(new Event('change'));
    expect(emitted).toEqual({ id: 'kind', value: 'subco' });
  });

  it('renders one removable chip per active facet, none for an empty facet', async () => {
    const fixture = await setup('', [{ ...FACETS[0], value: 'subco' }]);
    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="filter-bar-chip"]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('Subco');
  });

  it('renders a query chip when query is non-empty', async () => {
    const fixture = await setup('Julie');
    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="filter-bar-chip"]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('Julie');
  });

  it('clearAll emits when the Clear all button is clicked, only rendered when at least one filter is active', async () => {
    const fixture = await setup('Julie');
    let cleared = false;
    fixture.componentInstance.clearAll.subscribe(() => (cleared = true));
    const btn = (fixture.nativeElement as HTMLElement).querySelector('[data-test="filter-bar-clear-all"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(cleared).toBe(true);
  });

  it('does NOT render the Clear all button when no filter is active', async () => {
    const fixture = await setup('');
    const btn = (fixture.nativeElement as HTMLElement).querySelector('[data-test="filter-bar-clear-all"]');
    expect(btn).toBeFalsy();
  });

  // --- Layout contract: the query never competes with the facets -------------
  //
  // jsdom does no layout, so these assert the STRUCTURE that made the bug
  // possible rather than the pixels. The bug: six items in one flex line, five
  // of them carrying width:100%, and a query input growing from a zero basis —
  // measured at 28px wide on /resources, i.e. present, focusable and unusable.

  it('puts the query OUTSIDE the facet container, so nothing shares its row', async () => {
    const fixture = await setup('', FACETS);
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('[data-test="filter-bar-query"]')!;
    const firstFacet = host.querySelector('[data-test^="filter-bar-facet-"]')!;
    expect(input).toBeTruthy();
    expect(firstFacet).toBeTruthy();
    // The claim: they are not siblings in one flex row any more.
    expect(firstFacet.parentElement!.contains(input)).toBe(false);
  });

  it('lays the facets out in a GRID, where width:100% is the right answer', async () => {
    const fixture = await setup('', FACETS);
    const host = fixture.nativeElement as HTMLElement;
    const container = host.querySelector('[data-test^="filter-bar-facet-"]')!.parentElement!;
    expect(container.className).toContain('grid');
  });

  it('renders NO facet container at all when there are no facets', async () => {
    // Four of the five consumers pass none. An empty grid would still occupy a
    // gap-sized strip under the query, on every one of those screens.
    const fixture = await setup('', []);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test^="filter-bar-facet-"]')).toBeNull();
    expect(host.querySelector('.grid')).toBeNull();
    expect(host.querySelector('[data-test="filter-bar-query"]')).toBeTruthy();
  });
});
