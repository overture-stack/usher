import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	type AdminResponse,
	administratorCaller,
	assertConflict,
	assertRuleBroken,
	assertSucceeded,
	PROBLEMS,
	readResource,
	registerResource,
	resourceViewOf,
	serveResource,
	stopServingResource,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import {
	committedInsert,
	INTEGRITY,
	resourceRow,
	selectRows,
	stewardOf,
	writeOutcome,
} from '../../testing/fixtures/database.js';
import { storedDecisions } from '../../testing/fixtures/grants.js';
import {
	APPLICATIONS,
	applicationIdsOf,
	CLINICAL,
	registeredTogether,
	registration,
	registrationFixture,
	UNREGISTERED_APPLICATION,
} from '../../testing/fixtures/resources.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import {
	changeRecordCount,
	highestPosition,
	inTurn,
	liveGrantId,
	noticesAfter,
	type PolicyFixture,
	POLICY_TABLES,
	policySnapshot,
	qualified,
	storedExternalIds,
	usersWithSubject,
} from '../../testing/harness/policy.js';

const { applicationResources, auditLog, resources } = POLICY_TABLES;

const { applicationServedResourcesChange, resourceRegistration } = AUDIT_EVENT_TYPES;

// The registration fixture, with resources registered beforehand: STUDY-R1 and ÄRZTE-1 retired,
// STUDY-İ1 holding a capital I with a dot above, and study-b2 in lower case.
const FIXTURE: PolicyFixture = {
	...registrationFixture(),
	resources: {
		'STUDY-R1': { baseTier: 'grant', name: 'Retired study', retired: {} },
		'STUDY-İ1': { baseTier: 'grant', name: 'Dotted capital I' },
		'study-b2': { baseTier: 'open', name: 'Lower-case study' },
		'ÄRZTE-1': {
			baseTier: 'grant',
			name: 'Retired study beyond ASCII',
			retired: {},
		},
	},
};

// The events the audit log holds of one type that name a resource, each event's data.
const eventsNaming = async (
	client: pg.ClientBase,
	type: string,
	externalId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(client))
		.filter((row) => row.type === emittedType(type))
		.map(dataOf)
		.filter((data) => data['resourceId'] === externalId);

// The rows a resource's registration or a change to its served set wrote, as another session reads
// them: the resource, the applications serving it, and its notices and events.
const writtenFor = async (
	client: pg.ClientBase,
	externalId: string,
	since: bigint,
): Promise<{
	notices: readonly { audience: string | null; kind: string }[];
	resources: number;
	served: readonly string[];
}> => {
	const [resourceRows, servedRows, notices] = [
		await selectRows<{ externalId: string }>(
			client,
			`SELECT ${resources.columns.externalId} AS "externalId" FROM ${qualified(resources)} WHERE ${resources.columns.externalId} = $1`,
			[externalId],
		),
		await selectRows<{ application: string }>(
			client,
			`SELECT served.${applicationResources.columns.applicationId}::text AS application
         FROM ${qualified(applicationResources)} served
         JOIN ${qualified(resources)} resource ON resource.${resources.columns.id} = served.${applicationResources.columns.resourceId}
        WHERE resource.${resources.columns.externalId} = $1
        ORDER BY 1`,
			[externalId],
		),
		await noticesAfter(client, since),
	];
	return {
		notices: notices.map(({ audience, kind }) => ({ audience, kind })),
		resources: resourceRows.length,
		served: servedRows.map(({ application }) => application),
	};
};

// What a change wrote once committed, while its transaction is held open before its first event: the
// audit log is held, so the change waits there, and another session reads what it wrote so far.
const heldBeforeItsEvents = async (
	harness: Harness,
	change: () => Promise<AdminResponse>,
	read: () => Promise<unknown>,
): Promise<{ answer: AdminResponse; whileOpen: unknown }> => {
	const held = await holdTable(harness.database, auditLog);
	const answering = change();
	const whileOpen = await (async (): Promise<unknown> => {
		try {
			assert.ok(
				await untilBlocked(harness.clients.migration, answering),
				'the change waits on the held audit log',
			);
			return await read();
		} finally {
			await held.release();
		}
	})();
	return { answer: await answering, whileOpen };
};

