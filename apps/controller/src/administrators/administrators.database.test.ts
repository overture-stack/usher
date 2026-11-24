import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	assertRefused,
	type AdminResponse,
	assertSucceeded,
	createGrant,
	decideNomination,
	firstUserCaller,
	instantOf,
	listAdministrators,
	listNominations,
	listOwnNominations,
	nominate,
	personCaller,
	PROBLEMS,
	readLiveness,
	readReadiness,
	registerResource,
	removeAdministrator,
	revokeNomination,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { captureLog } from '../../testing/harness/controller.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import { exchange, PEOPLE, type Person, SYSTEM_CLOCK } from '../../testing/harness/exchange.js';
import {
	administratorRow,
	ANA_ACTING,
	committedInsert,
	committedQuery,
	INSUFFICIENT_PRIVILEGE,
	INTEGRITY,
	nominationRow,
	openSeededDatabase,
	selectRows,
	stewardOf,
	violation,
	writeOutcome,
} from '../../testing/fixtures/database.js';
import {
	HARNESS_MANAGEMENT_CLIENT,
	type Harness,
	type HarnessOptions,
	withHarness,
} from '../../testing/harness/harness.js';
import { mintServiceAccountToken } from '../../testing/peripherals/identityProvider.js';
import { inTurn, POLICY_TABLES, qualified, seededId, usersWithSubject } from '../../testing/harness/policy.js';
import { type Actor, type AuditEvent, type AuditTrail, createAuditTrail } from '../eventLog/index.js';
import { AdministratorStatusWithdrawn, withAdministratorAuthority } from '../managementApi/index.js';
import { sqlAdministratorStore } from './administratorStore.js';
import { confirmAdministratorAuthority } from './confirmAdministratorAuthority.js';

const { administratorRemovals, administrators, grants, nominationDeclines, nominationRevocations, nominations } =
	POLICY_TABLES;

// A store holding no administrator, as before the first user's nomination is accepted, its
// Controller registering no application, which only an administrator may; Bo and Cy have met Usher.
const BEFORE_THE_FIRST: HarnessOptions = {
	applications: [],
	// Longer than the nominations hold each test here takes: a request waiting on it succeeds.
	configuration: { storeTimeoutMilliseconds: 15_000 },
	fixture: {
		users: {
			bo: { subject: PEOPLE.bo.subject },
			cy: { subject: PEOPLE.cy.subject },
		},
	},
	seedsAdministrator: false,
};

const FIRST_USER = PEOPLE.ana;

// The same store, with Dana and Eli met by Usher as well, so each can be nominated.
const NOMINEES_MET_BY_USHER: HarnessOptions = {
	...BEFORE_THE_FIRST,
	fixture: {
		users: {
			bo: { subject: PEOPLE.bo.subject },
			cy: { subject: PEOPLE.cy.subject },
			dana: { subject: PEOPLE.dana.subject },
			eli: { subject: PEOPLE.eli.subject },
		},
	},
};

const study = (externalId: string) => ({
	accessLevel: 'grant' as const,
	displayName: `Study ${externalId}`,
	externalId,
});

const nominationOf = (answer: AdminResponse, label: string): string => {
	assertSucceeded(answer, label);
	const id = Reflect.get(Object(answer.body), 'id');
	return typeof id === 'string' ? id : assert.fail(`${label} named no id`);
};

const nominated = async (harness: Harness, nominee: Person): Promise<string> =>
	nominationOf(
		await nominate(await firstUserCaller(harness, FIRST_USER), {
			nominee: { subject: nominee.subject },
		}),
		`nominating ${nominee.email}`,
	);

const accepted = async (harness: Harness, nominee: Person, nominationId: string): Promise<AdminResponse> =>
	decideNomination(await personCaller(harness, nominee), nominationId, 'accept');

const rowCount = async (harness: Harness, table: { name: string }): Promise<number> =>
	(
		await selectRows<{ count: number }>(
			harness.clients.migration,
			`SELECT count(*)::int AS count FROM ${qualified(table)}`,
		)
	)[0]?.count ?? 0;

const eventsOfType = async (harness: Harness, type: string): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(type))
		.map((row) => ({ ...dataOf(row), severity: row.severity }));

const outcomeOf = ({ problem, status }: AdminResponse): readonly unknown[] => [status, problem?.code];

// Sends the first request, waits until it is blocked on the held table, sends the second and waits
// until it is blocked too, then lets the table go: the first request holds the order's lock while
// it waits on the table, so the second waits on the first.
const inOrderBehindHeldNominations = async (
	harness: Harness,
	first: () => Promise<AdminResponse>,
	second: () => Promise<AdminResponse>,
): Promise<readonly AdminResponse[]> => {
	const held = await holdTable(harness.database, nominations);
	const sentFirst = first();
	const firstBlocked = await untilBlocked(harness.clients.migration, sentFirst);
	const sentSecond = second();
	const bothBlocked = await untilBlocked(harness.clients.migration, sentSecond, { count: 2 });
	await held.release();
	const answers = await Promise.all([sentFirst, sentSecond]);
	assert.ok(firstBlocked && bothBlocked, 'both requests waited in turn');
	return answers;
};

