import type { RouteOptions } from 'fastify';
import pg from 'pg';

import { type Actor, eventInstant, type JsonValue } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import {
	type EventMembers,
	type InputReading,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	type NamedByRequest,
	type OperationOutcome,
	type Principal,
} from '../managementApi/index.js';
import {
	ADMINISTRATOR_PROBLEMS,
	NOMINATION_REFUSAL_REASONS,
	NOMINEE_WITHOUT_DIRECTORY,
	nomineeNotInRealm,
} from './administratorProblems.js';
import { administratorExistsOn, isPersonMet, listEveryNomination, listNominations } from './administratorStore.js';
import { readNominationDecision } from './readNominationDecision.js';
import { readNominationRequest } from './readNominationRequest.js';
import type {
	AdministratorOperationsSettings,
	NominationAnswer,
	NominationRecord,
	NominationRequest,
	NominationState,
	StoredNomination,
} from './types.js';

// An id in the form the store gives a nomination's; any other text names no nomination, and is
// never sent to the store as one.
const NOMINATION_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The refusal a nomination not pending earns, for each state it may hold but pending.
const UNANSWERABLE: Partial<Record<NominationState, Problem>> = Object.freeze({
	accepted: ADMINISTRATOR_PROBLEMS.nominationAlreadyDecided,
	declined: ADMINISTRATOR_PROBLEMS.nominationAlreadyDecided,
	replaced: ADMINISTRATOR_PROBLEMS.nominationReplaced,
	revoked: ADMINISTRATOR_PROBLEMS.nominationRevoked,
});

// A refusal reached inside a change's transaction, thrown so the transaction rolls back and nothing
// of the change is written. Its event records the reason given, where it differs from the code answered.
class RefusedWithin extends Error {
	readonly problem: Problem;

	readonly recordedReason: string | undefined;

	constructor(problem: Problem, recordedReason: string | undefined) {
		super(problem.code);
		this.problem = problem;
		this.recordedReason = recordedReason;
	}
}

const refuseWithin = (problem: Problem, recordedReason?: string): never => {
	throw new RefusedWithin(problem, recordedReason);
};

const refused = (problem: Problem, recordedReason?: string): OperationOutcome => ({
	kind: 'refused',
	problem,
	...(recordedReason === undefined ? {} : { recordedReason }),
});

const answered = (status: number, body: JsonValue): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it written.
// Any other failure is thrown on, as the store's.
const changeOutcome = (change: Promise<OperationOutcome>): Promise<OperationOutcome> =>
	change.catch((failure: unknown) => {
		if (failure instanceof RefusedWithin) {
			return refused(failure.problem, failure.recordedReason);
		}
		throw failure;
	});

const actorOf = ({ subject, type }: Principal): Actor => ({
	id: subject,
	type,
});

const noInput = (): InputReading<undefined> => ({
	input: undefined,
	kind: 'read',
});

// A nomination as every answer and listing shows it: its nominator and nominee by subject, its state,
// and the instant of its answer or of its revocation where it holds one.
const nominationView = ({
	decidedAt,
	id,
	nominatedAt,
	nominatorSubject,
	nomineeSubject,
	revokedAt,
	state,
}: NominationRecord): JsonValue => ({
	id,
	nominatedAt: eventInstant(nominatedAt.getTime()),
	nominatedBy: { subject: nominatorSubject },
	nominee: { subject: nomineeSubject },
	state,
	...(decidedAt === null ? {} : { decidedAt: eventInstant(decidedAt.getTime()) }),
	...(revokedAt === null ? {} : { revokedAt: eventInstant(revokedAt.getTime()) }),
});

