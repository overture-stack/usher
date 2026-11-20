import { eventInstant, type JsonValue } from '../eventLog/index.js';
import { isLive } from '../resourceStanding/index.js';
import type { ViewedGrant } from './types.js';

/** A grant's state, as an answer names it. */
export type GrantState = 'accepted' | 'expired' | 'pending' | 'rejected' | 'revoked';

const instantOrNull = (instant: Date | null): string | null =>
	instant === null ? null : eventInstant(instant.getTime());

/**
 * A grant's state on the configured clock: `revoked` once revoked; `expired` once its expiry has
 * passed or a grant on its terms has replaced it; otherwise its holder's latest decision,
 * `accepted` or `rejected`, and `pending` while there is none.
 *
 * @param grant the grant's ends and its latest decision.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const grantStateOf = (
	{ decision, endedAt, expiresAt, revokedAt }: Pick<ViewedGrant, 'decision' | 'endedAt' | 'expiresAt' | 'revokedAt'>,
	now: number,
): GrantState => {
	if (revokedAt !== null) {
		return 'revoked';
	}
	if (!isLive({ endedAt, expiresAt, revokedAt }, now)) {
		return 'expired';
	}
	return decision?.decision ?? 'pending';
};

/**
 * A grant as an answer shows it, in the answer to a principal's own act: `kind` `grant`, beside a
 * grant request's `grantRequest`; people by subject, the
 * holder as one with an account, and no address, since none is read; the resource by externalId;
 * each instant in UTC with `Z`; and its state on the configured clock. Whether a grant on its terms
 * replaced it is never shown apart from its expiry.
 *
 * @param grant the grant.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const grantView = (grant: ViewedGrant, now: number): JsonValue => {
	const {
		category,
		decision,
		expiresAt,
		grantedAt,
		granterSubject,
		holderSubject,
		id,
		resource,
		revokedAt,
		revokerSubject,
		role,
		selfGrant,
	} = grant;
	return {
		category,
		decision:
			decision === null
				? null
				: {
						capabilities: decision.capabilities,
						decidedAt: eventInstant(decision.decidedAt.getTime()),
						decision: decision.decision,
					},
		expiresAt: instantOrNull(expiresAt),
		grantedAt: eventInstant(grantedAt.getTime()),
		grantedBy: { subject: granterSubject },
		holder: { hasAccount: true, subject: holderSubject },
		id,
		kind: 'grant',
		resource,
		revokedAt: instantOrNull(revokedAt),
		revokedBy: revokerSubject === null ? null : { subject: revokerSubject },
		role,
		selfGrant,
		state: grantStateOf(grant, now),
	};
};