// The code PL/pgSQL raises a history rule's refusal with, naming the rule as its constraint.
const HISTORY_KEPT_CODE = '23000';

suite("the store's administrators and their nominations", () => {
	test('makes an administrator only of the nominee of the nomination they accept, and each person one once', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const cy = seededId(seeded.users, 'cy');
		const bo = seededId(seeded.users, 'bo');
		const nominated = (nomineeUserId: string, at: Date): Promise<string> =>
			committedInsert(
				owner,
				nominations,
				nominationRow({ nominatedAt: at, nominatedBy: steward, nomineeId: nomineeUserId }),
			).then((row) => String(row[nominations.columns.id]));
		const cyFirst = await nominated(cy, new Date(Date.now() - 2000));
		const cySecond = await nominated(cy, new Date(Date.now() - 1000));

		const outcomes = await inTurn(
			[
				administratorRow({ nominationId: cyFirst, userId: bo }),
				administratorRow({ nominationId: cyFirst, userId: cy }),
				administratorRow({ nominationId: cyFirst, userId: cy }),
				administratorRow({ nominationId: cySecond, userId: cy }),
			],
			(row) => writeOutcome(committedInsert(owner, administrators, row)),
		);

		// A second live row for a person is refused by the trigger administrator_held_once, which raises in the
		// integrity class, before the key is checked.
		assert.deepEqual(outcomes, [INTEGRITY.foreignKey, 'accepted', HISTORY_KEPT_CODE, HISTORY_KEPT_CODE]);
	});

	test('gives no two nominations one instant, so one of them is always the latest', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const at = new Date();
		const row = (name: string) =>
			nominationRow({
				nominatedAt: at,
				nominatedBy: steward,
				nomineeId: seededId(seeded.users, name),
			});

		await committedInsert(owner, nominations, row('bo'));

		await assert.rejects(
			committedInsert(owner, nominations, row('cy')),
			violation(INTEGRITY.unique, 'nominations_nominated_at_key'),
		);
	});

	test("keeps every nomination as written and every administrator in place, for the schema's owner too", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		const nominationId = String(
			(
				await committedInsert(
					owner,
					nominations,
					nominationRow({ nominatedBy: stewardOf(seeded), nomineeId: cy }),
				)
			)[nominations.columns.id],
		);
		await committedInsert(owner, administrators, administratorRow({ nominationId, userId: cy }));

		await assert.rejects(
			committedQuery(
				owner,
				`UPDATE ${qualified(nominations)} SET ${nominations.columns.nomineeId} = ${nominations.columns.nominatedBy}`,
			),
			violation(HISTORY_KEPT_CODE, 'nominations_kept'),
		);
		await assert.rejects(
			committedQuery(owner, `DELETE FROM ${qualified(administrators)}`),
			violation(HISTORY_KEPT_CODE, 'administrators_kept'),
		);
		await assert.rejects(
			committedQuery(owner, `DELETE FROM ${qualified(nominations)}`),
			violation(HISTORY_KEPT_CODE, 'nominations_kept'),
		);
		assert.deepEqual(
			await selectRows(
				owner,
				`SELECT ${administrators.columns.userId} AS "userId" FROM ${qualified(administrators)}`,
			),
			[{ userId: cy }],
		);
	});

	test("lets the controller's role insert and read nominations and administrators, and neither change nor delete either", async (context) => {
		const { database, seeded } = await openSeededDatabase(context);
		const controller = await database.connect('runtime');
		const ana = seededId(seeded.users, 'ana');

		const nominated = await committedInsert(
			controller,
			nominations,
			nominationRow({ nominatedBy: ana, nomineeId: ana }),
			ANA_ACTING,
		);
		const accepted = await writeOutcome(
			committedInsert(
				controller,
				administrators,
				administratorRow({
					nominationId: String(nominated[nominations.columns.id]),
					userId: ana,
				}),
				ANA_ACTING,
			),
		);
		const read = await inTurn([nominations, administrators], (table) =>
			writeOutcome(controller.query(`SELECT * FROM ${qualified(table)}`)),
		);
		const rewrites = await inTurn(
			[
				`UPDATE ${qualified(nominations)} SET ${nominations.columns.nominatedAt} = now()`,
				`DELETE FROM ${qualified(nominations)}`,
				`UPDATE ${qualified(administrators)} SET ${administrators.columns.acceptedAt} = now()`,
				`DELETE FROM ${qualified(administrators)}`,
			],
			(text) => writeOutcome(committedQuery(controller, text, [], ANA_ACTING)),
		);

		assert.equal(accepted, 'accepted');
		assert.deepEqual(read, ['accepted', 'accepted']);
		assert.deepEqual(
			rewrites,
			rewrites.map(() => INSUFFICIENT_PRIVILEGE),
		);
	});
});

