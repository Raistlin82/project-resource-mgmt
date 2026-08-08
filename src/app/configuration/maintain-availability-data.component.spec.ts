import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { MaintainAvailabilityDataComponent } from './maintain-availability-data.component';
import { ApiService, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';

describe('MaintainAvailabilityDataComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('discloses that CSV import is unavailable without opening a file picker', async () => {
    TestBed.configureTestingModule({
      imports: [MaintainAvailabilityDataComponent],
      providers: [
        { provide: ApiService, useValue: { getResources: () => of([] as Resource[]) } },
        { provide: AuthService, useValue: { authReady: signal(true), isAuthenticated: signal(true) } },
      ],
    });
    const fixture = TestBed.createComponent(MaintainAvailabilityDataComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('CSV import coming soon'))!;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('availabilityImportStatus');
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector('#availabilityImportStatus')?.textContent).toContain('unsupported flow');
  });
});
