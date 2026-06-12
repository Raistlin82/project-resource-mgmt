import { ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions, TitleStrategy } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideClientHydration, withEventReplay, withHttpTransferCacheOptions, withIncrementalHydration } from '@angular/platform-browser';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { routes } from './app.routes';
import { API_BASE_URL } from './services/api-config';
import { AppTitleStrategy } from './services/title-strategy';
import { errorInterceptor } from './interceptors/error.interceptor';
import { authTokenInterceptor } from './interceptors/auth-token.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideHttpClient(withFetch(), withInterceptors([authTokenInterceptor, errorInterceptor])),
    provideClientHydration(withEventReplay(), withIncrementalHydration(), withHttpTransferCacheOptions({ includePostRequests: false })),
    provideOAuthClient(),
    { provide: API_BASE_URL, useValue: '/api' },
    { provide: TitleStrategy, useClass: AppTitleStrategy },
  ]
};
