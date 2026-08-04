import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotificationService } from './notification.service';
import { GlobalErrorHandler } from './global-error-handler';

describe('GlobalErrorHandler', () => {
  it('turns an unexpected runtime error into a recoverable user-facing notification', () => {
    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        { provide: ErrorHandler, useExisting: GlobalErrorHandler },
      ],
    });
    const handler = TestBed.inject(ErrorHandler);
    const notifications = TestBed.inject(NotificationService);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handler.handleError(new Error('render failed'));

    expect(notifications.items()).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('reload') }),
    ]);
    expect(consoleSpy).toHaveBeenCalled();
  });
});
