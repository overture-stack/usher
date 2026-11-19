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
import { ADMINISTRATOR_PROBLEMS } from './administratorProblems.js';
import { listNominations } from './administratorStore.js';
import { readNominationRequest } from './readNominationRequest.js';
import type { AdministratorOperationsSettings, NominationRequest } from './types.js';

// An id in the form the store gives a nomination's; any other text names no nomination, and is
// never sent to the store as one.
const NOMINATION_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A refusal reached inside a change's transaction, thrown so the transaction rolls back and nothing
// of the change is written, a person first met in it included.
class RefusedWithin extends Error {
	readonly problem: Problem;

	constructor(problem: Problem) {
		super(problem.code);
		this.problem = problem;
	}
}

const refuseWithin = (problem: Problem): never => {
	throw new RefusedWithin(problem);
};

const refused = (problem: Problem): OperationOutcome => ({
	kind: 'refused',
	problem,
});

const answered = (status: number, body: JsonValue): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it
// written. Any other failure is thrown on, as the store's.
const changeOutcome = (change: Promise<OperationOutcome>): Promise<OperationOutcome> =>
	change.catch((failure: unknown) => {
		if (failure instanceof RefusedWithin) {
			return refused(failure.problem);
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

/**
 * Creates the routes of the Management API's administrator operations, each answered before Usher
 * has an administrator, and each refusing a service account 403 `serviceAccountNotPermitted` before
 * anything is read: the first user nominating the first administrator, the nominee accepting, and a
 * nominee listing the nominations naming them. A nomination and an acceptance each take one lock
 * first, held until their transaction ends, so they run one at a time across every instance: no two
 * first administrators are ever made, and a nomination replaced is never accepted. Every instant is
 * read from the configured clock, and a person is found by the identity of a subject under the
 * trusted issuer.
 *
 * Nominating, `POST /admin/nominations`, is for the first user alone: a caller who is not the first
 * user is refused 403 `notFirstUser` before the body is read. Its body names the
 * nominee, read with {@link readNominationRequest}. Then an administrator already accepted is
 * refused 409 `firstAdministratorAccepted`; only then is a nominee who is neither the caller nor a
 * person Usher has met refused 404 `nomineeNotFound`. The caller is recorded on first meeting, as a
 * base user. A nomination is appended, later than every nomination before it, so the latest
 * replaces each earlier one; it is recorded as `admin.nomination` at warning and answered 201.
 *
 * Accepting, `POST /admin/nominations/{id}/acceptance`, answers a malformed id, an id naming no
 * nomination, and a nomination naming someone other than the caller 404 `nominationNotFound` alike;
 * then an administrator already accepted 409 `firstAdministratorAccepted`, and a nomination a later
 * one has replaced 409 `nominationSuperseded`. The nominee is written as an administrator, recorded
 * as `admin.acceptance` at critical, and answered 200.
 *
 * The listing, `GET /admin/me/nominations`, answers the nominations naming the caller, oldest
 * first, each saying whether it is the latest; none for a caller Usher has never met. It records no
 * event.
 *
 * @param operations the administrator store over a transaction's connection, the settings, the
 *   store reader and the trail, each on the control pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createAdministratorRoutes = (
	{
		administratorStoreOf,
		settings: { clock, databaseSchema, identityProviderIssuer },
		store,
		trail,
	}: AdministratorOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const namedNomination = async ({ params }: NamedByRequest): Promise<EventMembers> => {
		const nominationId = params['id'] ?? '';
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

	const nomination: ManagementOperation<NominationRequest> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'required',
		event: { named: async () => ({}), type: 'admin.nomination' },
		firstUserOnly: true,
		method: 'POST',
		readInput: (body) => readNominationRequest(body ?? {}),
		route: '/admin/nominations',
		run: ({ input: { nomineeSubject }, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const administrators = administratorStoreOf(connection);
					await administrators.lockNominations();
					if (await administrators.administratorExists()) {
						refuseWithin(ADMINISTRATOR_PROBLEMS.firstAdministratorAccepted);
					}
					const nomineeId =
						nomineeSubject === principal.subject
							? undefined
							: ((await administrators.findPerson(nomineeSubject)) ??
								refuseWithin(ADMINISTRATOR_PROBLEMS.nomineeNotFound));
					const nominatedBy = await administrators.findOrRecordPerson(principal.subject, now);
					const written = await administrators.appendNomination({
						nominatedBy,
						nomineeId: nomineeId ?? nominatedBy,
						now,
					});
					await record({
						data: {
							nominationId: written.id,
							nomineeId: nomineeSubject,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'warning',
						type: 'admin.nomination',
					});
					return answered(201, {
						id: written.id,
						nominatedAt: eventInstant(written.nominatedAt.getTime()),
						nominatedBy: { subject: principal.subject },
						nominee: { subject: nomineeSubject },
					});
				}),
			);
		},
	};

	const acceptance: ManagementOperation<undefined> = {
		administratorOnly: false,
		beforeFirstAdministrator: true,
		body: 'none',
		event: { named: namedNomination, type: 'admin.acceptance' },
		method: 'POST',
		readInput: noInput,
		route: '/admin/nominations/{id}/acceptance',
		run: async ({ params, principal, sourceIp }) => {
			const nominationId = params['id'] ?? '';
			if (!NOMINATION_ID_FORM.test(nominationId)) {
				return refused(ADMINISTRATOR_PROBLEMS.nominationNotFound);
			}
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const administrators = administratorStoreOf(connection);
					await administrators.lockNominations();
					const caller = await administrators.findPerson(principal.subject);
					const nominated = await administrators.readNomination(nominationId);
					if (caller === undefined || nominated === undefined || nominated.nomineeId !== caller) {
						return refuseWithin(ADMINISTRATOR_PROBLEMS.nominationNotFound);
					}
					if (await administrators.administratorExists()) {
						refuseWithin(ADMINISTRATOR_PROBLEMS.firstAdministratorAccepted);
					}
					if (!nominated.latest) {
						refuseWithin(ADMINISTRATOR_PROBLEMS.nominationSuperseded);
					}
					await administrators.insertAdministrator({
						acceptedAt: now,
						nominationId,
						userId: caller,
					});
					await record({
						data: {
							nominatedById: nominated.nominatorSubject,
							nominationId,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'critical',
						type: 'admin.acceptance',
					});
					return answered(200, {
						acceptedAt: eventInstant(now.getTime()),
						administrator: { subject: principal.subject },
						nominationId,
					});
				}),
			);
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
				nominations: nominations.map(({ id, latest, nominatedAt, nominatorSubject }) => ({
					id,
					latest,
					nominatedAt: eventInstant(nominatedAt.getTime()),
					nominatedBy: { subject: nominatorSubject },
				})),
			});
		},
	};

	return [
		managementRoute(nomination, dependencies),
		managementRoute(acceptance, dependencies),
		managementRoute(listing, dependencies),
	];
};
