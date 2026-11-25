import type { RouteOptions } from 'fastify';

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
	PROBLEMS,
	type Principal,
	unreadableBody,
} from '../managementApi/index.js';
import { REVOCATION_PROBLEMS } from './revocationProblems.js';
import {
	SIGN_OUT_EVERYONE_REASONS,
	type SignOutEveryoneReason,
	PRINCIPAL_REVOCATION_REASONS,
	type PrincipalRevocationReason,
} from './reasons.js';
import type { RevocationOperationsSettings } from './types.js';

/** A principal revocation as read from its body: the subject, and the reason. */
interface PrincipalRevocationRequest {
	reason: PrincipalRevocationReason;
	subject: string;
}

/** A principal lift as read from its body: the subject. */
interface PrincipalLiftRequest {
	subject: string;
}

/** A sign-out of everyone as read from its body: its reason, the confirmation having been given. */
interface SignOutEveryoneRequest {
	reason: SignOutEveryoneReason;
}

// A change's refusal reached inside its transaction, thrown so the transaction rolls back and nothing of the
// change is written.
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

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it written. Any other
// failure is thrown on, as the store's.
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

// A member of a request as an event records it: its text when it is text, else null.

const isPrincipalReason = (value: string): value is PrincipalRevocationReason =>
	(PRINCIPAL_REVOCATION_REASONS as readonly string[]).includes(value);

const isSignOutEveryoneReason = (value: string): value is SignOutEveryoneReason =>
	(SIGN_OUT_EVERYONE_REASONS as readonly string[]).includes(value);

const refusedReading = <Input>(rule: string): InputReading<Input> => ({
	kind: 'refused',
	problem: unreadableBody(rule),
});

// A subject, read as the non-empty string an identity provider names a person by.
const subjectOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

// A revocation's body, read strictly: `subject` and `reason`, both strings. A reason outside the identity revocation
// reasons is refused 422 once the shape is read.
const readPrincipalRevocation = (
	body: Readonly<Record<string, unknown>> | undefined,
): InputReading<PrincipalRevocationRequest> => {
	const { reason, subject, ...others } = body ?? {};
	if (Object.keys(others).length > 0) {
		return refusedReading('holds a member this operation does not take: it takes subject and reason');
	}
	if (subject === undefined) {
		return refusedReading('lacks the member subject');
	}
	const subjectText = subjectOf(subject);
	if (subjectText === undefined) {
		return refusedReading('holds subject as something other than a non-empty string');
	}
	if (reason === undefined) {
		return refusedReading('lacks the member reason');
	}
	if (typeof reason !== 'string') {
		return refusedReading('holds reason as something other than a string');
	}
	if (!isPrincipalReason(reason)) {
		return { kind: 'refused', problem: REVOCATION_PROBLEMS.invalidRevocationReason };
	}
	return { input: { reason, subject: subjectText }, kind: 'read' };
};

// A lift's body, read strictly: `subject`, a non-empty string, and no other member.
const readPrincipalLift = (body: Readonly<Record<string, unknown>> | undefined): InputReading<PrincipalLiftRequest> => {
	const { subject, ...others } = body ?? {};
	if (Object.keys(others).length > 0) {
		return refusedReading('holds a member this operation does not take: it takes subject');
	}
	if (subject === undefined) {
		return refusedReading('lacks the member subject');
	}
	const subjectText = subjectOf(subject);
	if (subjectText === undefined) {
		return refusedReading('holds subject as something other than a non-empty string');
	}
	return { input: { subject: subjectText }, kind: 'read' };
};

