import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { NotificationService } from '../services/notification.service';
import { AuthService } from '../services/auth.service';

/**
 * Surfaces failed HTTP requests as global error notifications, then rethrows
 * so callers can still react. Replaces the previous silent-failure behaviour.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationService);
  const auth = inject(AuthService);
  const authenticatedReq = req.clone({
    setHeaders: {
      'X-User-Id': auth.userId(),
      'X-User-Role': auth.role(),
    },
  });
  return next(authenticatedReq).pipe(
    catchError((error: HttpErrorResponse) => {
      const serverMessage =
        error.error && typeof error.error === 'object' ? error.error.error : null;
      const message =
        serverMessage || error.message || `Request failed (${error.status})`;
      notifications.error(message);
      return throwError(() => error);
    }),
  );
};