/**
 * Creates the routes of the Management API's administrator operations, each answered before Usher
 * has an administrator, and each refusing a service account 403 `serviceAccountNotPermitted` before
 * anything is read. The first user nominates, lists every nomination and revokes one while it is
 * pending; the nominee answers a nomination naming them, and lists the nominations naming them.
 *
 * The nominee of a nomination is resolved before any transaction begins: the first user themself, a
 * person Usher has met, or else an account the directory finds in the trusted realm. A directory call
 * never runs while the nominations lock is held. Then each nomination and answer takes that lock in
 * its transaction, so they run one at a time across every instance: no two first administrators are
 * ever made, and a nomination replaced or revoked is never accepted. The store also refuses a second
 * answer to one nomination, whatever the code does. Every instant is read from the configured clock,
 * and a person is found by the identity of a subject under the trusted issuer.
 *
 * Nominating, `POST /admin/nominations`, is for the first user alone: a caller who is not the first
 * user is refused 403 `notFirstUser` before the body is read. Its body names the nominee, read with
 * {@link readNominationRequest}. An administrator already accepted is refused 409
 * `firstAdministratorAccepted`; then a nominee who is neither the caller nor a person Usher has met,
 * nor an account the directory finds, is refused 404 `nomineeNotFound`, its detail naming the realm,
 * or saying that no directory is configured; a directory that cannot answer is 503
 * `directoryUnavailable`. The nominee found is recorded on the finding, and the nomination appended,
 * later than every nomination before it. It is recorded as `admin.nomination` at warning and answered
 * 201 with the nomination, its state `pending`.
 *
 * Answering, `POST /admin/nominations/{nominationId}/decisions`, is for the nominee alone, its body
 * read with {@link readNominationDecision}. A malformed id is refused 404 `nominationNotFound` with the
 * reason `malformedNominationId`; an id naming no nomination, `unknownNominationId`; a nomination naming
 * someone other than the caller, or a caller never met, `nominationForSomeoneElse`, each recorded with
 * its reason. Then an administrator already accepted is refused 409 `firstAdministratorAccepted`, and a
 * nomination no longer pending 409, its code naming its state: `nominationAlreadyDecided`,
 * `nominationRevoked` or `nominationReplaced`. Accepting writes the nominee as an administrator; declining
 * records the decline. Either is recorded as `admin.nominationDecision`, at critical for an acceptance and
 * warning otherwise, and answered 200 with the nomination as it now stands.
 *
 * Revoking, `DELETE /admin/nominations/{nominationId}`, is for the first user alone. A malformed id, one
 * naming no nomination, and one the first user did not make are refused 404 `nominationNotFound` with the
 * reasons `malformedNominationId`, `unknownNominationId` and `nominationBySomeoneElse`; a nomination no
 * longer pending 409 as above. It is recorded as `admin.nominationRevocation` at warning and answered 200
 * with the nomination as it now stands.
 *
 * The listing of every nomination, `GET /admin/nominations`, is for the first user alone, oldest first.
 * The listing of the caller's own, `GET /admin/me/nominations`, answers the nominations naming the caller,
 * oldest first, each with its state; none for a caller Usher has never met. Neither records an event.
 *
 * @param operations the administrator store over a transaction's connection, the directory, the
 *   settings, the store reader and the trail, each on the control pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createAdministratorRoutes = (
	{
		administratorStoreOf,
		directory,
		settings: { clock, databaseSchema, identityProviderIssuer },
		store,
		trail,
	}: AdministratorOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const namedNomination = async ({ params }: NamedByRequest): Promise<EventMembers> => {
		const nominationId = params['nominationId'] ?? '';
		if (!NOMINATION_ID_FORM.test(nominationId)) {
			return {};
		}
		const { rows } = await store.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.nominations
                       WHERE id = $1::uuid) AS exists`,
			[nominationId],
		);
		return rows[0]?.exists === true ? { nominationId } : {};
	};

	// The refusal, or the directory's unavailability, that stops a nominee from being nominated before any
	// transaction begins; none when the nominee is the caller, a person Usher has met, or an account the
	// directory finds, which the transaction records on the finding.
	const nomineeRefusalOf = async (nomineeSubject: string, caller: string): Promise<OperationOutcome | undefined> => {
		if (nomineeSubject === caller) {
			return undefined;
		}
		if (await isPersonMet(store, databaseSchema, { issuer: identityProviderIssuer, subject: nomineeSubject })) {
			return undefined;
		}
		const reading = await directory.accountOf(nomineeSubject);
		if (reading.kind === 'held') {
			return undefined;
		}
		if (reading.kind === 'absent') {
			return refused(nomineeNotInRealm(identityProviderIssuer));
		}
		if (reading.kind === 'unconfigured') {
			return refused(NOMINEE_WITHOUT_DIRECTORY);
		}
		return { kind: 'unavailable', problem: ADMINISTRATOR_PROBLEMS.directoryUnavailable };
	};

	const nomination: ManagementOperation<NominationRequest> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'required',
		event: { named: async () => ({}), type: 'admin.nomination' },
		firstUserOnly: true,
		method: 'POST',
		readInput: (body) => readNominationRequest(body ?? {}),
		route: '/admin/nominations',
		run: async ({ input: { nomineeSubject }, principal, sourceIp }) => {
			if (await administratorExistsOn(store, databaseSchema)) {
				return refused(ADMINISTRATOR_PROBLEMS.firstAdministratorAccepted);
			}
			const refusal = await nomineeRefusalOf(nomineeSubject, principal.subject);
			if (refusal !== undefined) {
				return refusal;
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const administrators = administratorStoreOf(connection);
					await administrators.lockNominations();
					if (await administrators.administratorExists()) {
						refuseWithin(ADMINISTRATOR_PROBLEMS.firstAdministratorAccepted);
					}
					const nomineeUserId =
						nomineeSubject === principal.subject
							? undefined
							: await administrators.findOrRecordPerson(nomineeSubject, now);
					const nominatedBy = await administrators.findOrRecordPerson(principal.subject, now);
					const written = await administrators.appendNomination({
						nominatedBy,
						nomineeUserId: nomineeUserId ?? nominatedBy,
						now,
					});
					await record({
						data: {
							nominationId: written.id,
							nomineeSubject,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'warning',
						type: 'admin.nomination',
					});
					return answered(
						201,
						nominationView({
							decidedAt: null,
							id: written.id,
							nominatedAt: written.nominatedAt,
							nominatorSubject: principal.subject,
							nomineeSubject,
							revokedAt: null,
							state: 'pending',
						}),
					);
				}),
			);
		},
	};

	const decision: ManagementOperation<NominationAnswer> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'required',
		event: { named: namedNomination, type: 'admin.nominationDecision' },
		method: 'POST',
		readInput: (body) => readNominationDecision(body ?? {}),
		route: '/admin/nominations/{nominationId}/decisions',
		run: async ({ input: { decision: answer }, params, principal, sourceIp }) => {
			const nominationId = params['nominationId'] ?? '';
			if (!NOMINATION_ID_FORM.test(nominationId)) {
				return refused(
					ADMINISTRATOR_PROBLEMS.nominationNotFound,
					NOMINATION_REFUSAL_REASONS.malformedNominationId,
				);
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const administrators = administratorStoreOf(connection);
					await administrators.lockNominations();
					const nominated =
						(await administrators.readNomination(nominationId)) ??
						refuseWithin(
							ADMINISTRATOR_PROBLEMS.nominationNotFound,
							NOMINATION_REFUSAL_REASONS.unknownNominationId,
						);
					const caller =
						(await administrators.findPerson(principal.subject)) ??
						refuseWithin(
							ADMINISTRATOR_PROBLEMS.nominationNotFound,
							NOMINATION_REFUSAL_REASONS.nominationForSomeoneElse,
						);
					if (nominated.nomineeUserId !== caller) {
						refuseWithin(
							ADMINISTRATOR_PROBLEMS.nominationNotFound,
							NOMINATION_REFUSAL_REASONS.nominationForSomeoneElse,
						);
					}
					if (await administrators.administratorExists()) {
						refuseWithin(ADMINISTRATOR_PROBLEMS.firstAdministratorAccepted);
					}
					const unanswerable = UNANSWERABLE[nominated.state];
					if (unanswerable !== undefined) {
						refuseWithin(unanswerable);
					}
					if (answer === 'accepted') {
						await administrators.insertAdministrator({
							acceptedAt: now,
							nominationId,
							userId: caller,
						});
					} else {
						await administrators.declineNomination({ nominationId, now });
					}
					await record({
						data: {
							decision: answer,
							nominatedBySubject: nominated.nominatorSubject,
							nominationId,
							result: 'succeeded',
							sourceIp,
						},
						severity: answer === 'accepted' ? 'critical' : 'warning',
						type: 'admin.nominationDecision',
					});
					return answered(
						200,
						nominationView({
							...nominated,
							decidedAt: now,
							state: answer,
						}),
					);
				}),
			);
		},
	};

	const revocation: ManagementOperation<undefined> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'none',
		event: { named: namedNomination, type: 'admin.nominationRevocation' },
		firstUserOnly: true,
		method: 'DELETE',
		readInput: noInput,
		route: '/admin/nominations/{nominationId}',
		run: async ({ params, principal, sourceIp }) => {
			const nominationId = params['nominationId'] ?? '';
			if (!NOMINATION_ID_FORM.test(nominationId)) {
				return refused(
					ADMINISTRATOR_PROBLEMS.nominationNotFound,
					NOMINATION_REFUSAL_REASONS.malformedNominationId,
				);
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const administrators = administratorStoreOf(connection);
					await administrators.lockNominations();
					const nominated =
						(await administrators.readNomination(nominationId)) ??
						refuseWithin(
							ADMINISTRATOR_PROBLEMS.nominationNotFound,
							NOMINATION_REFUSAL_REASONS.unknownNominationId,
						);
					if (nominated.nominatorSubject !== principal.subject) {
						refuseWithin(
							ADMINISTRATOR_PROBLEMS.nominationNotFound,
							NOMINATION_REFUSAL_REASONS.nominationBySomeoneElse,
						);
					}
					const unanswerable = UNANSWERABLE[nominated.state];
					if (unanswerable !== undefined) {
						refuseWithin(unanswerable);
					}
					await administrators.revokeNomination({ nominationId, now });
					await record({
						data: {
							nomineeSubject: nominated.nomineeSubject,
							nominationId,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'warning',
						type: 'admin.nominationRevocation',
					});
					return answered(200, nominationView({ ...nominated, revokedAt: now, state: 'revoked' }));
				}),
			);
		},
	};

	const everyListing: ManagementOperation<undefined> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'none',
		firstUserOnly: true,
		method: 'GET',
		readInput: noInput,
		route: '/admin/nominations',
		run: async () => {
			const nominations = await listEveryNomination(store, databaseSchema, identityProviderIssuer);
			return answered(200, { nominations: nominations.map(nominationView) });
		},
	};

	const listing: ManagementOperation<undefined> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'none',
		method: 'GET',
		readInput: noInput,
		route: '/admin/me/nominations',
		run: async ({ principal }) => {
			const nominations = await listNominations(store, databaseSchema, {
				issuer: identityProviderIssuer,
				subject: principal.subject,
			});
			return answered(200, {
				nominations: nominations.map(({ id, nominatedAt, nominatorSubject, state }) => ({
					id,
					nominatedAt: eventInstant(nominatedAt.getTime()),
					nominatedBy: { subject: nominatorSubject },
					state,
				})),
			});
		},
	};

	return [
		managementRoute(nomination, dependencies),
		managementRoute(decision, dependencies),
		managementRoute(revocation, dependencies),
		managementRoute(everyListing, dependencies),
		managementRoute(listing, dependencies),
	];
};