// A sign-out of everyone's body, read strictly: `confirm`, a boolean, and `reason`, a string. Confirmation other than
// `true` and a reason outside the sign-out reasons are each refused 422 once the shape is read.
const readSignOutEveryone = (
	body: Readonly<Record<string, unknown>> | undefined,
): InputReading<SignOutEveryoneRequest> => {
	const { confirm, reason, ...others } = body ?? {};
	if (Object.keys(others).length > 0) {
		return refusedReading('holds a member this operation does not take: it takes confirm and reason');
	}
	if (confirm === undefined) {
		return refusedReading('lacks the member confirm');
	}
	if (typeof confirm !== 'boolean') {
		return refusedReading('holds confirm as something other than a boolean');
	}
	if (reason === undefined) {
		return refusedReading('lacks the member reason');
	}
	if (typeof reason !== 'string') {
		return refusedReading('holds reason as something other than a string');
	}
	if (confirm !== true) {
		return { kind: 'refused', problem: REVOCATION_PROBLEMS.notConfirmed };
	}
	if (!isSignOutEveryoneReason(reason)) {
		return { kind: 'refused', problem: REVOCATION_PROBLEMS.invalidSignOutReason };
	}
	return { input: { reason }, kind: 'read' };
};

// The subject a refused revocation or lift names, recorded beside its refusal when the body holds one: the caller's
// text is recorded only where the operation reads it as a subject.
const namedSubject = async ({ body }: NamedByRequest): Promise<EventMembers> => {
	const subject = subjectOf(body?.['subject']);
	return subject === undefined ? {} : { revokedUserSubject: subject };
};

