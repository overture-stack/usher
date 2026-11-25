import pg from 'pg';

import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type {
	EventMembers,
	ManagementOperation,
	NamedByRequest,
	OperationOutcome,
	Principal,
} from '../managementApi/index.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { readGrantRequestPage } from './grantRequestPage.js';
import { grantRequestView } from './grantRequestView.js';
import { grantView } from './grantView.js';
import {
	actorOf,
	answered,
	changeOutcome,
	refused,
	refuseWithin,
	roleMissing,
	STORED_ID_FORM,
} from './operationOutcome.js';
import { cursorAfterId } from './idCursor.js';
import { readGrantRequestListing } from './readGrantRequestListing.js';
import { readGrantRequestDecision } from './readGrantRequestDecision.js';
import type {
	GrantOperationsSettings,
	GrantRequestDecision,
	GrantRequestKind,
	GrantRequestListing,
	GrantStore,
	StoredGrantRequest,
	StoredRole,
} from './types.js';
import { placeGrant } from './writeGrant.js';

// What a decision is given once its request is judged decidable.
interface Deciding {
	/** Whether the instance accepts a grant at its creation. */
	autoAccept: boolean;

	decidedBy: { subject: string; userId: string };
	now: Date;
	record: (event: AuditEvent) => Promise<string>;
	request: StoredGrantRequest;
	sourceIp: string;
}

// What the holder's acceptance written with a granted request's grant shows them, by the request's
// kind; none leaves the grant pending its holder's answer. A self-grant's holder asked for it, and
// accepts what they were shown then. The holder of an orphaned resource's grant asked for nothing,
// and starts as a created grant's holder does: accepting what the role confers now where the
// instance accepts a grant at its creation, and pending otherwise.
const ACCEPTANCE_OF: Readonly<
	Record<
		GrantRequestKind,
		(request: StoredGrantRequest, role: StoredRole, autoAccept: boolean) => readonly string[] | undefined
	>
> = {
	orphanedResource: (_request, role, autoAccept) => (autoAccept ? role.capabilities : undefined),
	selfGrant: (request) => request.capabilities,
};

// Grants a request: writes the grant it asks for, with the holder's acceptance its kind gives.
const grant = async (
	grants: GrantStore,
	{ autoAccept, decidedBy, now, record, request, sourceIp }: Deciding,
): Promise<OperationOutcome> => {
	const role = (await grants.findRole(request.role)) ?? roleMissing();
	const placed =
		(await placeGrant(grants, {
			acceptance: ACCEPTANCE_OF[request.kind](request, role, autoAccept),
			creationId: null,
			expiresAt: request.expiresAt,
			grantedAt: now,
			grantedBy: decidedBy.userId,
			requestedBy: request.requestedBy,
			terms: {
				holderUserId: request.holderUserId,
				recordCategoryId: request.recordCategoryId,
				resourceId: request.resourceId,
				roleId: role.id,
			},
		})) ?? refuseWithin(GRANT_PROBLEMS.alreadyHolds);
	await grants.recordDecision({
		decidedAt: now,
		decidedBy: decidedBy.userId,
		decision: 'granted',
		grantId: placed.id,
		requestId: request.id,
	});
	await record({
		data: {
			category: request.category,
			decision: 'granted',
			expiresAt: eventInstant(request.expiresAt.getTime()),
			grantId: placed.id,
			granteeSubject: request.holderSubject,
			requestId: request.id,
			requestedBySubject: request.requestedBySubject,
			resourceId: request.resource,
			result: 'succeeded',
			role: request.role,
			sourceIp,
		},
		severity: 'warning',
		type: 'grant.requestDecision',
	});
	return answered(
		200,
		grantView(
			{
				category: request.category,
				decision: placed.decision,
				endedAt: null,
				expiresAt: request.expiresAt,
				grantedAt: now,
				granterSubject: decidedBy.subject,
				holderSubject: request.holderSubject,
				id: placed.id,
				resource: request.resource,
				revokedAt: null,
				revokerSubject: null,
				role: request.role,
				selfGrant: request.requestedBy === request.holderUserId,
			},
			now.getTime(),
		),
	);
};