suite('the Management API before the first administrator accepts', () => {
	test("refuses every operation but the first administrator's 403 noAdministratorYet, a service account's included, recording each, while health and the exchange answer as usual", async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const answers = [
					await registerResource(await firstUserCaller(harness, FIRST_USER), study('STUDY-G1')),
					await createGrant(await personCaller(harness, PEOPLE.bo), {
						holder: { subject: PEOPLE.cy.subject },
						resource: 'STUDY-G1',
						role: 'viewer',
					}),
					await registerResource(
						harness.caller(
							await mintServiceAccountToken(harness.identityProvider, harness.configuration, {
								clientId: HARNESS_MANAGEMENT_CLIENT,
							}),
						),
						study('STUDY-G2'),
					),
				];
				const exchanged = await exchange(harness.url, {
					application: {
						id: randomUUID(),
						key: randomBytes(32).toString('base64url'),
					},
				});

				assert.deepEqual(answers.map(outcomeOf), [
					[403, 'noAdministratorYet'],
					[403, 'noAdministratorYet'],
					[403, 'noAdministratorYet'],
				]);
				assert.match(answers[0]?.problem?.detail ?? '', /POST \/admin\/nominations/u);
				assert.deepEqual(
					[
						(await readReadiness(harness.url)).status,
						(await readLiveness(harness.url)).status,
						exchanged.status,
					],
					[200, 200, 401],
				);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.resourceRegistration)).map((data) => [
						data['reason'],
						data['result'],
						data['severity'],
					]),
					[
						['noAdministratorYet', 'denied', 'warning'],
						['noAdministratorYet', 'denied', 'warning'],
					],
				);
			},
			context,
		);
	});
});

