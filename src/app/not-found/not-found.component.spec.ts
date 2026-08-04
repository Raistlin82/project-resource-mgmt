import { RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotFoundComponent } from './not-found.component';

describe('NotFoundComponent', () => {
  it('marks the SSR response as HTTP 404', () => {
    const responseInit: ResponseInit = {};
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: RESPONSE_INIT, useValue: responseInit },
      ],
    });

    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();

    expect(responseInit.status).toBe(404);
  });
});
