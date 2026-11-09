import type { AuditEvent } from '../eventLog/index.js';
import type { LogoutTokenRefusal, LogoutTokenTallyReason } from './types.js';

/**
 * The `logoutToken.refusal` recording one logout token that verifies under the trusted issuer and is
 * refused anyway: its reason, the request's address, and as `refusedSubject` the subject its `sub`
 * names where that may be named, nothing else the token carried. It names no one signed out, since a
 * refused token signs no one out.
 *
 * @param refusal why it was refused, the request's address, and the subject it names, or `undefined`.
 */
export const logoutTokenRefusalEvent = ({
  reason,
  sourceIp,
  subject,
}: {
  reason: LogoutTokenRefusal;
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
 * The `logoutToken.refusalTally` recording one interval's count of logout tokens that could not be
 * verified under the trusted issuer: their reason and the count, naming no one.
 *
 * @param reason why they were refused.
 * @param count how many the interval held.
 */
export const logoutTokenRefusalTallyEvent = (
  reason: LogoutTokenTallyReason,
  count: number,
): AuditEvent => ({
  data: { count, reason },
  severity: 'warning',
  type: 'logoutToken.refusalTally',
});
