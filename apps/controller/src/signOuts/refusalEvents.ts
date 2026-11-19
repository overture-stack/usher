import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { WindowClosing } from '../windowedRefusals/index.js';
import type { LogoutTokenRefusal, SwitchedOffLogoutReason, UnverifiedLogoutReason } from './types.js';

/**
 * The `logoutToken.refusal` recording one refused logout token: its reason, the request's address,
 * and as `refusedSubject` the subject its `sub` names where the token verified and that may be
 * named, nothing else the token carried. It names no one signed out, since a refused token signs no
 * one out.
 *
 * @param refusal why it was refused, the request's address, and the subject a verified token names,
 *   or `undefined`.
 */
export const logoutTokenRefusalEvent = ({
  reason,
  sourceIp,
  subject,
}: {
	reason: LogoutTokenRefusal | SwitchedOffLogoutReason | UnverifiedLogoutReason;
  sourceIp: string;
  subject: string | undefined;
}): AuditEvent => ({
  data: {
    reason,
    result: 'denied',
    ...(subject === undefined ? {} : { refusedSubject: subject }),
    sourceIp,
  },
  severity: 'warning',
  type: 'logoutToken.refusal',
});

/**
 * The `logoutToken.refusalTally` closing a window of refused logout tokens: its reason, its count,
 * the instants of its first and latest refusals, and as `windowId` the `logoutToken.refusal` that
 * opened it, where that event committed, naming no one.
 *
 * @param closing the window as it closed.
 */
export const logoutTokenRefusalTallyEvent = ({
  count,
  firstSeenAt,
  lastSeenAt,
  reason,
  windowId,
}: WindowClosing): AuditEvent => ({
  data: {
    count,
    firstSeenAt: eventInstant(firstSeenAt),
    lastSeenAt: eventInstant(lastSeenAt),
    reason,
    ...(windowId === undefined ? {} : { windowId }),
  },
  severity: 'warning',
  type: 'logoutToken.refusalTally',
});
