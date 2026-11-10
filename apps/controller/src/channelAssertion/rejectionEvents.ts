import type { AuditEvent } from '../eventLog/index.js';
import type {
  UnverifiedRejectionReason,
  VerifiedRejectionReason,
} from './types.js';

/**
 * The `channelAssertion.rejection` recording one refusal of an assertion that verified under its
 * application's key: `denied`, its reason, that application and the request's address, nothing else
 * the assertion carried.
 *
 * @param rejection why it was refused, the application whose key it verified under, and the
 *   request's address.
 */
export const rejectionEvent = ({
  applicationId,
  reason,
  sourceIp,
}: {
  applicationId: string;
  reason: VerifiedRejectionReason;
  sourceIp: string;
}): AuditEvent => ({
  data: { applicationId, reason, result: 'denied', sourceIp },
  severity: 'warning',
  type: 'channelAssertion.rejection',
});

/**
 * The `channelAssertion.rejectionTally` recording one interval's count of refusals of assertions that
 * could not be verified: their reason, the count, and the application they name only while it is
 * registered.
 *
 * @param reason why they were refused.
 * @param applicationId the registered application they name, or `undefined` for none.
 * @param count how many the interval held.
 */
export const rejectionTallyEvent = (
  reason: UnverifiedRejectionReason,
  applicationId: string | undefined,
  count: number,
): AuditEvent => ({
  data: {
    ...(applicationId === undefined ? {} : { applicationId }),
    count,
    reason,
  },
  severity: 'warning',
  type: 'channelAssertion.rejectionTally',
});
