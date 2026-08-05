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
});
