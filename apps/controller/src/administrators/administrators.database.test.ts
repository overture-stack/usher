import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	acceptNomination,
	type AdminResponse,
	assertRefused,
	assertSucceeded,
	createGrant,
	firstUserCaller,
	instantOf,
	listOwnNominations,
	nominate,
	personCaller,
	PROBLEMS,
	readLiveness,
	readReadiness,
	registerResource,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { captureLog } from '../../testing/harness/controller.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import { exchange, PEOPLE, type Person } from '../../testing/harness/exchange.js';
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

const { administrators, grants, nominations } = POLICY_TABLES;

// A store holding no administrator, as before the first user's nomination is accepted, its
// Controller registering no application, which only an administrator may; Bo and Cy have met Usher.
const BEFORE_THE_FIRST: HarnessOptions = {
	applications: [],
	fixture: {
		users: {
			bo: { subject: PEOPLE.bo.subject },
			cy: { subject: PEOPLE.cy.subject },
		},
	},
	seedsAdministrator: false,
};

const FIRST_USER = PEOPLE.ana;

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
	acceptNomination(await personCaller(harness, nominee), nominationId);

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
		const nominated = (nomineeId: string, at: Date): Promise<string> =>
			committedInsert(
				owner,
				nominations,
				nominationRow({ nominatedAt: at, nominatedBy: steward, nomineeId }),
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

		assert.deepEqual(outcomes, [INTEGRITY.foreignKey, 'accepted', INTEGRITY.unique, INTEGRITY.unique]);
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
				const acceptance = await acceptNomination(first, nominationId);
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
					},
				);
				assert.equal(acceptance.status, 200);
				assert.deepEqual(
					{
						...Object(acceptance.body),
						acceptedAt: instantOf(Reflect.get(Object(acceptance.body), 'acceptedAt')) > 0,
					},
					{
						acceptedAt: true,
						administrator: { subject: FIRST_USER.subject },
						nominationId,
					},
				);
				assert.equal(registered.status, 201);
				assert.deepEqual(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminNomination), [
					{
						actorId: FIRST_USER.subject,
						actorType: 'human',
						instance: harness.configuration.instanceName,
						nominationId,
						nomineeId: FIRST_USER.subject,
						result: 'succeeded',
						severity: 'warning',
						sourceIp: '127.0.0.1',
					},
				]);
				assert.deepEqual(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminAcceptance), [
					{
						actorId: FIRST_USER.subject,
						actorType: 'human',
						instance: harness.configuration.instanceName,
						nominatedById: FIRST_USER.subject,
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

				assertSucceeded(await acceptNomination(boEarly, nominationId), 'the acceptance');

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
					PROBLEMS.firstAdministratorAccepted,
					'a nomination after the acceptance',
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

	test('lets the first user nominate again until one accepts, shows each nominee the nominations naming them and which is the latest, and accepts the latest alone', async (context) => {
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
							latest: Reflect.get(Object(nomination), 'latest'),
							nominatedBy: Reflect.get(Object(nomination), 'nominatedBy'),
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
					{ id: toBo, latest: false, nominatedBy: byFirstUser },
					{ id: toBoAgain, latest: true, nominatedBy: byFirstUser },
				]);
				assert.deepEqual(cyBefore, [{ id: toCy, latest: false, nominatedBy: byFirstUser }]);
				assert.deepEqual(refusals.map(outcomeOf), [
					[409, 'nominationSuperseded'],
					[409, 'nominationSuperseded'],
					[404, 'nominationNotFound'],
				]);
				assert.equal(acceptance.status, 200);
				assert.deepEqual(boAfter, boBefore);
				assert.deepEqual(
					(await eventsOfType(harness, AUDIT_EVENT_TYPES.adminAcceptance)).map((data) => [
						data['result'],
						data['reason'],
						data['nominationId'],
					]),
					[
						['denied', 'nominationSuperseded', toCy],
						['denied', 'nominationSuperseded', toBo],
						['denied', 'nominationNotFound', toBoAgain],
						['succeeded', undefined, toBoAgain],
					],
				);
			},
			context,
		);
	});
});

suite('nominations and acceptances, serialized', () => {
	test('refuses a nomination sent while an acceptance holds the order 409 firstAdministratorAccepted, so the nomination accepted was the latest', async (context) => {
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
					[200, 409],
				);
				assert.equal(nomination?.problem?.code, PROBLEMS.firstAdministratorAccepted.code);
				assert.deepEqual(
					[await rowCount(harness, administrators), await rowCount(harness, nominations)],
					[1, 1],
				);
			},
			context,
		);
	});

	test('refuses an acceptance sent while a later nomination holds the order 409 nominationSuperseded, so no nomination replaced is ever accepted', async (context) => {
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
				assert.equal(acceptance?.problem?.code, PROBLEMS.nominationSuperseded.code);
				assert.equal(await rowCount(harness, administrators), 0);
			},
			context,
		);
	});

	test('makes one first administrator of two acceptances sent at once, refusing the second 409 firstAdministratorAccepted', async (context) => {
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
					[409, 'firstAdministratorAccepted'],
				]);
				assert.equal(await rowCount(harness, administrators), 1);
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