suite("a resource's registration in the store", () => {
	test('refuses 409 alreadyExists an externalId a resource holds in another letter case, a retired one included, writing nothing and recording each refusal denied', async (context) => {
		await withHarness(
			{ fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const sent = ['study-r1', 'Study-R1', 'STUDY-B2', 'Study-b2'];
				const before = await policySnapshot(migration);
				const since = await highestPosition(migration);

				const answers = await inTurn(sent, (externalId) =>
					registerResource(administrator, registration(externalId)),
				);

				answers.forEach((answer, index) =>
					assertConflict(answer, `registering ${sent[index] ?? ''}`, PROBLEMS.alreadyExists.code),
				);
				assert.deepEqual(await policySnapshot(migration), before);
				assert.deepEqual(await noticesAfter(migration, since), []);
				assert.deepEqual(
					(await auditRows(migration))
						.filter((row) => row.type === emittedType(resourceRegistration))
						.map(dataOf)
						.map(({ reason, result }) => ({ reason, result })),
					sent.map(() => ({
						reason: PROBLEMS.alreadyExists.code,
						result: 'denied',
					})),
				);
			},
			context,
		);
	});

	test("holds one externalId in any letter case under ICU's root collation, a retired resource's included: Ä against ä, and I against i, but a dotless ı apart from I and a dotted capital İ apart from i", async (context) => {
		await withHarness(
			{ fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const steward = stewardOf(harness.seeded);
				const sent = ['ärzte-1', 'Ärzte-1', 'study-i̇1', 'STUDY-I1', 'study-i1', 'STUDY-ı1'];

				const outcomes = await inTurn(sent, (externalId) =>
					writeOutcome(committedInsert(migration, resources, resourceRow(externalId, steward))),
				);

				assert.deepEqual(outcomes, [
					INTEGRITY.unique,
					INTEGRITY.unique,
					INTEGRITY.unique,
					'accepted',
					INTEGRITY.unique,
					'accepted',
				]);
				assert.deepEqual(
					(await storedExternalIds(migration)).filter((externalId) =>
						/^(?:ÄRZTE|STUDY-[IİıR])/u.test(externalId),
					),
					['STUDY-I1', 'STUDY-R1', 'STUDY-İ1', 'STUDY-ı1', 'ÄRZTE-1'],
				);
			},
			context,
		);
	});

	test('answers two registrations racing for one externalId in two letter cases once 201 and once 409 alreadyExists, holding one resource', async (context) => {
		await withHarness(
			// Longer than the hold these changes wait on: each waits it out rather than timing out.
			{ configuration: { storeTimeoutMilliseconds: 15_000 }, fixture: FIXTURE },
			async (harness) => {
				const administrator = await administratorCaller(harness);

				const answers = await registeredTogether(harness, administrator, [
					registration('STUDY-X1'),
					registration('study-x1'),
				]);

				assert.deepEqual(answers.map(({ problem, status }) => `${status} ${problem?.code ?? ''}`).toSorted(), [
					'201 ',
					`409 ${PROBLEMS.alreadyExists.code}`,
				]);
				assert.equal(
					(await storedExternalIds(harness.clients.migration)).filter(
						(externalId) => externalId.toLowerCase() === 'study-x1',
					).length,
					1,
				);
			},
			context,
		);
	});

	test('commits a registration in one transaction: the resource, a served row and a servedResources notice for each application named once, its resource.registration and an application.servedResourcesChange for each', async (context) => {
		await withHarness(
			// Longer than the hold these changes wait on: each waits it out rather than timing out.
			{ configuration: { storeTimeoutMilliseconds: 15_000 }, fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const ids = applicationIdsOf(harness, APPLICATIONS);
				const [first = '', second = ''] = ids;
				const since = await highestPosition(migration);

				const { answer, whileOpen } = await heldBeforeItsEvents(
					harness,
					() =>
						registerResource(
							administrator,
							registration('STUDY-N1', {
								accessLevel: 'open',
								applications: [second, first, first.toUpperCase()],
							}),
						),
					() => writtenFor(migration, 'STUDY-N1', since),
				);

				assertSucceeded(answer, 'the registration');
				assert.equal(answer.status, 201);
				const view = resourceViewOf(answer, 'the registration');
				assert.deepEqual(
					{
						accessLevel: view.accessLevel,
						applications: view.applications,
						categories: view.categories,
						externalId: view.externalId,
						fields: view.fields,
						retired: view.retired,
						suppressed: view.suppressed,
					},
					{
						accessLevel: 'open',
						applications: ids,
						categories: [],
						externalId: 'STUDY-N1',
						fields: {},
						retired: false,
						suppressed: false,
					},
				);
				assert.deepEqual(whileOpen, { notices: [], resources: 0, served: [] });
				assert.deepEqual(await writtenFor(migration, 'STUDY-N1', since), {
					notices: ids.map((audience) => ({
						audience,
						kind: 'servedResources',
					})),
					resources: 1,
					served: ids,
				});
				assert.deepEqual(
					(await eventsNaming(migration, resourceRegistration, 'STUDY-N1')).map(
						({ initialOwnerId, result }) => ({ initialOwnerId, result }),
					),
					[{ initialOwnerId: null, result: 'succeeded' }],
				);
				assert.deepEqual(
					(await eventsNaming(migration, applicationServedResourcesChange, 'STUDY-N1'))
						.map(({ applicationId, change, result }) => ({
							applicationId,
							change,
							result,
						}))
						.toSorted((left, right) =>
							String(left.applicationId).localeCompare(String(right.applicationId)),
						),
					ids.map((applicationId) => ({
						applicationId,
						change: 'added',
						result: 'succeeded',
					})),
				);
			},
			context,
		);
	});

	test('refuses a registration naming an application that is not registered 422 unknownApplication whole, and one naming one owner twice 422, writing nothing of either and recording each denied', async (context) => {
		await withHarness(
			{ fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const [clinical = ''] = applicationIdsOf(harness, [CLINICAL]);
				const before = await policySnapshot(migration);
				const since = await highestPosition(migration);

				const answers = await inTurn(
					[
						registration('STUDY-U1', {
							applications: [clinical, UNREGISTERED_APPLICATION],
						}),
						registration('STUDY-U2', { applications: ['not-an-id'] }),
						registration('STUDY-U3', {
							owners: [{ subject: 'subject-unused' }, { subject: 'subject-unused' }],
						}),
					],
					(sent) => registerResource(administrator, sent),
				);

				assertRuleBroken(
					answers[0] ?? assert.fail('no answer'),
					'an unregistered application',
					PROBLEMS.unknownApplication.code,
				);
				assertRuleBroken(
					answers[1] ?? assert.fail('no answer'),
					'a malformed application id',
					PROBLEMS.unknownApplication.code,
				);
				assertRuleBroken(answers[2] ?? assert.fail('no answer'), 'a registration naming one owner twice');
				assert.deepEqual(await policySnapshot(migration), before);
				assert.deepEqual(await noticesAfter(migration, since), []);
				assert.deepEqual(
					(await auditRows(migration))
						.filter(({ type }) =>
							[resourceRegistration, applicationServedResourcesChange].map(emittedType).includes(type),
						)
						.map(dataOf)
						.map(({ reason, result }) => ({ reason, result }))
						.toSorted((left, right) => String(left.reason).localeCompare(String(right.reason))),
					answers
						.map(({ problem }) => ({
							reason: problem?.code,
							result: 'denied',
						}))
						.toSorted((left, right) => String(left.reason).localeCompare(String(right.reason))),
				);
			},
			context,
		);
	});
});