suite("nominating and accepting Usher's first administrator", () => {
	test('makes the first user their own nominee, recorded on first meeting as a base user holding no grant, and an administrator once they accept, recording each step', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const client = harness.clients.migration;
				const before = await usersWithSubject(client, FIRST_USER.subject);
				const first = await firstUserCaller(harness, FIRST_USER);

				const nomination = await nominate(first, {
					nominee: { subject: FIRST_USER.subject },
				});
				const nominationId = nominationOf(nomination, 'the nomination');
				const met = await usersWithSubject(client, FIRST_USER.subject);
				const grantsHeld = await rowCount(harness, grants);
				const acceptance = await decideNomination(first, nominationId, 'accept');
				const registered = await registerResource(first, study('STUDY-F1'));

				assert.deepEqual([before, met, grantsHeld], [0, 1, 0]);
				assert.equal(nomination.status, 201);
				assert.deepEqual(
					{
						...Object(nomination.body),
						nominatedAt: instantOf(Reflect.get(Object(nomination.body), 'nominatedAt')) > 0,
					},
					{
						id: nominationId,
						nominatedAt: true,
						nominatedBy: { subject: FIRST_USER.subject },
						nominee: { subject: FIRST_USER.subject },
						state: 'pending',
					},
				);
				assert.equal(acceptance.status, 200);
				assert.deepEqual(
					{
						...Object(acceptance.body),
						decidedAt: instantOf(Reflect.get(Object(acceptance.body), 'decidedAt')) > 0,
						nominatedAt: instantOf(Reflect.get(Object(acceptance.body), 'nominatedAt')) > 0,
					},
					{
						decidedAt: true,
						id: nominationId,
						nominatedAt: true,
						nominatedBy: { subject: FIRST_USER.subject },
						nominee: { subject: FIRST_USER.subject },
						state: 'accepted',
					},
				);
				assert.equal(registered.status, 201);
				assert.deepEqual(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNomination), [
					{
						actorId: FIRST_USER.subject,
						actorType: 'human',
						instance: harness.configuration.instanceName,
						nominationId,
						nomineeSubject: FIRST_USER.subject,
						result: 'succeeded',
						severity: 'warning',
						sourceIp: '127.0.0.1',
					},
				]);
				assert.deepEqual(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNominationDecision), [
					{
						actorId: FIRST_USER.subject,
						actorType: 'human',
						decision: 'accepted',
						instance: harness.configuration.instanceName,
						nominatedBySubject: FIRST_USER.subject,
						nominationId,
						result: 'succeeded',
						severity: 'critical',
						sourceIp: '127.0.0.1',
					},
				]);
			},
			context,
		);
	});

	test('reads admin status from the store on every request, so a token minted before the acceptance acts as an administrator after it, and the first-user role confers nothing once one has accepted', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const boEarly = await personCaller(harness, PEOPLE.bo);
				const first = await firstUserCaller(harness, FIRST_USER);
				const nominationId = await nominated(harness, PEOPLE.bo);
				const before = await registerResource(boEarly, study('STUDY-B1'));

				assertSucceeded(await decideNomination(boEarly, nominationId, 'accept'), 'the acceptance');

				const after = await registerResource(boEarly, study('STUDY-B2'));
				const byFirstUser = await registerResource(first, study('STUDY-B3'));
				const nominatingAgain = await nominate(first, {
					nominee: { subject: PEOPLE.cy.subject },
				});

				assertRefused(before, PROBLEMS.noAdministratorYet, 'before');
				assert.equal(after.status, 201);
				assertRefused(byFirstUser, PROBLEMS.administratorOnly, 'first user');
				assertRefused(
					nominatingAgain,
					PROBLEMS.administratorOnly,
					'a nomination by the first user after the acceptance',
				);
			},
			context,
		);
	});

	test('refuses a nomination by a token lacking the first-user role 403 notFirstUser, and a nominee Usher has never met 404 nomineeNotFound, writing nothing of either, the first user included', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const client = harness.clients.migration;
				const answers = [
					await nominate(await personCaller(harness, PEOPLE.bo), {
						nominee: { subject: PEOPLE.bo.subject },
					}),
					await nominate(await firstUserCaller(harness, FIRST_USER), {
						nominee: { subject: PEOPLE.dana.subject },
					}),
				];

				assert.deepEqual(answers.map(outcomeOf), [
					[403, 'notFirstUser'],
					[404, 'nomineeNotFound'],
				]);
				assert.deepEqual(
					[
						await rowCount(harness, nominations),
						await usersWithSubject(client, FIRST_USER.subject),
						await usersWithSubject(client, PEOPLE.dana.subject),
					],
					[0, 0, 0],
				);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNomination)).map((data) => [
						data['actorId'],
						data['reason'],
						data['severity'],
					]),
					[
						[PEOPLE.bo.subject, 'notFirstUser', 'warning'],
						[FIRST_USER.subject, 'nomineeNotFound', 'warning'],
					],
				);
			},
			context,
		);
	});

	test('lets the first user nominate again until one accepts, shows each nominee the nominations naming them with their states, and accepts the latest alone', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const toCy = await nominated(harness, PEOPLE.cy);
				const toBoAgain = await nominated(harness, PEOPLE.bo);
				const listed = async (person: Person): Promise<unknown> => {
					const answer = await listOwnNominations(await personCaller(harness, person));
					assertSucceeded(answer, `listing ${person.email}'s nominations`);
					return (Reflect.get(Object(answer.body), 'nominations') as readonly unknown[]).map(
						(nomination) => ({
							id: Reflect.get(Object(nomination), 'id'),
							nominatedBy: Reflect.get(Object(nomination), 'nominatedBy'),
							state: Reflect.get(Object(nomination), 'state'),
						}),
					);
				};
				const byFirstUser = { subject: FIRST_USER.subject };

				const boBefore = await listed(PEOPLE.bo);
				const cyBefore = await listed(PEOPLE.cy);
				const refusals = [
					await accepted(harness, PEOPLE.cy, toCy),
					await accepted(harness, PEOPLE.bo, toBo),
					await accepted(harness, PEOPLE.cy, toBoAgain),
				];
				const acceptance = await accepted(harness, PEOPLE.bo, toBoAgain);
				const boAfter = await listed(PEOPLE.bo);

				assert.deepEqual(boBefore, [
					{ id: toBo, nominatedBy: byFirstUser, state: 'replaced' },
					{ id: toBoAgain, nominatedBy: byFirstUser, state: 'pending' },
				]);
				assert.deepEqual(cyBefore, [{ id: toCy, nominatedBy: byFirstUser, state: 'replaced' }]);
				assert.deepEqual(refusals.map(outcomeOf), [
					[409, 'nominationReplaced'],
					[409, 'nominationReplaced'],
					[404, 'nominationNotFound'],
				]);
				assert.equal(acceptance.status, 200);
				assert.deepEqual(boAfter, [
					{ id: toBo, nominatedBy: byFirstUser, state: 'replaced' },
					{ id: toBoAgain, nominatedBy: byFirstUser, state: 'accepted' },
				]);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNominationDecision)).map((data) => [
						data['result'],
						data['reason'],
						data['nominationId'],
					]),
					[
						['denied', 'nominationReplaced', toCy],
						['denied', 'nominationReplaced', toBo],
						['denied', 'nominationForSomeoneElse', toBoAgain],
						['succeeded', undefined, toBoAgain],
					],
				);
			},
			context,
		);
	});
});