const decline = async (
	grants: GrantStore,
	{ decidedBy, now, record, request, sourceIp }: Deciding,
): Promise<OperationOutcome> => {
	await grants.recordDecision({
		decidedAt: now,
		decidedBy: decidedBy.userId,
		decision: 'declined',
		grantId: null,
		requestId: request.id,
	});
	await record({
		data: {
			decision: 'declined',
			granteeSubject: request.holderSubject,
			requestId: request.id,
			requestedBySubject: request.requestedBySubject,
			result: 'succeeded',
			sourceIp,
		},
		severity: 'info',
		type: 'grant.requestDecision',
	});
	return answered(200, grantRequestView({ ...request, decidedAt: now, decision: 'declined' }, now.getTime()));
};

/**
 * The operation deciding a grant request, `POST /admin/grant-requests/{grantRequestId}/decisions`. Its body is
 * read with {@link readGrantRequestDecision}, and a service account is refused 403
 * `serviceAccountNotPermitted` before anything is read. In one transaction, its resource's row
 * locked first and then the request's, it judges in turn: an id naming no request, malformed or
 * not, and a request on a retired resource, 404 `requestNotFound`; a caller who asked for it or is
 * its holder 403 `ownRequest`; a caller neither a counted owner of its resource nor a platform
 * administrator 404 `requestNotFound`, its event recording `noAuthorityOnResource`; a grant of a
 * request of kind `orphanedResource` whose resource has a counted owner, by a caller who is not one,
 * 403 `administratorGrantsNoConsumerAccess`; a request decided already 409 `requestDecided`; and one
 * at or past its expiry on the configured clock 409 `requestLapsed`. The caller is recorded on first
 * meeting them. Whether a resource has a counted owner is judged when the request is decided, so a
 * platform administrator grants an orphaned resource's request while it has none, and refuses one
 * at any time.
 *
 * Granting a request writes the grant it names, as a grant is placed: its holder the request's, its
 * granter the caller, the principal who asked for it named beside the granter, at the configured
 * clock's instant, ending at the request's expiry; a holder holding one on its terms neither revoked
 * nor ended is refused 409 `alreadyHolds`. The holder's acceptance written with it follows the
 * request's kind: for a self-grant, showing what the principal asking was shown; for an orphaned
 * resource's, showing what the role confers then where the instance accepts a grant at its
 * creation, and none otherwise, leaving the grant pending its holder's answer. It records the
 * decision, naming the grant, and `grant.requestDecision` at warning, and answers 200 with the
 * grant, `kind` `grant`. A decline records the decision and `grant.requestDecision` at info, and
 * answers 200 with the request decided, `kind` `grantRequest`. Each event names the decision, the
 * holder's subject as `granteeSubject`, and the principal who asked as `requestedBySubject`.
 *
 * A refusal of the operation records `grant.requestDecision`, naming the request when one has the
 * id, and the decision when the body is read as one. Each decision is counted against the grant
 * rate as the last step of the transaction committing it, or in the transaction recording its
 * refusal or failure.
 *
 * @param operations the grant rate, the grant store over a transaction's connection, the settings,
 *   the store reader and the trail.
 */
