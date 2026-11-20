import type { RouteOptions } from 'fastify';
import pg from 'pg';

import {
	type EventMembers,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	type NamedByRequest,
	type OperationOutcome,
	type Principal,
} from '../managementApi/index.js';
import { isLive, type StandingLock } from '../resourceStanding/index.js';
import { addressedAnswer, type AddressedTerms, unansweredRefusal } from './addressedCreation.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { unresolvedByDirectory } from './directoryOutcome.js';
import { administratorGrants, grantAuthority } from './grantAuthority.js';
import { categoryNamingOf, offeredCategory } from './grantCategory.js';
import { grantChangeOperation } from './grantChangeOperation.js';
import {
	ownGrantListingOperation,
	personGrantListingOperation,
	resourceGrantListingOperation,
} from './grantListingOperations.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantRequestDecisionOperation, grantRequestListingOperation } from './grantRequestOperations.js';
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
import { readGrantAnswer } from './readGrantAnswer.js';
import { readGrantCreation } from './readGrantCreation.js';
import { readGrantRevocation } from './readGrantRevocation.js';
import { askForOrphanedResource, orphanedResourceExpiry } from './orphanedResourceRequest.js';
import { selfGrantOperation } from './selfGrantOperation.js';
import { submitterRemovalOperation } from './submitterRemovalOperation.js';
import type {
	GrantAnswer,
	GrantCreation,
	GrantOperationsSettings,
	GrantRevocation,
	GrantStore,
	JudgedCreation,
	StoredGrant,
	StoredRole,
	ViewedGrant,
} from './types.js';
import { writeGrant } from './writeGrant.js';

// Whether a grant makes its holder a counted owner of its resource now: an owner grant, live, whose
// holder's latest answer accepted it.
const isCountedOwnerGrant = (grant: StoredGrant, now: number): boolean =>
	grant.role === 'owner' && isLive(grant, now) && grant.decision?.decision === 'accepted';

// Whether the capabilities shown are exactly a role's, as a set.
const showsRole = (shown: readonly string[], { capabilities }: StoredRole): boolean => {
	const named = new Set(shown);
	return named.size === capabilities.length && capabilities.every((capability) => named.has(capability));
};

