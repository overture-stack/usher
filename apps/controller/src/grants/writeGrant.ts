import type { AuditEvent } from '../eventLog/index.js';
import type { GrantStore, GrantTerms, StoredDecision, StoredRole, ViewedGrant } from './types.js';

/** One grant to place on its terms, once its holder's person is known. */
export interface GrantToPlace {
	/**
	 * What the holder's acceptance, written with the grant, shows them; none for a grant written
	 * pending.
	 */
	acceptance: readonly string[] | undefined;

	/** Shared by every grant one call writes; none for a grant written by deciding a request. */
	creationId: string | null;

	/** None for a grant that never expires. */
	expiresAt: Date | null;

	/** The configured clock's instant, when it is granted. */
	grantedAt: Date;

	/** The granter's person. */
	grantedBy: string;

	/** The principal who asked for the grant in a request; `null` for any other grant. */
	requestedBy: string | null;

	terms: GrantTerms;
}

/**
 * Places one grant in a change's transaction: ends the grant on its terms that has expired, if one
 * has; writes the grant, unless its holder holds one on its terms that is neither revoked nor
 * ended; and appends its holder's acceptance, where one is given, at the grant's instant.
 *
 * @param store the grant store, on the change's connection.
 * @param grant what to place.
 * @returns the grant's id and its holder's acceptance, or `undefined` when its holder holds one on
 *   its terms already.
 */
export const placeGrant = async (
	store: GrantStore,
	{ acceptance, creationId, expiresAt, grantedAt, grantedBy, requestedBy, terms }: GrantToPlace,
): Promise<{ decision: StoredDecision | null; id: string } | undefined> => {
	await store.endExpiredGrant(terms, grantedAt);
	const id = await store.insertGrant({
		...terms,
		creationId,
		expiresAt,
		grantedAt,
		grantedBy,
		requestedBy,
	});
	if (id === undefined) {
		return undefined;
	}
	const decision =
		acceptance === undefined
			? null
			: {
					capabilities: acceptance,
					decidedAt: await store.appendDecision({
						capabilities: acceptance,
						decision: 'accepted',
						grantId: id,
						now: grantedAt,
						userId: terms.holderUserId,
					}),
					decision: 'accepted' as const,
				};
	return { decision, id };
};

/** One grant to write, as its creation names it once every rule of it is judged. */
export interface GrantToWrite {
	/** Whether the holder's acceptance is recorded with it. */
	autoAccept: boolean;

	/** Its record category, by id and as a payload names it; `null` for the whole resource. */
	category: { id: string; scopedName: string } | null;

	/** Shared by every grant one call writes. */
	creationId: string;

	/** None for a grant that never expires. */
	expiresAt: Date | null;

	/** The configured clock's instant, when it is granted. */
	grantedAt: Date;

	/** The granter: their person and their subject. */
	granter: { subject: string; userId: string };

	/** The holder's subject under the trusted issuer. */
	holderSubject: string;

	/** Its resource, by id and by externalId. */
	resource: { externalId: string; id: string };

	role: StoredRole;

	/** The address the request came from. */
	sourceIp: string;
}

/**
 * Writes one grant in a change's transaction: finds its holder's person, recording them and their
 * identity on first meeting them; ends the grant on its terms that has expired, if one has; writes
 * the grant, unless its holder holds one on its terms that is neither revoked nor ended; with
 * auto-accept, appends its holder's acceptance, showing what its role confers then; and records its
 * `grant.creation`, naming the actor's subject through the transaction, the holder's subject, the
 * resource's externalId, the category as a payload names it, `null` for the whole resource, the
 * role and the grant's id.
 *
 * @param store the grant store, on the change's connection.
 * @param record records an event in the change's transaction.
 * @param grant what to write.
 * @returns the grant as written, or `undefined` when its holder holds one on its terms already.
 */
export const writeGrant = async (
	store: GrantStore,
	record: (event: AuditEvent) => Promise<string>,
	{
		autoAccept,
		category,
		creationId,
		expiresAt,
		grantedAt,
		granter,
		holderSubject,
		resource,
		role,
		sourceIp,
	}: GrantToWrite,
): Promise<ViewedGrant | undefined> => {
	const holderUserId = await store.findOrRecordPerson(holderSubject, grantedAt);
	const placed = await placeGrant(store, {
		acceptance: autoAccept ? role.capabilities : undefined,
		creationId,
		expiresAt,
		grantedAt,
		grantedBy: granter.userId,
		requestedBy: null,
		terms: {
			holderUserId,
			recordCategoryId: category?.id ?? null,
			resourceId: resource.id,
			roleId: role.id,
		},
	});
	if (placed === undefined) {
		return undefined;
	}
	const { decision, id } = placed;
	await record({
		data: {
			category: category?.scopedName ?? null,
			grantId: id,
			granteeSubject: holderSubject,
			resourceId: resource.externalId,
			result: 'succeeded',
			role: role.name,
			sourceIp,
		},
		severity: 'info',
		type: 'grant.creation',
	});
	return {
		category: category?.scopedName ?? null,
		decision,
		endedAt: null,
		expiresAt,
		grantedAt,
		granterSubject: granter.subject,
		holderSubject,
		id,
		resource: resource.externalId,
		revokedAt: null,
		revokerSubject: null,
		role: role.name,
		selfGrant: false,
	};
};
