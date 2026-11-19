import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { WindowClosing } from '../windowedRefusals/index.js';

/**
 * The `managementToken.refusalTally` closing a window of refused management credentials: its
 * reason, its count, the instants of its first and latest refusals, and as `windowId` the
 * `managementToken.refusal` that opened it, where that event committed. Nothing a credential carried
 * is named.
 *
 * @param closing the window as it closed.
 */
export const refusalTallyEvent = ({ count, firstSeenAt, lastSeenAt, reason, windowId }: WindowClosing): AuditEvent => ({
	data: {
		count,
		firstSeenAt: eventInstant(firstSeenAt),
		lastSeenAt: eventInstant(lastSeenAt),
		reason,
		...(windowId === undefined ? {} : { windowId }),
	},
	severity: 'warning',
	type: 'managementToken.refusalTally',
});
