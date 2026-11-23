import { eventInstant, type JsonValue } from '../eventLog/index.js';
import type { ViewedGrantRequest } from './types.js';

/** A grant request's state, as an answer names it. */
export type GrantRequestState = 'declined' | 'granted' | 'lapsed' | 'pending';

/**
 * A grant request's state on the configured clock: its decision once decided, whatever its expiry;
 * otherwise `lapsed` from its expiry on, and `pending` before it.
 *
 * @param request the request's decision and its expiry.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const grantRequestStateOf = (
	{ decision, expiresAt }: Pick<ViewedGrantRequest, 'decision' | 'expiresAt'>,
	now: number,
): GrantRequestState => {
	if (decision !== null) {
		return decision;
	}
	return expiresAt.getTime() > now ? 'pending' : 'lapsed';
};

/**
 * A grant request as an answer shows it: `kind` `grantRequest`, beside the request's own kind as
 * `requestKind`; the principal who asked for it by subject, as `requestedBy`; the holder by subject,
 * as one with an account and no address, since none is read; the resource by externalId; each
 * instant in UTC with `Z`; and its state on the configured clock.
 *
 * @param request the request.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const grantRequestView = (request: ViewedGrantRequest, now: number): JsonValue => ({
	category: request.category,
	decidedAt: request.decidedAt === null ? null : eventInstant(request.decidedAt.getTime()),
	expiresAt: eventInstant(request.expiresAt.getTime()),
	grantId: request.grantId,
	holder: { hasAccount: true, subject: request.holderSubject },
	id: request.id,
	kind: 'grantRequest',
	requestKind: request.kind,
	requestedAt: eventInstant(request.requestedAt.getTime()),
	requestedBy: { subject: request.requestedBySubject },
	resource: request.resource,
	role: request.role,
	state: grantRequestStateOf(request, now),
});
