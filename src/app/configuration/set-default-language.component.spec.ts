import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { SetDefaultLanguageComponent } from './set-default-language.component';
import { ApiService, Language } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'it', name: 'Italian', isDefault: false },
];

async function render(setDefaultLanguage: ReturnType<typeof vi.fn> = vi.fn(() => of(undefined))) {
  const api = {
    getLanguages: vi.fn(() => of(LANGUAGES)),
    setDefaultLanguage,
  } as unknown as ApiService;
  const notifications = { show: vi.fn() } as unknown as NotificationService;
  TestBed.configureTestingModule({
    imports: [SetDefaultLanguageComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { authReady: signal(true), isAuthenticated: signal(true) } },
      { provide: NotificationService, useValue: notifications },
    ],
  });
  const fixture: ComponentFixture<SetDefaultLanguageComponent> = TestBed.createComponent(SetDefaultLanguageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, setDefaultLanguage, notifications };
}

describe('SetDefaultLanguageComponent', () => {
  it('requires a named confirmation before changing the default', async () => {
    const setDefaultLanguage = vi.fn(() => of(undefined));
    const { fixture } = await render(setDefaultLanguage);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('[aria-label="Set Italian (it) as default language"]')!.click();
    fixture.detectChanges();
    expect(setDefaultLanguage).not.toHaveBeenCalled();
    const dialog = host.querySelector<HTMLElement>('[data-test="language-confirm"]')!;
    expect(dialog.textContent).toContain('Italian');
    expect(dialog.textContent).toContain('(it)');
    expect(dialog.textContent).toContain('not translated automatically');

    Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Change default language'))!.click();
    expect(setDefaultLanguage).toHaveBeenCalledTimes(1);
    expect(setDefaultLanguage).toHaveBeenCalledWith('it');
  });

  it('blocks duplicate submits while the change is pending', async () => {
    const response = new Subject<void>();
    const setDefaultLanguage = vi.fn(() => response);
    const { fixture } = await render(setDefaultLanguage);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Set Italian (it) as default language"]')!.click();
    fixture.detectChanges();
    const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-test="language-confirm"] button'))
      .find(button => button.textContent?.includes('Change default language'))!;

    confirm.click();
    confirm.click();
    fixture.detectChanges();
    expect(setDefaultLanguage).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    response.next();
    response.complete();
  });

  it('keeps the dialog open with an explicit error when the change fails', async () => {
    const setDefaultLanguage = vi.fn(() => throwError(() => new Error('failed')));
    const { fixture } = await render(setDefaultLanguage);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Set Italian (it) as default language"]')!.click();
    fixture.detectChanges();
    Array.from(host.querySelectorAll<HTMLButtonElement>('[data-test="language-confirm"] button'))
      .find(button => button.textContent?.includes('Change default language'))!.click();
    fixture.detectChanges();

    expect(host.querySelector('[data-test="language-confirm"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be changed');
  });
});
