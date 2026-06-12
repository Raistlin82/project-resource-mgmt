import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

const APP_NAME = 'Delivery Control';

/**
 * Builds the document title from the active route's `title` value.
 * - With a route title:    "<title> · Delivery Control"
 * - Without a route title: "Delivery Control"
 *
 * Per-route `title:` values are added by a later task; this strategy
 * just needs to handle the present/absent cases. Works under SSR too.
 */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const routeTitle = this.buildTitle(snapshot);
    this.title.setTitle(routeTitle ? `${routeTitle} · ${APP_NAME}` : APP_NAME);
  }
}
