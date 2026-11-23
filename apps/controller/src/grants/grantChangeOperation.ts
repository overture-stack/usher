import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { EventMembers, ManagementOperation, NamedByRequest, OperationOutcome } from '../managementApi/index.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantView } from './grantView.js';
import { judgeGrantChange } from './judgeGrantChange.js';
import {
	actorOf,
	answered,
	changeOutcome,
	refused,
	refuseWithin,
	roleMissing,
	STORED_ID_FORM,
} from './operationOutcome.js';
import { readGrantChange } from './readGrantChange.js';
import type { GrantChange, GrantChangeJudgement, GrantOperationsSettings, StoredGrant } from './types.js';

const instantOrNull = (instant: Date | null): string | null =>
	instant === null ? null : eventInstant(instant.getTime());

// The events a change records: its end moved later or removed, or earlier, and its role changed.
const changeEvents = (
	grant: StoredGrant,
	judgement: Extract<GrantChangeJudgement, { kind: 'change' }>,
	sourceIp: string,
): readonly AuditEvent[] => {
	const ends = {
		category: grant.category,
		endAfter: instantOrNull(judgement.expiresAt),
		endBefore: instantOrNull(grant.expiresAt),
		grantId: grant.id,
		granteeSubject: grant.holderSubject,
		resourceId: grant.resource,
		result: 'succeeded',
		sourceIp,
	};
	const endEvents: readonly AuditEvent[] =
		judgement.endMoved === 'kept'
			? []
			: [
					judgement.endMoved === 'later'
						? { data: ends, severity: 'info', type: 'grant.extension' }
						: { data: ends, severity: 'warning', type: 'grant.reduction' },
				];
	const roleEvents: readonly AuditEvent[] =
		judgement.roleMoved === 'kept'
			? []
			: [
					{
						data: {
							category: grant.category,
							grantId: grant.id,
							resourceId: grant.resource,
							result: 'succeeded',
							roleAfter: judgement.role.name,
							roleBefore: grant.role,
							sourceIp,
						},
						severity: judgement.roleMoved === 'wider' ? 'warning' : 'info',
						type: 'grant.roleChange',
					},
				];
	return [...endEvents, ...roleEvents];
};

/**
 * The operation changing a grant, `PATCH /admin/grants/{grantId}`, its body a JSON Merge Patch read with
 * {@link readGrantChange}; a service account is refused 403 `serviceAccountNotPermitted` before
 * anything is read. In one transaction, its resource's row locked against every other change's
 * first and then the grant's, it judges in turn: an id naming no grant held by a person, malformed
 * or not, and a grant on a retired resource, 404 `grantNotFound`; a caller neither a counted owner
 * of its resource nor a platform administrator 404 `grantNotFound`, its event recording
 * `noAuthorityOnResource`; and the change itself, as {@link judgeGrantChange} judges it at the
 * configured clock's instant, for a counted owner or for a platform administrator who is not one,
 * the caller holding the grant when the person holding their identity under the trusted issuer is
 * its holder.
 *
 * A change keeping the grant's end and its role changes nothing of the grant and records no event
 * of its own. Any other writes the grant's new end and role, its holder's answers left as they
 * were, so a widened role confers nothing more until they accept again, and its store writes a
 * principal notice naming the holder. It records `grant.extension` at info for an end moved later
 * or removed, and `grant.reduction` at warning for one moved earlier, each naming the grant as
 * `grantId`, the holder as `granteeSubject`, the resource, the category and both ends; and
 * `grant.roleChange` for a role changed, naming the grant, at warning when it widens and at info
 * otherwise. A new role whose grant the holder holds on the same terms already is refused 409
 * `alreadyHolds`, and a change leaving a resource without its last owner 409
 * `resourceNeedsAnOwner`. It answers 200 with the grant as changed.
 *
 * A refusal records `grant.roleChange` for a body naming a role, and `grant.extension` for any
 * other, each naming the grant when one held by a person has the id. Each request, one keeping the
 * grant as it was included, is counted against the grant rate by its caller, as the last step of
 * the transaction committing it, or in the transaction recording its refusal or failure.
 *
 * @param operations the grant rate, the grant store over a transaction's connection, the settings
 *   and the trail.
 * @param named what a refused request's event names: the grant, where one held by a person has the
 *   id.
 */
export const grantChangeOperation = (
	{ grantRate, grantStoreOf, settings, trail }: GrantOperationsSettings,
	named: (request: NamedByRequest) => Promise<EventMembers>,
): ManagementOperation<GrantChange> => ({
	administratorOnly: false,
	body: 'required',
	event: {
		named,
		recordedWith: countedWithRefusal({ grantRate }),
		type: ({ body }) =>
			body !== undefined && Object.hasOwn(body, 'role') ? 'grant.roleChange' : 'grant.extension',
	},
	method: 'PATCH',
	readInput: (body) => readGrantChange(body ?? {}, settings.clock.now()),
	route: '/admin/grants/{grantId}',
	run: async ({ input, params, principal, sourceIp }) => {
		const grantId = params['grantId'] ?? '';
		if (!STORED_ID_FORM.test(grantId)) {
			return refused(GRANT_PROBLEMS.grantNotFound);
		}
		const now = new Date(settings.clock.now());
		return changeOutcome(
			trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
				const grants = grantStoreOf(connection);
				const located = (await grants.locateGrant(grantId)) ?? refuseWithin(GRANT_PROBLEMS.grantNotFound);
				const standing = await grants.readStanding({
					externalId: located.externalId,
					lock: 'noKeyUpdate',
					now,
					subject: principal.subject,
				});
				if (standing === undefined || standing.retired) {
					refuseWithin(GRANT_PROBLEMS.grantNotFound);
				}
				const authority =
					standing?.countedOwner === true
						? 'owner'
						: principal.administrator
							? 'administrator'
							: refuseWithin(GRANT_PROBLEMS.grantNotFound, GRANT_PROBLEMS.noAuthorityOnResource.code);
				const grant = (await grants.readGrant(grantId)) ?? refuseWithin(GRANT_PROBLEMS.grantNotFound);
				const role = (await grants.findRole(grant.role)) ?? roleMissing();
				const judgement = judgeGrantChange({
					authority,
					change: input,
					current: { ...grant, role },
					holderIsCaller: (await grants.findPerson(principal.subject)) === grant.holderUserId,
					maximumSeconds: settings.selfGrantMaximumLifetimeSeconds,
					newRole: input.role === undefined ? undefined : await grants.findRole(input.role),
					now,
				});
				if (judgement.kind === 'refuse') {
					return refuseWithin(judgement.problem);
				}
				const changed: StoredGrant = {
					...grant,
					expiresAt: judgement.expiresAt,
					role: judgement.role.name,
				};
				if (judgement.endMoved === 'kept' && judgement.roleMoved === 'kept') {
					await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
					return answered(200, grantView(changed, now.getTime()));
				}
				await grants.changeGrant({
					expiresAt: judgement.expiresAt,
					grantId,
					roleId: judgement.role.id,
				});
				await changeEvents(grant, judgement, sourceIp).reduce<Promise<unknown>>(async (earlier, event) => {
					await earlier;
					return record(event);
				}, Promise.resolve());
				await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
				return answered(200, grantView(changed, now.getTime()));
			}),
			{
				grants_live_unique: GRANT_PROBLEMS.alreadyHolds,
				grants_owner_open_ended: GRANT_PROBLEMS.ownerGrantsDoNotExpire,
				resources_keep_an_owner: GRANT_PROBLEMS.resourceNeedsAnOwner,
			},
		);
	},
});