suite("a registration's owners in the store", () => {
	test('commits an owner grant for each owner named with the registration, each holder met first, each with its grant.creation and, under auto-accept, its acceptance, the first named its initialOwnerId', async (context) => {
		const owners = ['subject-first-owner', 'subject-second-owner'];
		await withHarness(
			{ configuration: { autoAccept: true }, fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const before = await inTurn(owners, (subject) => usersWithSubject(migration, subject));

				const answer = await registerResource(
					await administratorCaller(harness),
					registration('STUDY-N1', {
						accessLevel: 'grant',
						owners: owners.map((subject) => ({ subject })),
					}),
				);

				assertSucceeded(answer, 'the registration naming two owners');
				assert.deepEqual(before, [0, 0]);
				assert.deepEqual(await inTurn(owners, (subject) => usersWithSubject(migration, subject)), [1, 1]);
				const grantIds = await inTurn(owners, (holder) =>
					liveGrantId(migration, {
						category: null,
						holder,
						resource: 'STUDY-N1',
						role: 'owner',
					}),
				);
				const decided = await inTurn(grantIds, (grantId) => storedDecisions(harness, grantId));
				assert.deepEqual(
					decided.map((decisions) =>
						decisions.map(({ deciderSubject, decision }) => [deciderSubject, decision]),
					),
					owners.map((subject) => [[subject, 'accepted']]),
				);
				const events = (await auditRows(migration)).filter(
					({ data }) =>
						typeof data === 'object' && data !== null && Reflect.get(data, 'resourceId') === 'STUDY-N1',
				);
				assert.deepEqual(
					events
						.filter(({ type }) => type === emittedType(resourceRegistration))
						.map((event) => dataOf(event)['initialOwnerId']),
					[owners[0]],
				);
				assert.deepEqual(
					events
						.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
						.map((event) => {
							const data = dataOf(event);
							return [data['granteeId'], data['role'], data['category']];
						}),
					owners.map((subject) => [subject, 'owner', null]),
				);
			},
			context,
		);
	});

	test("answers a registration's grant summary as a read of the resource does: its owners counted once accepted with it, and none while they await an answer", async (context) => {
		const owners = ['subject-first-owner', 'subject-second-owner'];
		const summaries = await inTurn([true, false], (autoAccept) =>
			withHarness(
				{ configuration: { autoAccept }, fixture: FIXTURE },
				async (harness) => {
					const administrator = await administratorCaller(harness);
					const answer = await registerResource(
						administrator,
						registration('STUDY-N1', {
							accessLevel: 'grant',
							owners: owners.map((subject) => ({ subject })),
						}),
					);
					const read = await readResource(administrator, 'STUDY-N1');
					assertSucceeded(answer, 'the registration');
					assertSucceeded(read, 'the read');
					return [
						resourceViewOf(answer, 'the registration').grantSummary,
						resourceViewOf(read, 'the read').grantSummary,
					];
				},
				context,
			),
		);

		assert.deepEqual(summaries, [
			[{ owner: 2 }, { owner: 2 }],
			[{}, {}],
		]);
	});
});

