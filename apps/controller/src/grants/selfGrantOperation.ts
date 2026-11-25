import { randomUUID } from 'node:crypto';

import { type AuditEvent, eventInstant, type JsonValue } from '../eventLog/index.js';
import type { EventMembers, ManagementOperation, NamedByRequest, OperationOutcome } from '../managementApi/index.js';
import type { ResourceStanding } from '../resourceStanding/index.js';
import { selfGrantAuthority } from './grantAuthority.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { type CategoryNaming, categoryNamingsOf, forCategory, offeredCategory } from './grantCategory.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantRequestView } from './grantRequestView.js';
import { grantView } from './grantView.js';
import { actorOf, answered, changeOutcome, refuseWithin } from './operationOutcome.js';
import { readSelfGrantCreation } from './readSelfGrantCreation.js';
import type { GrantOperationsSettings, GrantStore, GrantTerms, SelfGrantCreation, StoredRole } from './types.js';
import { placeGrant } from './writeGrant.js';

// What a self-grant names once every rule of it is judged, in its change's transaction.
interface JudgedSelfGrant {
	/** Its record category, by id and as a payload names it; `null` for the whole resource. */
	category: { id: string; scopedName: string } | null;

	/** The caller: their person and their subject. */
	caller: { subject: string; userId: string };

	/** Shared by every grant and request the call writes. */
	creationId: string;

	expiresAt: Date;

	/** The category as the request named it, so a refusal names its place. */
	naming: CategoryNaming;

	/** Whether it is issued at once because nobody else could approve it. */
	soleAdministrator: boolean;

	/** The configured clock's instant. */
	now: Date;

	record: (event: AuditEvent) => Promise<string>;
	resource: ResourceStanding;
	role: StoredRole;
	sourceIp: string;
	terms: GrantTerms;
}

const namedResource = async ({ body }: NamedByRequest): Promise<EventMembers> => {
	const resource = body?.['resource'];
	return typeof resource === 'string' ? { resourceId: resource } : {};
};

// Tells each counted owner of a resource but the caller of a self-grant or a request on it,
// writing nothing where there is none.
const tellOwners = async (
	grants: GrantStore,
	{
		caller,
		kind,
		now,
		reference,
		resourceId,
	}: {
		caller: string;
		kind: 'grantRequest' | 'selfGrant';
		now: Date;
		reference: string;
		resourceId: string;
	},
): Promise<void> => {
	const recipients = (await grants.countedOwnersOf({ now, resourceId })).filter((owner) => owner !== caller);
	if (recipients.length > 0) {
		await grants.writeNotifications({
			createdAt: now,
			kind,
			recipients,
			reference,
		});
	}
};

// A counted owner's self-grant, issued at once with their acceptance.
const issue = async (
	grants: GrantStore,
	{
		caller,
		category,
		creationId,
		expiresAt,
		naming,
		now,
		record,
		resource,
		role,
		soleAdministrator,
		sourceIp,
		terms,
	}: JudgedSelfGrant,
): Promise<JsonValue> => {
	const placed =
		(await placeGrant(grants, {
			acceptance: role.capabilities,
			creationId,
			expiresAt,
			grantedAt: now,
			grantedBy: caller.userId,
			requestedBy: null,
			terms,
		})) ?? refuseWithin(forCategory(GRANT_PROBLEMS.alreadyHolds, naming));
	await record({
		data: {
			category: category?.scopedName ?? null,
			expiresAt: eventInstant(expiresAt.getTime()),
			grantId: placed.id,
			resourceId: resource.externalId,
			result: 'succeeded',
			role: role.name,
			...(soleAdministrator ? { soleAdministrator: true } : {}),
			sourceIp,
		},
		severity: 'warning',
		type: 'grant.selfCreation',
	});
	await tellOwners(grants, {
		caller: caller.userId,
		kind: 'selfGrant',
		now,
		reference: placed.id,
		resourceId: resource.id,
	});
	return grantView(
		{
			category: category?.scopedName ?? null,
			decision: placed.decision,
			endedAt: null,
			expiresAt,
			grantedAt: now,
			granterSubject: caller.subject,
			holderSubject: caller.subject,
			id: placed.id,
			resource: resource.externalId,
			revokedAt: null,
			revokerSubject: null,
			role: role.name,
			selfGrant: true,
		},
		now.getTime(),
	);
};

