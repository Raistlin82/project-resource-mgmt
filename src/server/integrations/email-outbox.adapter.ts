/**
 * Notification seam — "LocalMailOutbox" (RPT gap register, row 43).
 *
 * RPT emails the responsible people when a dummy, a subcontractor row or a
 * Basket engagement is created, and tells an approver when something is waiting
 * on them. We have only in-app toasts, which reach exactly the person who is
 * already looking at the screen.
 *
 * This builds the MESSAGE and stops there. No SMTP, no provider SDK, no
 * credentials, no queue drain (`connected: false`, `mode: 'local-artifact'`).
 * `status` is typed `'Prepared'` with no other member, so a future connected
 * implementation cannot mark something 'Sent' while still claiming this type.
 *
 * RECIPIENTS ARE RESOLVED BY THE CALLER, deliberately. Turning "the responsible
 * people" into addresses means reading the org tree, the approval steps and the
 * role table — a server concern with real RBAC in it. An adapter that did it
 * would need repository access, would stop being pure, and would put an
 * authorization decision inside a formatter. It receives `to` already resolved.
 *
 * Pure in the same sense as its siblings: no clock (`preparedAt` is supplied),
 * no id (persistence assigns it), no mutation of the input.
 */

import type {
  IntegrationDescriptor,
  NotificationAdapter,
  NotificationEvent,
  NotificationInput,
  OutboundMessage,
} from './types';

export type {
  NotificationAdapter,
  NotificationEvent,
  NotificationInput,
  OutboundMessage,
} from './types';

/**
 * Subject line per event, as a function of the thing the message is about.
 *
 * A table rather than a switch inside the builder, because "which events do we
 * notify on" is a product question somebody will want to read off one screen —
 * and because an event with no entry then fails loudly instead of rendering an
 * empty subject.
 */
const SUBJECT: Readonly<Record<NotificationEvent, (name: string) => string>> = {
  'dummy-created': name => `New dummy placeholder: ${name}`,
  'subco-created': name => `New subcontractor capacity: ${name}`,
  'basket-engagement-created': name => `New non-billable engagement: ${name}`,
  'approval-awaiting': name => `Approval waiting on you: ${name}`,
};

/** The first line of the body: what happened, in a sentence. */
const OPENING: Readonly<Record<NotificationEvent, string>> = {
  'dummy-created':
    'A dummy placeholder has been created. It represents unfilled demand: it can be booked onto a plan, ' +
    'and it is not a person until a hiring requisition fills it.',
  'subco-created':
    'A subcontractor row has been created. It counts as delivery capacity and is billable, ' +
    'and it belongs to a vendor rather than to the organisation.',
  'basket-engagement-created':
    'A non-billable engagement has been created. It consumes cost and earns no customer revenue, ' +
    'so its cost lands in the fully-loaded portfolio margin and it is excluded from customer profitability.',
  'approval-awaiting':
    'An approval request is waiting for your decision.',
};

/**
 * The single concrete notification adapter: renders a message and parks it.
 */
export class LocalMailOutboxAdapter implements NotificationAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'email',
      key: 'local-mail-outbox',
      name: 'LocalMailOutbox',
      description:
        'Renders the notification that would be emailed when a dummy, a subcontractor row or a ' +
        'non-billable engagement is created, and when an approval is waiting on someone. Local ' +
        'artifact only: no SMTP, no provider, no credentials, and no Sent state — recipients are ' +
        'resolved by the caller, because turning roles into addresses is an authorization decision.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  buildMessage(input: NotificationInput): OutboundMessage {
    const subjectFor = SUBJECT[input.event];
    if (subjectFor === undefined) {
      // Loud, not empty: an unrendered event that still produces a message is
      // a notification that reaches somebody saying nothing.
      throw new Error(`no message template for event '${input.event}'`);
    }
    const recipients = input.to.map(a => a.trim()).filter(a => a !== '');
    if (recipients.length === 0) {
      // A message addressed to nobody is not a message. Refusing here is what
      // makes an unresolved recipient list visible at the point it happens,
      // rather than as a silently empty outbox somebody notices in a month.
      throw new Error(`message for '${input.event}' has no recipient`);
    }

    const lines = [OPENING[input.event], '', input.subjectName];
    if (input.detail !== undefined && input.detail.trim() !== '') lines.push(input.detail.trim());
    lines.push('', 'Sent by Delivery Control. This notification was prepared locally and not transmitted.');

    return {
      event: input.event,
      to: recipients,
      subject: subjectFor(input.subjectName),
      body: lines.join('\n'),
      preparedAt: input.preparedAt,
      status: 'Prepared',
    };
  }
}
