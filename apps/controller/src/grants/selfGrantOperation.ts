import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { EventMembers, ManagementOperation, NamedByRequest, OperationOutcome } from '../managementApi/index.js';
import type { ResourceStanding } from '../resourceStanding/index.js';
import { selfGrantAuthority } from './grantAuthority.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { categoryNamingOf, offeredCategory } from './grantCategory.js';
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

	expiresAt: Date;

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
	{ caller, category, expiresAt, now, record, resource, role, sourceIp, terms }: JudgedSelfGrant,
): Promise<OperationOutcome> => {
	const placed =
		(await placeGrant(grants, {
			acceptance: role.capabilities,
			expiresAt,
			grantedAt: now,
			grantedBy: caller.userId,
			requestedBy: null,
			terms,
		})) ?? refuseWithin(GRANT_PROBLEMS.alreadyHolds);
	await record({
		data: {
			category: category?.scopedName ?? null,
			expiresAt: eventInstant(expiresAt.getTime()),
			grantId: placed.id,
			resourceId: resource.externalId,
			result: 'succeeded',
			role: role.name,
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
	return answered(
		201,
		grantView(
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
		),
	);
};

// A platform administrator's self-grant, asked for as a request someone else decides.
const request = async (
	grants: GrantStore,
	{ caller, category, expiresAt, now, record, resource, role, sourceIp, terms }: JudgedSelfGrant,
): Promise<OperationOutcome> => {
	if (await grants.holdsLiveGrant(terms, now)) {
		refuseWithin(GRANT_PROBLEMS.alreadyHolds);
	}
	if (
		await grants.holdsPendingRequest({
			...terms,
			kind: 'selfGrant',
			now,
			requestedBy: caller.userId,
		})
	) {
		refuseWithin(GRANT_PROBLEMS.alreadyRequested);
	}
	const requestId = await grants.insertGrantRequest({
		...terms,
		capabilities: role.capabilities,
		expiresAt,
		kind: 'selfGrant',
		requestedAt: now,
		requestedBy: caller.userId,
	});
	await record({
		data: {
			category: category?.scopedName ?? null,
			expiresAt: eventInstant(expiresAt.getTime()),
			granteeId: caller.subject,
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
	return answered(
		202,
		grantRequestView(
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
		),
	);
};

/**
 * The operation creating a self-grant, `POST /admin/grants/self`. Its body is read with {@link
 * readSelfGrantCreation}, and a service account is refused 403 `serviceAccountNotPermitted` before
 * anything is read. In one transaction it then judges in turn: a role the instance does not define,
 * in its exact letter case, 422 `unknownRole`; a control-plane role 422 `controlPlaneSelfGrant`; a
 * data-plane role naming no category 422 `categoryRequired`, except `submitter`, which takes the
 * instance's submitter category; the caller's authority on the resource, its row locked against
 * every other change's, as {@link selfGrantAuthority} decides it; and a category the resource does
 * not offer 422 `categoryNotOffered`. The caller is recorded on first meeting them.
 *
 * A counted owner of the resource is issued the grant at once, its granter and its holder the
 * caller, with their acceptance showing what the role confers then, unless they hold one on its
 * terms that is neither revoked nor ended, refused 409 `alreadyHolds`; it is recorded as
 * `grant.selfCreation` at warning, each other counted owner of the resource is written an outbox
 * row of kind `selfGrant`, and it answers 201 with the grant, `kind` `grant`.
 *
 * Any other platform administrator asks for it: a live grant held on its terms is refused 409
 * `alreadyHolds`, and a request of theirs on its terms that is undecided and has not lapsed 409
 * `alreadyRequested`. The request is written undecided, keeping what the role confers then as what
 * they were shown, recorded as `grant.request` at warning, and each counted owner of the resource
 * is written an outbox row of kind `grantRequest`, no other platform administrator one, none on a
 * resource without an owner; it answers 202 with the request, `kind` `grantRequest`.
 *
 * Every instant is the configured clock's. A refusal records `grant.selfCreation`, denied, naming
 * the resource the body names. Each request is counted against the grant rate by its caller, as
 * the last step of the transaction committing it, or in the transaction recording its refusal or
 * failure.
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
				const naming = categoryNamingOf(role, input.category, settings.submitterCategory);
				const standing = await grants.readStanding({
					externalId: input.resource,
					lock: 'noKeyUpdate',
					now,
					subject: principal.subject,
				});
				const authority = selfGrantAuthority({
					administrator: principal.administrator,
					standing,
				});
				if (authority.kind === 'refuse') {
					refuseWithin(authority.problem, authority.recordedReason);
				}
				const resource = standing ?? refuseWithin(GRANT_PROBLEMS.resourceNotFound);
				const category = await offeredCategory(grants, naming, resource.id);
				const userId = await grants.findOrRecordPerson(principal.subject, now);
				const judged: JudgedSelfGrant = {
					caller: { subject: principal.subject, userId },
					category,
					expiresAt: input.expiresAt,
					now,
					record,
					resource,
					role,
					sourceIp,
					terms: {
						holderUserId: userId,
						recordCategoryId: category?.id ?? null,
						resourceId: resource.id,
						roleId: role.id,
					},
				};
				const outcome =
					authority.kind === 'issue' ? await issue(grants, judged) : await request(grants, judged);
				await grantRate.count({ connection, record }, principal.subject);
				return outcome;
			}),
			{
				resources_retired_without_live_grants: GRANT_PROBLEMS.resourceNotFound,
			},
		);
	},
});