// A platform administrator's self-grant, asked for as a request someone else decides.
const request = async (
	grants: GrantStore,
	{ caller, category, creationId, expiresAt, naming, now, record, resource, role, sourceIp, terms }: JudgedSelfGrant,
): Promise<JsonValue> => {
	if (await grants.holdsLiveGrant(terms, now)) {
		refuseWithin(forCategory(GRANT_PROBLEMS.alreadyHolds, naming));
	}
	if (
		await grants.holdsPendingRequest({
			...terms,
			kind: 'selfGrant',
			now,
			requestedBy: caller.userId,
		})
	) {
		refuseWithin(forCategory(GRANT_PROBLEMS.alreadyRequested, naming));
	}
	const requestId = await grants.insertGrantRequest({
		...terms,
		capabilities: role.capabilities,
		creationId,
		expiresAt,
		kind: 'selfGrant',
		requestedAt: now,
		requestedBy: caller.userId,
	});
	await record({
		data: {
			category: category?.scopedName ?? null,
			expiresAt: eventInstant(expiresAt.getTime()),
			granteeSubject: caller.subject,
			kind: 'selfGrant',
			requestId,
			resourceId: resource.externalId,
			result: 'succeeded',
			role: role.name,
			sourceIp,
		},
		severity: 'warning',
		type: 'grant.request',
	});
	await tellOwners(grants, {
		caller: caller.userId,
		kind: 'grantRequest',
		now,
		reference: requestId,
		resourceId: resource.id,
	});
	return grantRequestView(
		{
			category: category?.scopedName ?? null,
			decidedAt: null,
			decision: null,
			expiresAt,
			grantId: null,
			holderSubject: caller.subject,
			id: requestId,
			kind: 'selfGrant',
			requestedAt: now,
			requestedBySubject: caller.subject,
			resource: resource.externalId,
			role: role.name,
		},
		now.getTime(),
	);
};

/**
 * The operation creating a self-grant, `POST /admin/grants/self`. Its body is read with {@link
 * readSelfGrantCreation}, and a service account is refused 403 `serviceAccountNotPermitted` before
 * anything is read. In one transaction it then judges in turn: a role the instance does not define,
 * in its exact letter case, 422 `unknownRole`; a control-plane role 422 `controlPlaneSelfGrant`; a
 * data-plane role naming no category 422 `categoryRequired`, except `submitter`, which takes the
 * instance's submitter category; the caller's authority on the resource, its row locked against
 * every other change's, as {@link selfGrantAuthority} decides it; and each category named, in order,
 * that the resource does not offer 422 `categoryNotOffered`. The caller is recorded on first meeting
 * them. One self-grant, or one request, is then written per category, in order, sharing one
 * creation id; a refusal of any writes none and names the category's place in `categories`.
 *
 * A counted owner of the resource is issued the grant at once, its granter and its holder the
 * caller, with their acceptance showing what the role confers then, unless they hold one on its
 * terms that is neither revoked nor ended, refused 409 `alreadyHolds`; it is recorded as
 * `grant.selfCreation` at warning, each other counted owner of the resource is written an outbox
 * row of kind `selfGrant` for each, and it answers 201 with the grants, each `kind` `grant`.
 *
 * Any other platform administrator asks for it: a live grant held on its terms is refused 409
 * `alreadyHolds`, and a request of theirs on its terms that is undecided and has not lapsed 409
 * `alreadyRequested`. The request is written undecided, keeping what the role confers then as what
 * they were shown, recorded as `grant.request` at warning, and each counted owner of the resource
 * is written an outbox row of kind `grantRequest`, no other platform administrator one, none on a
 * resource without an owner, for each; it answers 202 with the requests, each `kind` `grantRequest`.
 *
 * Every instant is the configured clock's. A refusal records `grant.selfCreation`, denied, naming
 * the resource the body names. Each grant or request written is counted against the grant rate by
 * its caller, in the transaction committing it, and a refused or failed call once, in the transaction
 * recording its refusal or failure.
 *
 * @param operations the grant rate, the grant store over a transaction's connection, the settings
 *   and the trail.
 */
