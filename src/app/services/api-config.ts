import { InjectionToken } from '@angular/core';

/** Base URL for the API. Provided per-platform (browser vs server) via DI. */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL');
