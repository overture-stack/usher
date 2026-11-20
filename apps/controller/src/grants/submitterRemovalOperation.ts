import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import type {
	EventMembers,
	ManagementOperation,
	NamedByRequest,
	OperationOutcome,
	Principal,
} from '../managementApi/index.js';
import type { ResourceStanding, StandingLock } from '../resourceStanding/index.js';
import { countedWithRefusal } from './countedWithRefusal.js';
import { unresolvedByDirectory } from './directoryOutcome.js';
import { grantAuthority } from './grantAuthority.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { actorOf, answered, changeOutcome, refused, refuseWithin, roleMissing } from './operationOutcome.js';
import { readAddressLookup } from './readAddressLookup.js';
import { UNSPECIFIED_REASON } from './revocationReasons.js';
import type { AddressLookup, GrantOperationsSettings, GrantStore } from './types.js';

// The store listed each id in the change's transaction, its row locked, so it holds each grant.
const grantListed = (): never => {
	throw new ControllerError('the store gave no grant for an id it listed');
};

/**
 * How a removal naming an address held by no single account is answered, decided here alone: a
 * platform administrator is refused 404 `holderNotFound`; a counted owner is refused 409
 * `doesNotHold`, exactly as for an account holding no live submitter grant on the study, so the
 * answer never tells an owner whether an account holds an address. The event records
 * `holderNotFound` either way.
 *
 * @param caller whether the caller is a platform administrator.
 */
export const unheldSubmitterOutcome = ({ administrator }: Pick<Principal, 'administrator'>): OperationOutcome =>
	administrator
		? refused(GRANT_PROBLEMS.holderNotFound)
		: refused(GRANT_PROBLEMS.notASubmitter, GRANT_PROBLEMS.holderNotFound.code);

/**
 * The operation removing a submitter from a study by address, `POST
 * /admin/resources/{externalId}/submitters/removal`, its body read with {@link readAddressLookup},
 * so an address out of an address's form is refused 422 before anything is read. Platform
 * administrators and the study's counted owners remove submitters: the caller's standing is judged
 * as a creation of a submitter grant judges it, in a transaction writing nothing, alike whatever
 * the address, and only then is the address resolved through the directory, outside any
 * transaction. A directory resolving nothing is answered as {@link unresolvedByDirectory} decides,
 * and an address held by no single account as {@link unheldSubmitterOutcome} decides.
 *
 * For the account holding the address, every live `submitter` grant it holds on the study, in any
 * category, is revoked in one transaction, the standing judged again on the resource's row locked
 * before the grants', the caller their revoker, recorded on first meeting them, each recorded as
 * `grant.revocation` with reason `unspecified`; another role's grant is left as it is. An account
 * holding none is refused 409 `doesNotHold`. The removal is answered 204, naming nothing. Its
 * event, refused or failed, names the study when a resource holds the externalId. Each request is
 * counted against the grant rate by its caller, as the last step of the transaction revoking its
 * grants, or in the transaction recording its refusal or failure.
 *
 * @param operations the grant rate, the grant store over a transaction's connection, the directory,
 *   the clock, the schema, the store reader and the trail.
 */
export const submitterRemovalOperation = ({
	directory,
	grantRate,
	grantStoreOf,
	settings: { clock, databaseSchema },
	store,
	trail,
}: GrantOperationsSettings): ManagementOperation<AddressLookup> => {
	const namedStudy = async ({ params }: NamedByRequest): Promise<EventMembers> => {
		const externalId = params['externalId'] ?? '';
		const { rows } = await store.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.resources
                       WHERE external_id = $1) AS exists`,
			[externalId],
		);
		return rows[0]?.exists === true ? { resourceId: externalId } : {};
	};

	// The caller's standing on the study, refused as a creation of a submitter grant would be.
	const studyOf = async (
		grants: GrantStore,
		{
			externalId,
			lock,
			now,
			principal,
		}: {
			externalId: string;
			lock: StandingLock;
			now: Date;
			principal: Principal;
		},
	): Promise<ResourceStanding> => {
		const standing = await grants.readStanding({
			externalId,
			lock,
			now,
			subject: principal.subject,
		});
		const authority = grantAuthority({
			administrator: principal.administrator,
			holderIsCaller: false,
			orphaned: false,
			role: 'submitter',
			standing,
		});
		if (authority.kind === 'refuse') {
			refuseWithin(authority.problem, authority.recordedReason);
		}
		return standing ?? refuseWithin(GRANT_PROBLEMS.resourceNotFound);
	};

	return {
		administratorOnly: false,
		body: 'required',
		event: {
			named: namedStudy,
			recordedWith: countedWithRefusal({ grantRate }),
			type: 'grant.revocation',
		},
		method: 'POST',
		readInput: (body) => readAddressLookup(body),
		route: '/admin/resources/{externalId}/submitters/removal',
		run: async ({ input, params, principal, sourceIp }) => {
			const asked = {
				externalId: params['externalId'] ?? '',
				now: new Date(clock.now()),
				principal,
			};
			const { now } = asked;
			const judged = await changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection }) => ({
					kind: 'judged' as const,
					study: await studyOf(grantStoreOf(connection), {
						...asked,
						lock: 'none',
					}),
				})),
			);
			if (judged.kind === 'refused') {
				return judged;
			}
			const resolution = await directory.resolveAddress(input.email);
			if (resolution.kind === 'unavailable' || resolution.kind === 'unconfigured') {
				return unresolvedByDirectory(resolution, 'grantById');
			}
			if (resolution.kind === 'unheld') {
				return unheldSubmitterOutcome(principal);
			}
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const grants = grantStoreOf(connection);
					const study = await studyOf(grants, {
						...asked,
						lock: 'noKeyUpdate',
					});
					const role = (await grants.findRole('submitter')) ?? roleMissing();
					const holderUserId = await grants.findPerson(resolution.subject);
					const grantIds =
						holderUserId === undefined
							? []
							: await grants.liveGrantIdsOf({
									holderUserId,
									now,
									resourceId: study.id,
									roleId: role.id,
								});
					if (grantIds.length === 0) {
						refuseWithin(GRANT_PROBLEMS.notASubmitter);
					}
					const revokedBy = await grants.findOrRecordPerson(principal.subject, now);
					await grantIds.reduce<Promise<unknown>>(
						(earlier, grantId) =>
							earlier.then(async () => {
								const grant = (await grants.readGrant(grantId)) ?? grantListed();
								await grants.revokeGrant({ grantId, now, revokedBy });
								await record({
									data: {
										category: grant.category,
										grantId,
										granteeId: grant.holderSubject,
										reason: UNSPECIFIED_REASON,
										resourceId: grant.resource,
										result: 'succeeded',
										role: grant.role,
										sourceIp,
									},
									severity: 'info',
									type: 'grant.revocation',
								});
							}),
						Promise.resolve(),
					);
					await grantRate.count({ connection, record }, principal.subject);
					return answered(204, undefined);
				}),
			);
		},
	};
};
