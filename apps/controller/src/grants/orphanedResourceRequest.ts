import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { OperationOutcome } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantRequestView } from './grantRequestView.js';
import { answered, refuseWithin } from './operationOutcome.js';
import type { GrantStore, StoredRole } from './types.js';

/**
 * The expiry of a grant a platform administrator asks for on a resource with no counted owner,
 * judged in its change's transaction: the expiry named, refused 422
 * `orphanedResourceExpiryRequired` when none is, and 422 `orphanedResourceGrantTooLong` when it is
 * past the longest self-grant life of the request's instant. It requires an expiry named to be
 * after that instant.
 *
 * @param expiresAt the expiry named, or none.
 * @param limit the longest a self-grant lives, in seconds, and the configured clock's instant of
 *   the request.
 * @returns the expiry, unless the change is refused.
 */
export const orphanedResourceExpiry = (
	expiresAt: Date | undefined,
	{ maximumSeconds, now }: { maximumSeconds: number; now: Date },
): Date => {
	if (expiresAt === undefined) {
		return refuseWithin(GRANT_PROBLEMS.orphanedResourceExpiryRequired);
	}
	return expiresAt.getTime() > now.getTime() + maximumSeconds * 1000
		? refuseWithin(GRANT_PROBLEMS.orphanedResourceGrantTooLong)
		: expiresAt;
};

/** A grant a platform administrator asks for on a resource with no counted owner, once judged. */
export interface OrphanedResourceAsking {
	/** Its record category, by id and as a payload names it; `null` for the whole resource. */
	category: { id: string; scopedName: string } | null;

	expiresAt: Date;

	/** The subject of the person who would hold it, under the trusted issuer. */
	holderSubject: string;

	/** The configured clock's instant. */
	now: Date;

	/** The platform administrator asking: their person and their subject. */
	requestedBy: { subject: string; userId: string };

	/** Its resource, by id and by externalId. */
	resource: { externalId: string; id: string };

	role: StoredRole;

	/** The address the request came from. */
	sourceIp: string;
}

/**
 * Writes a grant a platform administrator asks for on a resource with no counted owner as a grant
 * request of kind `orphanedResource`, in its change's transaction: finds its holder's person,
 * recording them on first meeting them; refuses 409 `alreadyHolds` a holder holding a live grant on
 * its terms, and 409 `alreadyRequested` a request of the asker's for the holder on its terms
 * that is undecided and has not lapsed; writes the request undecided, keeping what the role confers
 * then as what was shown; and records `grant.request` at warning, naming the holder's subject as
 * `granteeSubject` and the request's kind. No owner is told of it, the resource having none. It answers
 * 202 with the request.
 *
 * @param grants the grant store, on the change's connection.
 * @param record records an event in the change's transaction.
 * @param asking what is asked for, and by whom.
 */
export const askForOrphanedResource = async (
	grants: GrantStore,
	record: (event: AuditEvent) => Promise<string>,
	{ category, expiresAt, holderSubject, now, requestedBy, resource, role, sourceIp }: OrphanedResourceAsking,
): Promise<OperationOutcome> => {
	const terms = {
		holderUserId: await grants.findOrRecordPerson(holderSubject, now),
		recordCategoryId: category?.id ?? null,
		resourceId: resource.id,
		roleId: role.id,
	};
	if (await grants.holdsLiveGrant(terms, now)) {
		refuseWithin(GRANT_PROBLEMS.alreadyHolds);
	}
	if (
		await grants.holdsPendingRequest({
			...terms,
			kind: 'orphanedResource',
			now,
			requestedBy: requestedBy.userId,
		})
	) {
		refuseWithin(GRANT_PROBLEMS.alreadyRequested);
	}
	const requestId = await grants.insertGrantRequest({
		...terms,
		capabilities: role.capabilities,
		expiresAt,
		kind: 'orphanedResource',
		requestedAt: now,
		requestedBy: requestedBy.userId,
	});
	await record({
		data: {
			category: category?.scopedName ?? null,
			expiresAt: eventInstant(expiresAt.getTime()),
			granteeSubject: holderSubject,
			kind: 'orphanedResource',
			requestId,
			resourceId: resource.externalId,
			result: 'succeeded',
			role: role.name,
			sourceIp,
		},
		severity: 'warning',
		type: 'grant.request',
	});
	return answered(
		202,
		grantRequestView(
			{
				category: category?.scopedName ?? null,
				decidedAt: null,
				decision: null,
				expiresAt,
				grantId: null,
				holderSubject,
				id: requestId,
				kind: 'orphanedResource',
				requestedAt: now,
				requestedBySubject: requestedBy.subject,
				resource: resource.externalId,
				role: role.name,
			},
			now.getTime(),
		),
	);
};
