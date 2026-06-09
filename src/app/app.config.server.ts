import {ApplicationConfig, mergeApplicationConfig} from '@angular/core';
import {provideServerRendering, withRoutes} from '@angular/ssr';
import {appConfig} from './app.config';
import {serverRoutes} from './app.routes.server';
import {API_BASE_URL} from './services/api-config';

const serverApiBaseUrl = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:3000/api';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    {provide: API_BASE_URL, useValue: serverApiBaseUrl},
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