export const grantRequestDecisionOperation = ({
	grantRate,
	grantStoreOf,
	settings,
	store,
	trail,
}: GrantOperationsSettings): ManagementOperation<GrantRequestDecision> => {
	const { clock, databaseSchema } = settings;
	const namedRequest = async ({ body, params }: NamedByRequest): Promise<EventMembers> => {
		const reading = body === undefined ? undefined : readGrantRequestDecision(body);
		const named = reading?.kind === 'read' ? { decision: reading.input.decision } : {};
		const requestId = params['grantRequestId'] ?? '';
		if (!STORED_ID_FORM.test(requestId)) {
			return named;
		}
		const { rows } = await store.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.grant_requests
                       WHERE id = $1::uuid) AS exists`,
			[requestId],
		);
		return rows[0]?.exists === true ? { ...named, requestId } : named;
	};

	return {
		administratorOnly: false,
		body: 'required',
		event: { named: namedRequest, recordedWith: countedWithRefusal({ grantRate }), type: 'grant.requestDecision' },
		method: 'POST',
		readInput: (body) => readGrantRequestDecision(body ?? {}),
		route: '/admin/grant-requests/{grantRequestId}/decisions',
		run: async ({ input, params, principal, sourceIp }) => {
			const requestId = params['grantRequestId'] ?? '';
			if (!STORED_ID_FORM.test(requestId)) {
				return refused(GRANT_PROBLEMS.requestNotFound);
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const grants = grantStoreOf(connection);
					const located =
						(await grants.locateGrantRequest(requestId)) ?? refuseWithin(GRANT_PROBLEMS.requestNotFound);
					await grants.lockResource(located.resourceId);
					const request =
						(await grants.readGrantRequest(requestId)) ?? refuseWithin(GRANT_PROBLEMS.requestNotFound);
					if (request.resourceRetired) {
						refuseWithin(GRANT_PROBLEMS.requestNotFound);
					}
					const caller = await grants.findPerson(principal.subject);
					if (caller === request.requestedBy || caller === request.holderUserId) {
						refuseWithin(GRANT_PROBLEMS.ownRequest);
					}
					if (!(await mayDecide(grants, principal, request, now))) {
						refuseWithin(GRANT_PROBLEMS.requestNotFound, GRANT_PROBLEMS.noAuthorityOnResource.code);
					}
					if (
						input.decision === 'granted' &&
						request.kind === 'orphanedResource' &&
						!(await mayGrantOrphaned(grants, caller, request, now))
					) {
						refuseWithin(GRANT_PROBLEMS.administratorGrantsNoConsumerAccess);
					}
					if (request.decision !== null) {
						refuseWithin(GRANT_PROBLEMS.requestDecided);
					}
					if (request.expiresAt.getTime() <= now.getTime()) {
						refuseWithin(GRANT_PROBLEMS.requestLapsed);
					}
					const deciding: Deciding = {
						autoAccept: settings.grantAutoAccept,
						decidedBy: {
							subject: principal.subject,
							userId: await grants.findOrRecordPerson(principal.subject, now),
						},
						now,
						record,
						request,
						sourceIp,
					};
					const outcome =
						input.decision === 'granted' ? await grant(grants, deciding) : await decline(grants, deciding);
					await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
					return outcome;
				}),
				{
					resources_retired_without_live_grants: GRANT_PROBLEMS.requestNotFound,
				},
			);
		},
	};
};

// Whether a caller may grant an orphaned resource's request, read with the resource's row locked
// already: while its resource has no counted owner, and once it has, if the caller is one of them.
const mayGrantOrphaned = async (
	grants: GrantStore,
	caller: string | undefined,
	{ resourceId }: StoredGrantRequest,
	now: Date,
): Promise<boolean> => {
	const owners = await grants.countedOwnersOf({ now, resourceId });
	return owners.length === 0 || (caller !== undefined && owners.includes(caller));
};

// Whether a principal may decide a request: a platform administrator, or a counted owner of its
// resource, read with the resource's row locked already.
const mayDecide = async (
	grants: GrantStore,
	{ administrator, subject }: Principal,
	request: StoredGrantRequest,
	now: Date,
): Promise<boolean> =>
	administrator ||
	(
		await grants.readStanding({
			externalId: request.resource,
			lock: 'none',
			now,
			subject,
		})
	)?.countedOwner === true;

/**
 * The operation listing grant requests, `GET /admin/grant-requests`, reading its query with {@link
 * readGrantRequestListing} and the page with {@link readGrantRequestPage} outside any transaction,
 * at the configured clock's instant. It answers 200 with the page's requests, each as {@link
 * grantRequestView} shows it, and `next`, the cursor after its last when another page follows, or
 * `null`. It records no event, and a service account is refused 403 `serviceAccountNotPermitted`.
 *
 * @param operations the settings and the store reader.
 */
export const grantRequestListingOperation = ({
	settings: { clock, databaseSchema, identityProviderIssuer },
	store,
}: GrantOperationsSettings): ManagementOperation<GrantRequestListing> => ({
	administratorOnly: false,
	body: 'none',
	method: 'GET',
	readInput: (_body, context) => readGrantRequestListing(context),
	route: '/admin/grant-requests',
	run: async ({ input, principal }) => {
		const now = clock.now();
		const read = await readGrantRequestPage(store, databaseSchema, {
			...input,
			administrator: principal.administrator,
			issuer: identityProviderIssuer,
			now: new Date(now),
			subject: principal.subject,
		});
		const page = read.slice(0, input.limit);
		const last = page.at(-1);
		return answered(200, {
			next: read.length > page.length && last !== undefined ? cursorAfterId(last.id) : null,
			requests: page.map((request) => grantRequestView(request, now)),
		});
	},
	takesQuery: true,
});
