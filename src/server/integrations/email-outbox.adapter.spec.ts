import { LocalMailOutboxAdapter } from './email-outbox.adapter';
import type { NotificationEvent, NotificationInput } from './types';

const adapter = new LocalMailOutboxAdapter();

const BASE: NotificationInput = {
  event: 'dummy-created',
  to: ['rm@example.com'],
  preparedAt: '2026-08-08T09:00:00.000Z',
  subjectName: 'Dummy — Associate PMO',
};

const ALL_EVENTS: NotificationEvent[] = [
  'dummy-created',
  'subco-created',
  'basket-engagement-created',
  'approval-awaiting',
];

describe('LocalMailOutboxAdapter — self-description', () => {
  it('is an email adapter that is NOT connected', () => {
    const d = adapter.describe();
    expect(d.kind).toBe('email');
    expect(d.key).toBe('local-mail-outbox');
    expect(d.connected).toBe(false);
    expect(d.mode).toBe('local-artifact');
  });
});

describe('buildMessage — a rendered message that is never sent', () => {
  it('renders subject, body, recipients and the supplied timestamp', () => {
    const msg = adapter.buildMessage(BASE);
    expect(msg.subject).toBe('New dummy placeholder: Dummy — Associate PMO');
    expect(msg.to).toStrictEqual(['rm@example.com']);
    expect(msg.body).toContain('unfilled demand');
    expect(msg.body).toContain('Dummy — Associate PMO');
    expect(msg.preparedAt).toBe('2026-08-08T09:00:00.000Z');
  });

  it('is ALWAYS Prepared — there is no Sent state to reach', () => {
    for (const event of ALL_EVENTS) {
      expect(adapter.buildMessage({ ...BASE, event }).status, event).toBe('Prepared');
    }
  });

  it('says in the body that nothing was transmitted', () => {
    // Someone will read one of these in a log or a test fixture and wonder
    // whether it went out. The message answers that itself.
    expect(adapter.buildMessage(BASE).body).toMatch(/prepared locally and not transmitted/i);
  });

  it('renders EVERY declared event with a distinct, non-empty subject', () => {
    // A missing template must not produce a message that reaches somebody and
    // says nothing; distinctness catches a table where two events share a line.
    const subjects = ALL_EVENTS.map(event => adapter.buildMessage({ ...BASE, event }).subject);
    for (const s of subjects) expect(s.length).toBeGreaterThan(10);
    expect(new Set(subjects).size).toBe(ALL_EVENTS.length);
  });

  it('explains what a NON-BILLABLE engagement means, in the message itself', () => {
    // The recipient is the person who has to care about it. A subject line with
    // no explanation makes them go and look it up, which is how a notification
    // becomes noise.
    const msg = adapter.buildMessage({
      ...BASE,
      event: 'basket-engagement-created',
      subjectName: 'BASKET — Engineering Practice',
    });
    expect(msg.subject).toContain('non-billable engagement');
    expect(msg.body).toContain('earns no customer revenue');
    expect(msg.body).toContain('fully-loaded portfolio margin');
  });

  it('appends the optional detail line, and omits it cleanly when absent', () => {
    const withDetail = adapter.buildMessage({ ...BASE, detail: 'ZZ - Dummy - SAP - Associate PMO' });
    expect(withDetail.body).toContain('ZZ - Dummy - SAP - Associate PMO');

    const without = adapter.buildMessage(BASE);
    expect(without.body).not.toContain('undefined');
    // The pair: an always-appended blank line would pass the test above.
    expect(without.body.split('\n').filter(l => l.trim() === '').length)
      .toBeLessThan(withDetail.body.split('\n').filter(l => l.trim() === '').length + 1);
  });

  it('drops blank recipients rather than addressing an empty string', () => {
    const msg = adapter.buildMessage({ ...BASE, to: ['a@example.com', '  ', 'b@example.com'] });
    expect(msg.to).toStrictEqual(['a@example.com', 'b@example.com']);
  });

  it('REFUSES a message with no recipient at all', () => {
    // An unresolved recipient list has to be visible where it happens, not as a
    // silently empty outbox somebody notices in a month.
    expect(() => adapter.buildMessage({ ...BASE, to: [] })).toThrow(/no recipient/);
    expect(() => adapter.buildMessage({ ...BASE, to: ['', '   '] })).toThrow(/no recipient/);
  });

  it('REFUSES an event it has no template for', () => {
    expect(() => adapter.buildMessage({ ...BASE, event: 'invoice-issued' as never }))
      .toThrow(/no message template/);
  });

  it('never reads a clock and never mutates its input', () => {
    const input = { ...BASE, to: [...BASE.to] };
    const snapshot = JSON.stringify(input);
    const a = adapter.buildMessage(input);
    const b = adapter.buildMessage(input);
    expect(a).toStrictEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('leaves the id to the persistence layer', () => {
    expect(adapter.buildMessage(BASE).id).toBeUndefined();
  });
});
