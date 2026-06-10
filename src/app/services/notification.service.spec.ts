import { TestBed } from '@angular/core/testing';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    service = TestBed.inject(NotificationService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses success toasts after the timeout', () => {
    service.show('Saved', 'success');
    expect(service.items().length).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(service.items().length).toBe(0);
  });

  it('auto-dismisses info toasts after the timeout', () => {
    service.show('Heads up', 'info');
    expect(service.items().length).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(service.items().length).toBe(0);
  });

  it('keeps error toasts sticky (no auto-dismiss)', () => {
    service.error('Request failed');
    expect(service.items().length).toBe(1);

    // Errors must not scroll away unseen: still present long after the timeout.
    vi.advanceTimersByTime(60000);
    expect(service.items().length).toBe(1);
    expect(service.items()[0].type).toBe('error');
  });

  it('does not let repeated errors auto-clear, so a flaky backend keeps them visible', () => {
    service.error('fail 1');
    service.error('fail 2');
    service.error('fail 3');

    vi.advanceTimersByTime(60000);
    expect(service.items().length).toBe(3);
  });

  it('dismiss removes a specific toast by id without disturbing others', () => {
    service.error('sticky error');
    service.show('transient', 'info');
    const errorId = service.items()[0].id;

    service.dismiss(errorId);
    expect(service.items().map(t => t.message)).toEqual(['transient']);

    // The remaining info toast still auto-dismisses on its own timer.
    vi.advanceTimersByTime(5000);
    expect(service.items().length).toBe(0);
  });
});