/**
 * Creates the routes of the Management API's grant operations: creating a grant, a holder answering
 * one, revoking one, and the operations {@link selfGrantOperation}, {@link grantChangeOperation},
 * {@link grantRequestDecisionOperation}, {@link grantRequestListingOperation}, {@link
 * submitterRemovalOperation}, {@link ownGrantListingOperation}, {@link
 * resourceGrantListingOperation} and {@link personGrantListingOperation} build, over the same
 * store, directory, settings and trail. Each change commits in one transaction with its event and
 * its notices, or writes nothing; a refusal inside the transaction rolls it back whole, and a
 * service account is refused 403 `serviceAccountNotPermitted` before anything is read. Every
 * instant is read from the configured clock, and a grant is live while it is neither revoked, nor
 * replaced once expired, nor expired on that clock. Each change answers a retired resource, and
 * every grant on one, as one that does not exist, to everyone, and locks the resource's row before
 * any grant's; each listing says what of a retired resource it shows.
 *
 * Creating a grant, `POST /admin/grants`, reads its body with {@link readGrantCreation}, then
 * judges in turn: a role the instance does not define, in its exact letter case, 422 `unknownRole`;
 * a control-plane role naming a category 422 `wholeResourceRole`, and a data-plane role naming none
 * 422 `categoryRequired`, except `submitter`, which takes the instance's submitter category; the
 * grant's authority, decided by {@link grantAuthority} on the resource's row locked for share,
 * whether the resource has a counted owner read for a platform administrator granting a role other
 * than `submitter` and `owner` alone; a category the resource does not offer 422
 * `categoryNotOffered`; and a request's expiry, as {@link orphanedResourceExpiry} judges it. It
 * then writes the grant with {@link writeGrant}, its granter the caller, recorded on first meeting
 * them, refusing 409 `alreadyHolds` a holder holding one on its terms neither revoked nor ended,
 * and answers 201 with the grant. A creation whose commit fails since its resource was retired
 * first is answered 404 `resourceNotFound`. Its event, refused, names the resource the body names.
 *
 * A platform administrator's grant of a role other than `submitter` and `owner`, on a resource that
 * has no counted owner, is asked for instead: {@link askForOrphanedResource} writes it as a grant
 * request of kind `orphanedResource`, its requestedBy the caller asking, recorded on first meeting them, and
 * its holder the person named, and it answers 202 with the request. Its holder is named as a
 * grant's is, and a refusal of it records `grant.creation` as a grant's does.
 *
 * A holder named by address is resolved through the directory only once every other rule is judged,
 * in a transaction of its own writing nothing, and never while a transaction is open. The grant or
 * the request is then written as for the subject the address resolves to, every rule judged again,
 * so an address resolving to the caller is refused as their own subject is. A grant is answered as
 * {@link addressedAnswer} decides, and a request as one naming its holder by subject is; an address
 * held by no single account is answered as addressedAnswer decides, and a directory resolving
 * nothing as {@link unresolvedByDirectory} decides.
 *
 * Answering a grant, `POST /admin/grants/{id}/decisions`, reads its body with {@link
 * readGrantAnswer}. Only the grant's holder answers it, the person holding the caller's identity
 * under the trusted issuer: anyone else, and an id naming no grant held by a person, malformed or
 * not, is answered 404 `grantNotFound` alike. A grant no longer live is refused 409 `doesNotHold`;
 * capabilities other than those the grant's role confers now, as a set, 422 `capabilitiesDiffer`;
 * and declining the last counted owner grant of its resource, 409 `resourceNeedsAnOwner`, as is a
 * decline whose commit fails for keeping its resource owned. The answer is appended, showing the
 * role's capabilities, each later than the holder's latest answer to the grant, and recorded as
 * `grant.decision`; the grant itself is left as it is, and the answer is 204.
 *
 * Revoking a grant, `DELETE /admin/grants/{id}`, reads its body with {@link readGrantRevocation}. A
 * platform administrator revokes any grant, and a counted owner of its resource any grant on it;
 * anyone else, and an id naming no grant held by a person, malformed or empty, is answered 404
 * `grantNotFound` alike. A grant revoked already is refused 409 `doesNotHold`, keeping its first
 * revocation; a pending, declined, accepted or expired grant is revoked alike. Revoking the last
 * counted owner grant of its resource is refused 409 `resourceNeedsAnOwner`, as is a revocation
 * whose commit fails for keeping its resource owned. The revocation records its reason on
 * `grant.revocation` and answers 200 with the grant revoked.
 *
 * A refusal answered `404` for want of authority records `noAuthorityOnResource` as its event's
 * reason; an event of an answer or a revocation refused names the grant when one held by a person
 * has the id.
 *
 * Each request of a grant write, a creation, an answer, a revocation, a self-grant, a change, a
 * request's decision or a submitter's removal, is counted against the grant rate once, by its
 * caller: as the last step of the transaction committing it, a change keeping a grant as it was
 * included, or else in the transaction recording its refusal or failure, as for an owner's creation
 * naming an address no single account holds. A listing is never counted, and the count refuses no
 * write.
 *
 * @param operations the grant store over a transaction's connection, the directory, the grant rate,
 *   the settings, the store reader and the trail, each on the control pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createGrantRoutes = (
	operations: GrantOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const { directory, grantRate, grantStoreOf, settings, store, trail } = operations;
	const { clock, databaseSchema } = settings;
	const recordedWith = countedWithRefusal(operations);
	const namedGrant = async ({ params }: NamedByRequest): Promise<EventMembers> => {
		const grantId = params['id'] ?? '';
		if (!STORED_ID_FORM.test(grantId)) {
			return {};
		}
		const { rows } = await store.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.grants
                       WHERE id = $1::uuid AND holder_user_id IS NOT NULL) AS exists`,
			[grantId],
		);
		return rows[0]?.exists === true ? { grantId } : {};
	};

	const namedResource = async ({ body }: NamedByRequest): Promise<EventMembers> => {
		const resource = body?.['resource'];
		if (typeof resource !== 'string') {
			return {};
		}
		const { rows } = await store.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.resources
                       WHERE external_id = $1) AS exists`,
			[resource],
		);
		return rows[0]?.exists === true ? { resourceId: resource } : {};
	};

	// Judges every rule of a creation but its holder's address, in a change's transaction: the role,
	// the category it names, the caller's authority on the resource read under the lock given, the
	// holder named being the caller among it, the category the resource offers, and a request's
	// expiry. Whether the resource has no counted owner is read only where it decides the authority.
	const judgeCreation = async (
		grants: GrantStore,
		{
			input,
			lock,
			now,
			principal,
		}: {
			input: GrantCreation;
			lock: StandingLock;
			now: Date;
			principal: Principal;
		},
		holderSubject: string | undefined,
	): Promise<JudgedCreation> => {
		const role = (await grants.findRole(input.role)) ?? refuseWithin(GRANT_PROBLEMS.unknownRole);
		const naming = categoryNamingOf(role, input.category, settings.submitterCategory);
		const standing = await grants.readStanding({
			externalId: input.resource,
			lock,
			now,
			subject: principal.subject,
		});
		const orphaned =
			principal.administrator && !administratorGrants(role.name) && standing?.retired === false
				? (await grants.countedOwnersOf({ now, resourceId: standing.id })).length === 0
				: false;
		const authority = grantAuthority({
			administrator: principal.administrator,
			holderIsCaller: holderSubject === principal.subject,
			orphaned,
			role: role.name,
			standing,
		});
		if (authority.kind === 'refuse') {
			refuseWithin(authority.problem, authority.recordedReason);
		}
		const resource = standing ?? refuseWithin(GRANT_PROBLEMS.resourceNotFound);
		const category = await offeredCategory(grants, naming, resource.id);
		return {
			authority:
				authority.kind === 'request'
					? {
							expiresAt: orphanedResourceExpiry(input.expiresAt, {
								maximumSeconds: settings.selfGrantMaximumLifetimeSeconds,
								now,
							}),
							kind: 'request',
						}
					: { kind: 'issue' },
			category,
			kind: 'judged',
			resource,
			role,
		};
	};

	// Writes a creation for the holder's subject in one transaction, judging every rule again on the
	// resource's row locked for share: its grant, answered as `answerOf` says, or the request a
	// platform administrator asks for on a resource with no counted owner, answered 202.
	const writeCreation = (
		request: { input: GrantCreation; now: Date; principal: Principal },
		holderSubject: string,
		sourceIp: string,
		answerOf: (written: ViewedGrant) => OperationOutcome,
	): Promise<OperationOutcome> => {
		const { now, principal } = request;
		return changeOutcome(
			trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
				const grants = grantStoreOf(connection);
				const { authority, category, resource, role } = await judgeCreation(
					grants,
					{ ...request, lock: 'share' },
					holderSubject,
				);
				const granter = {
					subject: principal.subject,
					userId: await grants.findOrRecordPerson(principal.subject, now),
				};
				const terms = {
					category,
					holderSubject,
					resource: { externalId: resource.externalId, id: resource.id },
					role,
					sourceIp,
				};
				const outcome =
					authority.kind === 'request'
						? await askForOrphanedResource(grants, record, {
								...terms,
								expiresAt: authority.expiresAt,
								now,
								requestedBy: granter,
							})
						: answerOf(
								(await writeGrant(grants, record, {
									...terms,
									autoAccept: settings.grantAutoAccept,
									expiresAt: request.input.expiresAt ?? null,
									grantedAt: now,
									granter,
								})) ?? refuseWithin(GRANT_PROBLEMS.alreadyHolds),
							);
				await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
				return outcome;
			}),
			{
				resources_retired_without_live_grants: GRANT_PROBLEMS.resourceNotFound,
			},
		);
	};

	// Creates a grant whose holder is named by address: every other rule judged first, in a
	// transaction writing nothing, then the address resolved, then the grant written as for the
	// subject it resolves to, and answered as addressedAnswer decides.
	const createByAddress = async (
		request: { input: GrantCreation; now: Date; principal: Principal },
		email: string,
		sourceIp: string,
	): Promise<OperationOutcome> => {
		const { now, principal } = request;
		const judged = await changeOutcome(
			trail.inTransaction(actorOf(principal), ({ connection }) =>
				judgeCreation(grantStoreOf(connection), { ...request, lock: 'none' }, undefined),
			),
		);
		if (judged.kind === 'refused') {
			return judged;
		}
		const resolution = await directory.resolveAddress(email);
		if (resolution.kind === 'unavailable' || resolution.kind === 'unconfigured') {
			return unresolvedByDirectory(resolution, 'holderBySubject');
		}
		const terms: AddressedTerms = {
			category: judged.category?.scopedName ?? null,
			email,
			resource: judged.resource.externalId,
			role: judged.role.name,
		};
		if (resolution.kind === 'resolved') {
			return writeCreation(
				request,
				resolution.subject,
				sourceIp,
				(written) => addressedAnswer(principal, terms, written, now.getTime()).outcome,
			);
		}
		const { outcome, recordedRefusal } = addressedAnswer(principal, terms, undefined, now.getTime());
		if (recordedRefusal !== undefined) {
			await trail.inTransaction(actorOf(principal), async (transaction) => {
				await transaction.record(unansweredRefusal(terms.resource, recordedRefusal, sourceIp));
				await grantRate.count(transaction, { sourceIp, subject: principal.subject });
			});
		}
		return outcome;
	};

	const creation: ManagementOperation<GrantCreation> = {
		administratorOnly: false,
		body: 'required',
		event: { named: namedResource, recordedWith, type: 'grant.creation' },
		method: 'POST',
		readInput: (body) => readGrantCreation(body ?? {}, clock.now()),
		route: '/admin/grants',
		run: ({ input, principal, sourceIp }) => {
			const request = { input, now: new Date(clock.now()), principal };
			return input.holder.kind === 'subject'
				? writeCreation(request, input.holder.subject, sourceIp, (written) =>
						answered(201, grantView(written, request.now.getTime())),
					)
				: createByAddress(request, input.holder.email, sourceIp);
		},
	};

	const answering: ManagementOperation<GrantAnswer> = {
		administratorOnly: false,
		body: 'required',
		event: { named: namedGrant, recordedWith, type: 'grant.decision' },
		method: 'POST',
		readInput: (body) => readGrantAnswer(body ?? {}),
		route: '/admin/grants/{id}/decisions',
		run: async ({ input, params, principal, sourceIp }) => {
			const grantId = params['id'] ?? '';
			if (!STORED_ID_FORM.test(grantId)) {
				return refused(GRANT_PROBLEMS.grantNotFound);
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const grants = grantStoreOf(connection);
					const located = (await grants.locateGrant(grantId)) ?? refuseWithin(GRANT_PROBLEMS.grantNotFound);
					await grants.lockResource(located.resourceId);
					const grant = (await grants.readGrant(grantId)) ?? refuseWithin(GRANT_PROBLEMS.grantNotFound);
					if (grant.resourceRetired) {
						refuseWithin(GRANT_PROBLEMS.grantNotFound);
					}
					if ((await grants.findPerson(principal.subject)) !== grant.holderUserId) {
						refuseWithin(GRANT_PROBLEMS.grantNotFound, GRANT_PROBLEMS.noAuthorityOnResource.code);
					}
					if (!isLive(grant, now.getTime())) {
						refuseWithin(GRANT_PROBLEMS.doesNotHold);
					}
					const role = (await grants.findRole(grant.role)) ?? roleMissing();
					if (!showsRole(input.capabilities, role)) {
						refuseWithin(GRANT_PROBLEMS.capabilitiesDiffer);
					}
					if (
						input.decision === 'rejected' &&
						isCountedOwnerGrant(grant, now.getTime()) &&
						(await grants.countedOwnersBesides({
							grantId,
							now,
							resourceId: grant.resourceId,
						})) === 0
					) {
						refuseWithin(GRANT_PROBLEMS.resourceNeedsAnOwner);
					}
					await grants.appendDecision({
						capabilities: role.capabilities,
						decision: input.decision,
						grantId,
						now,
						userId: grant.holderUserId,
					});
					await record({
						data: {
							category: grant.category,
							decision: input.decision,
							grantId,
							resourceId: grant.resource,
							result: 'succeeded',
							role: grant.role,
							sourceIp,
						},
						severity: 'info',
						type: 'grant.decision',
					});
					await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
					return answered(204, undefined);
				}),
				{ resources_keep_an_owner: GRANT_PROBLEMS.resourceNeedsAnOwner },
			);
		},
	};

	const revocation: ManagementOperation<GrantRevocation> = {
		administratorOnly: false,
		body: 'optional',
		event: { named: namedGrant, recordedWith, type: 'grant.revocation' },
		method: 'DELETE',
		readInput: readGrantRevocation,
		route: '/admin/grants/{id}',
		run: async ({ input, params, principal, sourceIp }) => {
			const grantId = params['id'] ?? '';
			if (!STORED_ID_FORM.test(grantId)) {
				return refused(GRANT_PROBLEMS.grantNotFound);
			}
			const now = new Date(clock.now());
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
					if (!principal.administrator && standing?.countedOwner !== true) {
						refuseWithin(GRANT_PROBLEMS.grantNotFound, GRANT_PROBLEMS.noAuthorityOnResource.code);
					}
					const grant = (await grants.readGrant(grantId)) ?? refuseWithin(GRANT_PROBLEMS.grantNotFound);
					if (grant.revokedAt !== null) {
						refuseWithin(GRANT_PROBLEMS.alreadyRevoked);
					}
					if (
						isCountedOwnerGrant(grant, now.getTime()) &&
						(await grants.countedOwnersBesides({
							grantId,
							now,
							resourceId: grant.resourceId,
						})) === 0
					) {
						refuseWithin(GRANT_PROBLEMS.resourceNeedsAnOwner);
					}
					await grants.revokeGrant({
						grantId,
						now,
						revokedBy: await grants.findOrRecordPerson(principal.subject, now),
					});
					await record({
						data: {
							category: grant.category,
							grantId,
							granteeId: grant.holderSubject,
							reason: input.reason,
							resourceId: grant.resource,
							result: 'succeeded',
							role: grant.role,
							sourceIp,
						},
						severity: 'info',
						type: 'grant.revocation',
					});
					await grantRate.count({ connection, record }, { sourceIp, subject: principal.subject });
					return answered(
						200,
						grantView({ ...grant, revokedAt: now, revokerSubject: principal.subject }, now.getTime()),
					);
				}),
				{ resources_keep_an_owner: GRANT_PROBLEMS.resourceNeedsAnOwner },
			);
		},
	};

	return [
		managementRoute(creation, dependencies),
		managementRoute(selfGrantOperation(operations), dependencies),
		managementRoute(answering, dependencies),
		managementRoute(revocation, dependencies),
		managementRoute(grantChangeOperation(operations, namedGrant), dependencies),
		managementRoute(grantRequestDecisionOperation(operations), dependencies),
		managementRoute(grantRequestListingOperation(operations), dependencies),
		managementRoute(ownGrantListingOperation(operations), dependencies),
		managementRoute(resourceGrantListingOperation(operations), dependencies),
		managementRoute(personGrantListingOperation(operations), dependencies),
		managementRoute(submitterRemovalOperation(operations), dependencies),
	];
};
