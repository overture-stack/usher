import type { AuditEvent } from '../eventLog/index.js';

/** The interval exchanges refused over their share are counted over, in milliseconds of the configured clock. */
export const SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS = 60_000;

/** The whole seconds an exchange refused over its share is told to wait, in `Retry-After`. */
export const SHARE_EXCEEDED_RETRY_AFTER_SECONDS = 1;

/**
 * The `admission.shareExceededTally` recording one interval's count of an application's exchanges
 * refused on one instance, each over its share while the exchange pool was contended: the
 * application and the count, at warning.
 *
 * @param applicationId the application whose exchanges were refused.
 * @param count how many the interval held.
 */
export const shareExceededTallyEvent = (
  applicationId: string,
  count: number,
): AuditEvent => ({
  data: { applicationId, count },
  severity: 'warning',
  type: 'admission.shareExceededTally',
});
