import { ErrorHandler, Injectable, inject } from '@angular/core';
import { NavigationError } from '@angular/router';
import { NotificationService } from './notification.service';

/**
 * Last-resort boundary for errors that escape component/resource handling.
 * Keep the user message stable and non-sensitive while preserving the original
 * error in the developer console for diagnosis.
 */
@Injectable({ providedIn: 'root' })
export class GlobalErrorHandler implements ErrorHandler {
  private readonly notifications = inject(NotificationService);

  handleError(error: unknown): void {
    this.report(
      error,
      'The page encountered an unexpected error. Try again or reload the page.',
    );
  }

  handleNavigationError(error: NavigationError): void {
    this.report(
      error.error ?? error,
      'This page could not be opened. Try again or return to the dashboard.',
    );
  }

  private report(error: unknown, message: string): void {
    console.error('[ui-error-boundary]', error);
    this.notifications.error(message);
  }
}