suite('nominations and acceptances, serialized', () => {
	test("refuses a first user's nomination sent behind an acceptance 403 administratorOnly, so the nomination accepted was the latest", async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const first = await firstUserCaller(harness, FIRST_USER);

				const [acceptance, nomination] = await inOrderBehindHeldNominations(
					harness,
					() => accepted(harness, PEOPLE.bo, toBo),
					() => nominate(first, { nominee: { subject: PEOPLE.cy.subject } }),
				);

				assert.deepEqual(
					[acceptance, nomination].map((answer) => answer?.status),
					[200, 403],
				);
				assert.equal(nomination?.problem?.code, PROBLEMS.administratorOnly.code);
				assert.deepEqual(
					[await rowCount(harness, administrators), await rowCount(harness, nominations)],
					[1, 1],
				);
			},
			context,
		);
	});

	test('refuses an answer sent while a later nomination holds the order 409 nominationReplaced, so no nomination replaced is ever accepted', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const first = await firstUserCaller(harness, FIRST_USER);

				const [nomination, acceptance] = await inOrderBehindHeldNominations(
					harness,
					() => nominate(first, { nominee: { subject: PEOPLE.cy.subject } }),
					() => accepted(harness, PEOPLE.bo, toBo),
				);

				assert.deepEqual(
					[nomination, acceptance].map((answer) => answer?.status),
					[201, 409],
				);
				assert.equal(acceptance?.problem?.code, PROBLEMS.nominationReplaced.code);
				assert.equal(await rowCount(harness, administrators), 0);
			},
			context,
		);
	});

	test('makes one administrator of two acceptances of one nomination sent at once, refusing the second 409 nominationAlreadyDecided', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);

				const answers = await inOrderBehindHeldNominations(
					harness,
					() => accepted(harness, PEOPLE.bo, toBo),
					() => accepted(harness, PEOPLE.bo, toBo),
				);

				assert.deepEqual(answers.map(outcomeOf), [
					[200, undefined],
					[409, 'nominationAlreadyDecided'],
				]);
				assert.equal(await rowCount(harness, administrators), 1);
			},
			context,
		);
	});
});

// The nominations of a listing answer, each as the first user's listing shows it.
const listedOf = (answer: AdminResponse): readonly Readonly<Record<string, unknown>>[] => {
	assertSucceeded(answer, 'the listing');
	return Reflect.get(Object(answer.body), 'nominations') as readonly Readonly<Record<string, unknown>>[];
};

suite("a nominee's answer and the first user's revocation, as the store keeps them", () => {
	test('lets the nominee decline a pending nomination once, keeping the decline as its own row, lists it declined with its instant, and refuses each later answer 409 nominationAlreadyDecided', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const declined = await decideNomination(await personCaller(harness, PEOPLE.bo), toBo, 'decline');
				const laterAccept = await accepted(harness, PEOPLE.bo, toBo);
				const laterDecline = await decideNomination(await personCaller(harness, PEOPLE.bo), toBo, 'decline');
				const listed = listedOf(await listNominations(await firstUserCaller(harness, FIRST_USER)));

				assert.equal(declined.status, 200);
				assert.deepEqual([laterAccept, laterDecline].map(outcomeOf), [
					[409, 'nominationAlreadyDecided'],
					[409, 'nominationAlreadyDecided'],
				]);
				assert.deepEqual(
					[await rowCount(harness, nominationDeclines), await rowCount(harness, administrators)],
					[1, 0],
				);
				assert.deepEqual(
					listed.map(({ id, state, decidedAt, revokedAt }) => ({
						decided: decidedAt !== undefined,
						id,
						revoked: revokedAt !== undefined,
						state,
					})),
					[{ decided: true, id: toBo, revoked: false, state: 'declined' }],
				);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNominationDecision)).map((data) => [
						data['decision'],
						data['result'],
						data['reason'],
						data['severity'],
					]),
					[
						['declined', 'succeeded', undefined, 'warning'],
						[undefined, 'denied', 'nominationAlreadyDecided', 'warning'],
						[undefined, 'denied', 'nominationAlreadyDecided', 'warning'],
					],
				);
			},
			context,
		);
	});

	test('lets the first user revoke a pending nomination, refuses its answer and a second revocation 409 nominationRevoked, refuses a revocation by anyone else 403 notFirstUser, and lists it revoked', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const first = await firstUserCaller(harness, FIRST_USER);
				const revoked = await revokeNomination(first, toBo);

				const refusals = [
					await accepted(harness, PEOPLE.bo, toBo),
					await revokeNomination(first, toBo),
					await revokeNomination(await personCaller(harness, PEOPLE.bo), toBo),
				];
				const listed = listedOf(await listNominations(first));

				assert.equal(revoked.status, 200);
				assert.deepEqual(refusals.map(outcomeOf), [
					[409, 'nominationRevoked'],
					[409, 'nominationRevoked'],
					[403, 'notFirstUser'],
				]);
				assert.deepEqual(
					[await rowCount(harness, nominationRevocations), await rowCount(harness, administrators)],
					[1, 0],
				);
				assert.deepEqual(
					listed.map(({ id, state, decidedAt, revokedAt }) => ({
						decided: decidedAt !== undefined,
						id,
						revoked: revokedAt !== undefined,
						state,
					})),
					[{ decided: false, id: toBo, revoked: true, state: 'revoked' }],
				);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNominationRevocation)).map((data) => [
						data['result'],
						data['reason'],
						data['severity'],
					]),
					[
						['succeeded', undefined, 'warning'],
						['denied', 'nominationRevoked', 'warning'],
						['denied', 'notFirstUser', 'warning'],
					],
				);
			},
			context,
		);
	});

	test("refuses a nominee's listing of every nomination 403 notFirstUser, and shows the first user each state every nomination holds", async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				const toCy = await nominated(harness, PEOPLE.cy);
				const first = await firstUserCaller(harness, FIRST_USER);
				await decideNomination(await personCaller(harness, PEOPLE.cy), toCy, 'decline');

				const byNominee = await listNominations(await personCaller(harness, PEOPLE.bo));
				const listed = listedOf(await listNominations(first));

				assert.deepEqual(outcomeOf(byNominee), [403, 'notFirstUser']);
				assert.deepEqual(
					listed.map(({ id, nominee, state }) => ({
						id,
						nominee,
						state,
					})),
					[
						{ id: toBo, nominee: { subject: PEOPLE.bo.subject }, state: 'replaced' },
						{ id: toCy, nominee: { subject: PEOPLE.cy.subject }, state: 'declined' },
					],
				);
			},
			context,
		);
	});
});