suite("a change to a resource's served set in the store", () => {
	test('commits adding and removing one application in one transaction each, with its servedResources notice and its event', async (context) => {
		await withHarness(
			// Longer than the hold these changes wait on: each waits it out rather than timing out.
			{ configuration: { storeTimeoutMilliseconds: 15_000 }, fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const [clinical = ''] = applicationIdsOf(harness, [CLINICAL]);
				const beforeAdding = await highestPosition(migration);

				const added = await heldBeforeItsEvents(
					harness,
					() => serveResource(administrator, 'study-b2', clinical),
					() => writtenFor(migration, 'study-b2', beforeAdding),
				);
				const afterAdding = await writtenFor(migration, 'study-b2', beforeAdding);
				const beforeRemoving = await highestPosition(migration);
				const removed = await heldBeforeItsEvents(
					harness,
					() => stopServingResource(administrator, 'study-b2', clinical),
					() => writtenFor(migration, 'study-b2', beforeRemoving),
				);
				const afterRemoving = await writtenFor(migration, 'study-b2', beforeRemoving);

				assertSucceeded(added.answer, 'adding the application');
				assertSucceeded(removed.answer, 'removing the application');
				assert.deepEqual(
					[added.whileOpen, afterAdding, removed.whileOpen, afterRemoving],
					[
						{ notices: [], resources: 1, served: [] },
						{
							notices: [{ audience: clinical, kind: 'servedResources' }],
							resources: 1,
							served: [clinical],
						},
						{ notices: [], resources: 1, served: [clinical] },
						{
							notices: [{ audience: clinical, kind: 'servedResources' }],
							resources: 1,
							served: [],
						},
					],
				);
				assert.deepEqual(
					(await eventsNaming(migration, applicationServedResourcesChange, 'study-b2'))
						.map(({ applicationId, change, result }) => ({
							applicationId,
							change,
							result,
						}))
						.toSorted((left, right) => String(left.change).localeCompare(String(right.change))),
					[
						{ applicationId: clinical, change: 'added', result: 'succeeded' },
						{
							applicationId: clinical,
							change: 'removed',
							result: 'succeeded',
						},
					],
				);
			},
			context,
		);
	});

	test('answers adding an application serving the resource already, and removing one serving it not, as a success writing nothing', async (context) => {
		await withHarness(
			{ fixture: FIXTURE },
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const [clinical = ''] = applicationIdsOf(harness, [CLINICAL]);
				assertSucceeded(await serveResource(administrator, 'study-b2', clinical), 'serving the resource first');
				const before = {
					auditRows: (await auditRows(migration)).length,
					changeRecords: await changeRecordCount(migration, applicationResources),
					snapshot: await policySnapshot(migration),
				};
				const since = await highestPosition(migration);

				const answers = [
					await serveResource(administrator, 'study-b2', clinical),
					await stopServingResource(administrator, 'STUDY-İ1', clinical),
				];

				answers.forEach((answer) => {
					assertSucceeded(answer, 'a change already made');
				});
				assert.deepEqual(
					{
						auditRows: (await auditRows(migration)).length,
						changeRecords: await changeRecordCount(migration, applicationResources),
						snapshot: await policySnapshot(migration),
					},
					before,
				);
				assert.deepEqual(await noticesAfter(migration, since), []);
			},
			context,
		);
	});
});