/**
 * Creates the routes of the Management API's revocation operations: revoking a principal, lifting a principal's
 * revocation, and signing out everyone. Every operation is for platform administrators alone,
 * refused 403 `administratorOnly` before its body is read, and refuses a service account and everyone while Usher
 * has no administrator, as every Management API operation does.
 *
 * Revoking a principal reads its body first: a shape it cannot take is 400, and a reason outside the identity
 * revocation reasons is 422 `invalidRevocationReason`. Then, inside the transaction, which holds the administrators'
 * lock exclusively: the person is found, or recorded on first meeting; a standing revocation of them is 409
 * `alreadyRevoked`; a live administrator whom no other live administrator would leave Usher with is 409
 * `lastAdministrator`; otherwise the revocation is written, its partial unique index refusing a second standing one
 * as 409 `alreadyRevoked` too. It is recorded as `identity.revocation` at critical, and answered 201 with the
 * subject, reason, instant and whether Usher had met the person before.
 *
 * Lifting reads its body as a subject, then, inside the transaction, holding the lock exclusively: a subject Usher
 * has never met, or one holding no standing revocation, is 409 `notRevoked`. Otherwise the standing row is lifted,
 * kept as written, and the lift is recorded as `identity.revocationLift` at critical, answered 200 with the
 * subject, the instant the revocation was made and the instant of the lift.
 *
 * Signing out everyone reads `confirm` and `reason`: confirmation other than `true` is 422 `notConfirmed`, and a
 * reason outside the sign-out reasons is 422 `invalidSignOutReason`. The sign-out is recorded as
 * `identity.signOutEveryone` at critical, answered 201 with its reason and instant. Every sign-in token issued before
 * that instant is refused from then on. It runs under the administrators' lock shared, as the operations on grants
 * do.
 *
 * @param operations the administrator and revocation stores over a transaction's connection, the store reader, the
 *   configuration and the trail each change is made in.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createRevocationRoutes = (
	{ administratorStoreOf, revocationStoreOf, settings: { clock }, trail }: RevocationOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const revocation: ManagementOperation<PrincipalRevocationRequest> = {
		administratorOnly: true,
		body: 'required',
		event: { named: namedSubject, type: 'identity.revocation' },
		method: 'POST',
		readInput: (body) => readPrincipalRevocation(body),
		route: '/admin/people/revocations',
		run: async ({ input: { reason, subject }, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(
					actorOf(principal),
					async ({ connection, record }): Promise<OperationOutcome> => {
						const administrators = administratorStoreOf(connection);
						const revocations = revocationStoreOf(connection);
						const known = await administrators.findPerson(subject);
						const userId = known ?? (await administrators.findOrRecordPerson(subject, now));
						if ((await revocations.standingOf(userId)) !== undefined) {
							refuseWithin(REVOCATION_PROBLEMS.alreadyRevoked);
						}
						if (
							(await administrators.isAdministrator(subject)) &&
							(await administrators.countAdministrators()) <= 1
						) {
							refuseWithin(REVOCATION_PROBLEMS.lastAdministrator);
						}
						const revokedBy =
							(await administrators.findPerson(principal.subject)) ??
							refuseWithin(PROBLEMS.administratorOnly);
						if (!(await revocations.recordPrincipal({ reason, revokedAt: now, revokedBy, userId }))) {
							refuseWithin(REVOCATION_PROBLEMS.alreadyRevoked);
						}
						const seenBefore = known !== undefined;
						await record({
							data: {
								reason,
								result: 'succeeded',
								revokedUserSubject: subject,
								seenBefore,
								sourceIp,
							},
							severity: 'critical',
							type: 'identity.revocation',
						});
						return answered(201, {
							reason,
							revokedAt: eventInstant(now.getTime()),
							seenBefore,
							subject,
						});
					},
					{ exclusiveAuthority: true },
				),
			);
		},
	};

	const lift: ManagementOperation<PrincipalLiftRequest> = {
		administratorOnly: true,
		body: 'required',
		event: { named: namedSubject, type: 'identity.revocationLift' },
		method: 'POST',
		readInput: (body) => readPrincipalLift(body),
		route: '/admin/people/revocations/lifts',
		run: async ({ input: { subject }, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(
					actorOf(principal),
					async ({ connection, record }): Promise<OperationOutcome> => {
						const administrators = administratorStoreOf(connection);
						const userId =
							(await administrators.findPerson(subject)) ?? refuseWithin(REVOCATION_PROBLEMS.notRevoked);
						const liftedBy =
							(await administrators.findPerson(principal.subject)) ??
							refuseWithin(PROBLEMS.administratorOnly);
						const lifted =
							(await revocationStoreOf(connection).liftPrincipal(userId, { liftedAt: now, liftedBy })) ??
							refuseWithin(REVOCATION_PROBLEMS.notRevoked);
						await record({
							data: {
								liftedUserSubject: subject,
								reason: lifted.reason,
								result: 'succeeded',
								sourceIp,
							},
							severity: 'critical',
							type: 'identity.revocationLift',
						});
						return answered(200, {
							liftedAt: eventInstant(now.getTime()),
							revokedAt: eventInstant(lifted.revokedAt.getTime()),
							subject,
						});
					},
					{ exclusiveAuthority: true },
				),
			);
		},
	};

	const signOutEveryone: ManagementOperation<SignOutEveryoneRequest> = {
		administratorOnly: true,
		body: 'required',
		event: {
			named: async ({ body }) => {
				const reason = body?.['reason'];
				return typeof reason === 'string' && isSignOutEveryoneReason(reason) ? { reason } : {};
			},
			type: 'identity.signOutEveryone',
		},
		method: 'POST',
		readInput: (body) => readSignOutEveryone(body),
		route: '/admin/sign-outs',
		run: async ({ input: { reason }, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const signedOutBy =
						(await administratorStoreOf(connection).findPerson(principal.subject)) ??
						refuseWithin(PROBLEMS.administratorOnly);
					await revocationStoreOf(connection).recordSignOutEveryone({
						reason,
						signedOutAt: now,
						signedOutBy,
					});
					await record({
						data: { reason, result: 'succeeded', sourceIp },
						severity: 'critical',
						type: 'identity.signOutEveryone',
					});
					return answered(201, { reason, signedOutAt: eventInstant(now.getTime()) });
				}),
			);
		},
	};

	return [
		managementRoute(revocation, dependencies),
		managementRoute(lift, dependencies),
		managementRoute(signOutEveryone, dependencies),
	];
};