suite("the controller's start, with the administrators' tables", () => {
	test("starts under the runtime role the migrations leave, holding no grant beyond the release's", async (context) => {
		const log = captureLog();
		await withHarness(
			{ configuration: { logStream: log.stream } },
			async () => {
				assert.deepEqual(
					log.lines().filter((line) => line.includes('store.grantBeyondUse')),
					[],
				);
			},
			context,
		);
	});
});

// The administrators of a listing answer, each by subject.
const listedSubjectsOf = (answer: AdminResponse): readonly string[] => {
	assertSucceeded(answer, 'the listing of administrators');
	const administratorsListed = Reflect.get(Object(answer.body), 'administrators') as readonly Readonly<
		Record<string, unknown>
	>[];
	return administratorsListed.map(({ subject }) => String(subject));
};

// An administrator accepted by the first administrator, Bo, who nominates Cy and sees Cy accept.
const acceptedCyByBo = async (harness: Harness): Promise<void> => {
	const toBo = await nominated(harness, PEOPLE.bo);
	assertSucceeded(await accepted(harness, PEOPLE.bo, toBo), 'the first acceptance');
	const toCy = await nominate(await personCaller(harness, PEOPLE.bo), { nominee: { subject: PEOPLE.cy.subject } });
	assertSucceeded(
		await accepted(harness, PEOPLE.cy, nominationOf(toCy, 'Bo nominating Cy')),
		'the second acceptance',
	);
};