export const selfGrantOperation = ({
	grantRate,
	grantStoreOf,
	settings,
	trail,
}: GrantOperationsSettings): ManagementOperation<SelfGrantCreation> => ({
	administratorOnly: false,
	body: 'required',
	event: {
		named: namedResource,
		recordedWith: countedWithRefusal({ grantRate }),
		type: 'grant.selfCreation',
	},
	method: 'POST',
	readInput: (body, { principal }) =>
		readSelfGrantCreation(body ?? {}, {
			administrator: principal.administrator,
			maximumSeconds: settings.selfGrantMaximumLifetimeSeconds,
			now: settings.clock.now(),
		}),
	route: '/admin/grants/self',
	run: ({ input, principal, sourceIp }) => {
		const now = new Date(settings.clock.now());
		return changeOutcome(
			trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
				const grants = grantStoreOf(connection);
				const role = (await grants.findRole(input.role)) ?? refuseWithin(GRANT_PROBLEMS.unknownRole);
				if (role.plane === 'control') {
					refuseWithin(GRANT_PROBLEMS.controlPlaneSelfGrant);
				}
				const namings = categoryNamingsOf(role, input.categories, settings.submitterCategory);
				const standing = await grants.readStanding({
					externalId: input.resource,
					lock: 'noKeyUpdate',
					now,
					subject: principal.subject,
				});
				// Nobody else could approve an administrator's request when they are the only live
				// administrator and the resource has no counted owner; read only where it decides.
				const unapprovable =
					principal.administrator &&
					standing !== undefined &&
					!standing.retired &&
					!standing.countedOwner &&
					(await grants.countLiveAdministrators()) === 1 &&
					(await grants.countedOwnersOf({ now, resourceId: standing.id })).length === 0;
				const authority = selfGrantAuthority({
					administrator: principal.administrator,
					standing,
					unapprovable,
				});
				if (authority.kind === 'refuse') {
					refuseWithin(authority.problem, authority.recordedReason);
				}
				const resource = standing ?? refuseWithin(GRANT_PROBLEMS.resourceNotFound);
				const judgedCategories = await namings.reduce<
					Promise<readonly { category: JudgedSelfGrant['category']; naming: CategoryNaming }[]>
				>(
					async (earlier, naming) => [
						...(await earlier),
						{ category: await offeredCategory(grants, naming, resource.id), naming },
					],
					Promise.resolve([]),
				);
				const userId = await grants.findOrRecordPerson(principal.subject, now);
				const creationId = randomUUID();
				const write = authority.kind === 'issue' ? issue : request;
				const written = await judgedCategories.reduce<Promise<readonly JsonValue[]>>(
					async (earlier, { category, naming }) => {
						const before = await earlier;
						const view = await write(grants, {
							caller: { subject: principal.subject, userId },
							category,
							creationId,
							expiresAt: input.expiresAt,
							naming,
							now,
							record,
							resource,
							role,
							soleAdministrator: authority.kind === 'issue' && authority.soleAdministrator,
							sourceIp,
							terms: {
								holderUserId: userId,
								recordCategoryId: category?.id ?? null,
								resourceId: resource.id,
								roleId: role.id,
							},
						});
						await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
						return [...before, view];
					},
					Promise.resolve([]),
				);
				return authority.kind === 'issue'
					? answered(201, { grants: [...written] })
					: answered(202, { requests: [...written] });
			}),
			{
				resources_retired_without_live_grants: GRANT_PROBLEMS.resourceNotFound,
			},
		);
	},
});
