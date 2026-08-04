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

  it('auto-dismisses error toasts too, but only after a longer timeout', () => {
    service.error('Request failed');
    expect(service.items().length).toBe(1);

    // Not gone at the non-error timeout — an error gets more time to be read.
    vi.advanceTimersByTime(5000);
    expect(service.items().length).toBe(1);
    expect(service.items()[0].type).toBe('error');

    // But it is still finite: gone by the error timeout.
    vi.advanceTimersByTime(7000);
    expect(service.items().length).toBe(0);
  });

  it('success() shows an auto-dismissing success toast', () => {
    service.success('Saved');
    expect(service.items().length).toBe(1);
    expect(service.items()[0].type).toBe('success');

    vi.advanceTimersByTime(5000);
    expect(service.items().length).toBe(0);
  });

  it('auto-clears repeated errors once each has had its full read time', () => {
    service.error('fail 1');
    service.error('fail 2');
    service.error('fail 3');

    vi.advanceTimersByTime(12000);
    expect(service.items().length).toBe(0);
  });

  it('deduplicates an identical notification instead of stacking it again', () => {
    service.error('Request failed');
    service.error('Request failed');

    expect(service.items().map(item => item.message)).toEqual(['Request failed']);
  });

  it('caps the visible stack and evicts the oldest notification', () => {
    for (let index = 1; index <= 6; index += 1) {
      service.error(`failure ${index}`);
    }

    expect(service.items()).toHaveLength(5);
    expect(service.items().map(item => item.message)).toEqual([
      'failure 2',
      'failure 3',
      'failure 4',
      'failure 5',
      'failure 6',
    ]);
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
