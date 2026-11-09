import type { AuditEvent } from '../eventLog/index.js';
import type { TallyReason } from './types.js';

/**
 * The `managementToken.refusalTally` recording one interval's count of management credentials that
 * could not be read or verified: their reason and the count, nothing else the credentials carried.
 *
 * @param reason why they were refused.
 * @param count how many the interval held.
 */
export const refusalTallyEvent = (
  reason: TallyReason,
  count: number,
): AuditEvent => ({
  data: { count, reason },
  severity: 'warning',
  type: 'managementToken.refusalTally',
});
