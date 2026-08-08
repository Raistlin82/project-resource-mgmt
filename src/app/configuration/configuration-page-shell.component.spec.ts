import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfigurationPageShellComponent } from './configuration-page-shell.component';

@Component({
  imports: [ConfigurationPageShellComponent],
  template: `
    <app-configuration-page-shell title="Catalog" subtitle="Maintain reference data.">
      <button configuration-actions type="button">Create</button>
      <section>Records</section>
    </app-configuration-page-shell>
  `,
})
class HostComponent {}

describe('ConfigurationPageShellComponent', () => {
  it('provides one configuration h1 and projects actions separately from page content', () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toContain('Catalog');
    expect(host.querySelector('header button')?.textContent).toContain('Create');
    expect(host.querySelector('section')?.textContent).toContain('Records');
  });
});