suite('further administrators, nominated and removed by administrators', () => {
	test('lets an administrator nominate a further administrator, who accepts, and lists both to an administrator alone', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);

				const listing = await listAdministrators(await personCaller(harness, PEOPLE.bo));

				assert.deepEqual(listedSubjectsOf(listing), [PEOPLE.bo.subject, PEOPLE.cy.subject]);
				assertRefused(
					await listAdministrators(await firstUserCaller(harness, FIRST_USER)),
					PROBLEMS.administratorOnly,
					'the first user, no administrator now',
				);
				assert.equal(await rowCount(harness, administrators), 2);
			},
			context,
		);
	});

	test('keeps each of two nominations an administrator makes after the first acceptance pending, and lets the first of them be accepted', async (context) => {
		await withHarness(
			NOMINEES_MET_BY_USHER,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				assertSucceeded(await accepted(harness, PEOPLE.bo, toBo), 'the first acceptance');
				const bo = await personCaller(harness, PEOPLE.bo);
				const toDana = nominationOf(
					await nominate(bo, { nominee: { subject: PEOPLE.dana.subject } }),
					'Bo nominating Dana',
				);
				const toEli = nominationOf(
					await nominate(bo, { nominee: { subject: PEOPLE.eli.subject } }),
					'Bo nominating Eli',
				);

				const states = listedOf(await listNominations(bo))
					.filter(({ id }) => id === toDana || id === toEli)
					.map(({ id, state }) => [id, state]);
				assert.deepEqual(states, [
					[toDana, 'pending'],
					[toEli, 'pending'],
				]);
				assertSucceeded(await accepted(harness, PEOPLE.dana, toDana), 'Dana accepting');
				assert.deepEqual(listedSubjectsOf(await listAdministrators(bo)), [
					PEOPLE.bo.subject,
					PEOPLE.dana.subject,
				]);
			},
			context,
		);
	});

	test('refuses an administrator nominating a person who is one, or one a pending nomination already names, 409, naming the pending nomination', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				assertSucceeded(await accepted(harness, PEOPLE.bo, toBo), 'the first acceptance');
				const bo = await personCaller(harness, PEOPLE.bo);
				const pending = nominationOf(
					await nominate(bo, { nominee: { subject: PEOPLE.cy.subject } }),
					'Bo nominating Cy',
				);

				const answers = [
					await nominate(bo, { nominee: { subject: PEOPLE.bo.subject } }),
					await nominate(bo, { nominee: { subject: PEOPLE.cy.subject } }),
				];

				assert.deepEqual(answers.map(outcomeOf), [
					[409, 'nomineeAlreadyAdministrator'],
					[409, 'nomineeAlreadyNominated'],
				]);
				assert.match(String(answers[1]?.problem?.detail), new RegExp(pending));
			},
			context,
		);
	});

	test('removes an administrator, keeping their row, revoking the nomination they made that is pending, and refuses the removed one 403 after', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const cy = await personCaller(harness, PEOPLE.cy);
				const toFirstUser = nominationOf(
					await nominate(cy, { nominee: { subject: FIRST_USER.subject } }),
					'Cy nominating the first user',
				);
				const bo = await personCaller(harness, PEOPLE.bo);

				const removal = await removeAdministrator(bo, PEOPLE.cy.subject);

				assertSucceeded(removal, 'the removal');
				assert.deepEqual(Reflect.get(Object(removal.body), 'revokedNominations'), 1);
				assertRefused(await listAdministrators(cy), PROBLEMS.administratorOnly, 'the removed administrator');
				assert.equal(
					listedOf(await listNominations(bo)).find(({ id }) => id === toFirstUser)?.['state'],
					'revoked',
				);
				assert.deepEqual(
					[await rowCount(harness, administrators), await rowCount(harness, administratorRemovals)],
					[2, 1],
				);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminRemoval)).map(
						({ severity, revokedNominations }) => [severity, revokedNominations],
					),
					[['critical', 1]],
				);
			},
			context,
		);
	});

	test('refuses removing the last administrator 409 lastAdministrator, writing no removal', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				const toBo = await nominated(harness, PEOPLE.bo);
				assertSucceeded(await accepted(harness, PEOPLE.bo, toBo), 'the first acceptance');

				const answer = await removeAdministrator(await personCaller(harness, PEOPLE.bo), PEOPLE.bo.subject);

				assert.deepEqual(outcomeOf(answer), [409, 'lastAdministrator']);
				assert.equal(await rowCount(harness, administratorRemovals), 0);
			},
			context,
		);
	});

	test('lets a person removed be nominated and accepted again, holding a row of their own from the new acceptance', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				assertSucceeded(
					await removeAdministrator(await personCaller(harness, PEOPLE.bo), PEOPLE.cy.subject),
					'the removal',
				);

				const again = nominationOf(
					await nominate(await personCaller(harness, PEOPLE.bo), { nominee: { subject: PEOPLE.cy.subject } }),
					'Bo nominating Cy again',
				);
				assertSucceeded(await accepted(harness, PEOPLE.cy, again), 'the second acceptance of Cy');

				assert.deepEqual(listedSubjectsOf(await listAdministrators(await personCaller(harness, PEOPLE.bo))), [
					PEOPLE.bo.subject,
					PEOPLE.cy.subject,
				]);
				assert.equal(await rowCount(harness, administrators), 3);
			},
			context,
		);
	});
});

// A settings event a change records in its transaction, the change's only write in these tests.
const SETTING_CHANGE: AuditEvent = Object.freeze({
	data: { setting: 'test' },
	severity: 'info',
	type: 'settings.change',
});

const actorOf = (person: Person): Actor => ({ id: person.subject, type: 'human' });

// A connection the trail takes from the harness's database, released when the test's database closes.
type TrailClient = pg.Client & { release(destroy?: boolean): void };

// A trail over the harness's database, its connections taken as the runtime role, with the real
// confirmation of the administrator each change runs under.
const trailOver = (harness: Harness): AuditTrail<TrailClient> => {
	const store = {
		connect: async (): Promise<TrailClient> =>
			Object.assign(await harness.database.connect('runtime'), { release: () => undefined }),
	};
	return createAuditTrail({
		confirmAuthority: confirmAdministratorAuthority({ schema: harness.database.schema }),
		eventLog: { error: () => undefined, writeEvent: () => undefined },
		settings: {
			clock: SYSTEM_CLOCK,
			databaseSchema: harness.database.schema,
			eventSource: 'https://usher.example.org/controller',
			instanceName: 'usher-admin-test',
			storeTimeoutMilliseconds: 15_000,
		},
		store,
	});
};

// A change by a person, run for the administrator they were admitted as.
const changeBy = (
	harness: Harness,
	trail: AuditTrail<TrailClient>,
	person: Person,
	work: (connection: pg.Client) => Promise<string>,
): Promise<string> =>
	withAdministratorAuthority({ issuer: harness.configuration.identityProviderIssuer, subject: person.subject }, () =>
		trail.inTransaction(actorOf(person), async ({ connection, record }) => {
			await record(SETTING_CHANGE);
			return work(connection);
		}),
	);

// A latch a test opens once the work it holds has started, and a promise the work awaits.
const gateOf = (): { open: () => void; promise: Promise<void> } => {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open: () => release(), promise };
};

