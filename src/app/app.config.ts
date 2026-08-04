import { ApplicationConfig, ErrorHandler, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions, withInMemoryScrolling, withNavigationErrorHandler, TitleStrategy } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideClientHydration, withEventReplay, withHttpTransferCacheOptions, withIncrementalHydration } from '@angular/platform-browser';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { routes } from './app.routes';
import { API_BASE_URL } from './services/api-config';
import { AppTitleStrategy } from './services/title-strategy';
import { errorInterceptor } from './interceptors/error.interceptor';
import { authTokenInterceptor } from './interceptors/auth-token.interceptor';
import { GlobalErrorHandler } from './services/global-error-handler';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions(),
      // Reset the viewport to the top on each navigation (covers the window-scroll
      // case on smaller viewports; the inner <main> pane is reset in AppComponent).
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
      withNavigationErrorHandler(error => inject(GlobalErrorHandler).handleNavigationError(error)),
    ),
    provideHttpClient(withFetch(), withInterceptors([authTokenInterceptor, errorInterceptor])),
    provideClientHydration(withEventReplay(), withIncrementalHydration(), withHttpTransferCacheOptions({ includePostRequests: false })),
    provideOAuthClient(),
    { provide: API_BASE_URL, useValue: '/api' },
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    GlobalErrorHandler,
    { provide: ErrorHandler, useExisting: GlobalErrorHandler },
  ]
};