suite("the administrator a change runs under, confirmed in the change's own transaction", () => {
	test('lets a change by an administrator commit while they are one, and refuses the same change once a removal of them has committed AdministratorStatusWithdrawn, recording nothing', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const trail = trailOver(harness);

				assert.equal(await changeBy(harness, trail, PEOPLE.cy, async () => 'changed'), 'changed');
				assertSucceeded(
					await removeAdministrator(await personCaller(harness, PEOPLE.bo), PEOPLE.cy.subject),
					'the removal',
				);
				await assert.rejects(
					changeBy(harness, trail, PEOPLE.cy, async () => 'changed'),
					AdministratorStatusWithdrawn,
				);
				assert.equal((await eventsOfType(harness, 'settings.change')).length, 1);
			},
			context,
		);
	});

	test('holds a change by an administrator behind a removal holding the administrators lock exclusively, then refuses it AdministratorStatusWithdrawn once the removal commits', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const trail = trailOver(harness);
				const issuer = harness.configuration.identityProviderIssuer;
				const schema = harness.database.schema;
				const entered = gateOf();
				const holding = gateOf();
				const removing = withAdministratorAuthority({ issuer, subject: PEOPLE.bo.subject }, () =>
					trail.inTransaction(
						actorOf(PEOPLE.bo),
						async ({ connection }) => {
							entered.open();
							await holding.promise;
							const administrators = sqlAdministratorStore(connection, { issuer, schema });
							const removed = await administrators.readAdministrator(PEOPLE.cy.subject);
							const removedBy = await administrators.findPerson(PEOPLE.bo.subject);
							await administrators.removeAdministrator({
								nominationId: removed?.nominationId ?? '',
								now: new Date(),
								removedBy: removedBy ?? '',
							});
						},
						{ exclusiveAuthority: true },
					),
				).then(
					() => 'removed',
					(failure: unknown) => failure,
				);
				await entered.promise;
				const changing = changeBy(harness, trail, PEOPLE.cy, async () => 'changed').then(
					() => 'changed',
					(failure: unknown) => failure,
				);
				try {
					assert.equal(await untilBlocked(harness.clients.migration, changing), true);
				} finally {
					holding.open();
				}
				assert.equal(await removing, 'removed');
				assert.ok((await changing) instanceof AdministratorStatusWithdrawn);
				assert.equal((await eventsOfType(harness, 'settings.change')).length, 0);
			},
			context,
		);
	});

	test('refuses a grant an administrator sends through the controller 403 administratorOnly once a removal of them commits behind the gate, recording the refusal and writing no grant', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				assertSucceeded(
					await registerResource(await personCaller(harness, PEOPLE.bo), study('STUDY-E1')),
					'the registration',
				);
				const trail = trailOver(harness);
				const issuer = harness.configuration.identityProviderIssuer;
				const schema = harness.database.schema;
				const entered = gateOf();
				const holding = gateOf();
				const removing = withAdministratorAuthority({ issuer, subject: PEOPLE.bo.subject }, () =>
					trail.inTransaction(
						actorOf(PEOPLE.bo),
						async ({ connection }) => {
							entered.open();
							await holding.promise;
							const administrators = sqlAdministratorStore(connection, { issuer, schema });
							const removed = await administrators.readAdministrator(PEOPLE.cy.subject);
							const removedBy = await administrators.findPerson(PEOPLE.bo.subject);
							await administrators.removeAdministrator({
								nominationId: removed?.nominationId ?? '',
								now: new Date(),
								removedBy: removedBy ?? '',
							});
						},
						{ exclusiveAuthority: true },
					),
				).then(
					() => 'removed',
					(failure: unknown) => failure,
				);
				await entered.promise;
				const granting = createGrant(await personCaller(harness, PEOPLE.cy), {
					holder: { subject: FIRST_USER.subject },
					resource: 'STUDY-E1',
					role: 'viewer',
				});
				try {
					assert.equal(await untilBlocked(harness.clients.migration, granting), true);
				} finally {
					holding.open();
				}
				assert.equal(await removing, 'removed');

				assert.deepEqual(outcomeOf(await granting), [403, 'administratorOnly']);
				assert.equal(await rowCount(harness, grants), 0);
				assert.deepEqual(
					(await auditRows(harness.clients.migration))
						.map(dataOf)
						.filter(
							({ actorId, reason }) => actorId === PEOPLE.cy.subject && reason === 'administratorOnly',
						)
						.map(({ result }) => result),
					['denied'],
				);
			},
			context,
		);
	});

	test('runs changes by two administrators at once, sharing the administrators lock, neither waiting on the other', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const trail = trailOver(harness);
				const entered = gateOf();
				const holding = gateOf();
				const first = changeBy(harness, trail, PEOPLE.bo, async () => {
					entered.open();
					await holding.promise;
					return 'bo';
				});
				await entered.promise;
				const second = changeBy(harness, trail, PEOPLE.cy, async () => 'cy');
				try {
					assert.equal(await untilBlocked(harness.clients.migration, second), false);
					assert.equal(await second, 'cy');
				} finally {
					holding.open();
				}
				assert.equal(await first, 'bo');
			},
			context,
		);
	});
});
