import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	type AdminResponse,
	answerGrant,
	assertRefused,
	assertSucceeded,
	changeGrantExpiry,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	listGrantRequests,
	listOwnGrants,
	listResourceGrants,
	personCaller,
	PROBLEMS,
	removeSubmitter,
	revokeGrant,
} from '../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	type AuditRow,
	auditRows,
	awaitEventsOfType,
	dataOf,
	emittedType,
	SEVERITY_ATTRIBUTE,
} from '../../testing/harness/auditEvents.js';
import { adjustableClock } from '../../testing/peripherals/clocks.js';
import { captureLog } from '../../testing/harness/controller.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import {
	CAST,
	createdId,
	grantFor,
	grantsFixture,
	HOUR_MS,
	instantFromNow,
	selfGrantUntil,
	SHOWN,
	storedGrants,
	STUDY_A1,
	STUDY_B2,
} from '../../testing/fixtures/grants.js';
import { type Harness, startInstance, withHarness } from '../../testing/harness/harness.js';
import { GRANT_OPERATIONS, holdRetentionSweep } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const RATE_EXCEEDED = emittedType(AUDIT_EVENT_TYPES.grantRateExceeded);

const SECOND_MS = 1000;

// Every grant.rateExceeded row the store holds, in the order recorded.
const crossingRows = async (harness: Harness): Promise<readonly AuditRow[]> =>
	(await auditRows(harness.clients.migration)).filter(({ type }) => type === RATE_EXCEEDED);

// The data of every grant.rateExceeded the store holds, in the order recorded.
const crossingsStored = async (harness: Harness): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await crossingRows(harness)).map(dataOf);

const assertRefusedAny = (answer: AdminResponse, what: string): void => {
	assert.ok(answer.status >= 400 && answer.status < 500, `${what} was answered ${answer.status}`);
};

suite('the grant rate against the store', () => {
	test("records grant.rateExceeded as one actor's grant writes cross the threshold, alike in the store and the log, naming the actor, the count, the window and the address of the request crossing it, and completes the write crossing it", async () => {
		const log = captureLog();
		await withHarness(
			{
				configuration: {
					grantRateThreshold: { operationCount: 2, windowSeconds: 60 },
					logStream: log.stream,
				},
				fixture: grantsFixture(),
			},
			async (harness) => {
				const ana = await personCaller(harness, CAST.ownerOfA1);
				const dana = await personCaller(harness, CAST.ownerOfB2);

				const atTheThreshold = [
					await createGrant(ana, grantFor(CAST.recipient)),
					await createGrant(dana, grantFor(CAST.recipient, { resource: STUDY_B2 })),
					await createGrant(ana, grantFor(CAST.outsider)),
					await createGrant(dana, grantFor(CAST.outsider, { resource: STUDY_B2 })),
				];
				const beforeCrossing = await crossingsStored(harness);
				const crossing = await createGrant(ana, grantFor(CAST.newcomer));
				const [row, ...others] = await crossingRows(harness);
				const logged = await awaitEventsOfType(log, AUDIT_EVENT_TYPES.grantRateExceeded);
				const crossed = await storedGrants(harness, {
					id: createdId(crossing, 'the creation crossing the threshold'),
				});

				atTheThreshold.forEach((answer) => {
					assertSucceeded(answer, 'a creation at the threshold');
				});
				assert.deepEqual(beforeCrossing, []);
				assert.ok(row, 'a grant.rateExceeded was stored');
				assert.deepEqual(others, []);
				assert.deepEqual(dataOf(row), {
					actorId: CAST.ownerOfA1.subject,
					actorType: 'human',
					instance: harness.configuration.instanceName,
					operationCount: 3,
					sourceIp: '127.0.0.1',
					windowSeconds: 60,
				});
				assert.equal(row.severity, 'warning');
				assert.deepEqual(
					logged.map((event) => ({
						data: event.data,
						id: event.id,
						severity: event[SEVERITY_ATTRIBUTE],
					})),
					[{ data: dataOf(row), id: row.id, severity: 'warning' }],
				);
				assert.deepEqual(
					crossed.map(({ revokedAt }) => revokedAt),
					[null],
				);
			},
		);
	});

	test('counts every kind of grant write by its actor, refused, failed or changing nothing, and never a read', async () => {
		await withHarness(
			{
				configuration: {
					grantRateThreshold: { operationCount: 9, windowSeconds: 60 },
				},
				fixture: grantsFixture(),
			},
			async (harness) => {
				const ana = await personCaller(harness, CAST.ownerOfA1);
				const anaAsAdministrator = await administratorCaller(harness, {
					person: CAST.ownerOfA1,
				});
				const administrator = await administratorCaller(harness);
				const dana = await personCaller(harness, CAST.ownerOfB2);
				const askedOfAna = createdId(
					await createSelfGrant(administrator, selfGrantUntil(instantFromNow(2 * HOUR_MS))),
					"the administrator's request",
				);
				const offeredToAna = createdId(
					await createGrant(dana, grantFor(CAST.ownerOfA1, { resource: STUDY_B2 })),
					"Dana's grant to Ana",
				);
				const ending = instantFromNow(3 * HOUR_MS);

				const created = createdId(
					await createGrant(ana, grantFor(CAST.recipient, { role: 'submitter' })),
					'a creation',
				);
				const writes = [
					await changeGrantExpiry(ana, created, ending),
					await changeGrantExpiry(ana, created, ending),
					await revokeGrant(ana, created),
					await createSelfGrant(ana, selfGrantUntil(instantFromNow(HOUR_MS))),
					await decideGrantRequest(ana, askedOfAna, 'grant'),
					await answerGrant(ana, offeredToAna, {
						capabilities: SHOWN.viewer,
						decision: 'accept',
					}),
					await createSelfGrant(
						anaAsAdministrator,
						selfGrantUntil(instantFromNow(HOUR_MS), {
							resource: STUDY_B2,
							role: 'curator',
						}),
					),
				];
				const refused = await createGrant(ana, grantFor(CAST.recipient, { resource: STUDY_B2 }));
				const reads = [
					await listOwnGrants(ana),
					await listResourceGrants(ana, STUDY_A1),
					await listGrantRequests(ana),
				];
				const atTheThreshold = await crossingsStored(harness);
				const failed = await removeSubmitter(ana, STUDY_A1, 'submitter@example.org');
				const crossings = await crossingsStored(harness);

				writes.forEach((answer) => {
					assertSucceeded(answer, 'a grant write');
				});
				assertRefusedAny(refused, 'a creation on a study Ana does not own');
				reads.forEach((answer) => {
					assertSucceeded(answer, 'a read');
				});
				assertRefused(failed, PROBLEMS.directoryNotConfigured, 'a removal with no directory');
				assert.deepEqual(atTheThreshold, []);
				assert.deepEqual(
					crossings.map((data) => [data['actorId'], data['operationCount']]),
					[[CAST.ownerOfA1.subject, 10]],
				);
			},
		);
	});

	test('measures the window back from each write, and reports again once the count has fallen back to the threshold and crosses it again', async () => {
		const clock = adjustableClock();
		await withHarness(
			{
				configuration: {
					clock: clock.clock,
					grantRateThreshold: { operationCount: 1, windowSeconds: 60 },
				},
				fixture: grantsFixture(),
			},
			async (harness) => {
				const ana = await personCaller(harness, CAST.ownerOfA1);
				const steps = [
					{ after: 0, holder: CAST.recipient },
					{ after: 10 * SECOND_MS, holder: CAST.outsider },
					{ after: 10 * SECOND_MS, holder: CAST.newcomer },
					{ after: 55 * SECOND_MS, holder: CAST.curator },
					{ after: SECOND_MS, holder: CAST.lookalike },
				];

				const counted = await steps.reduce<Promise<readonly { answer: AdminResponse; crossings: number }[]>>(
					async (earlier, { after, holder }) => {
						const done = await earlier;
						clock.advance(after);
						const answer = await createGrant(ana, grantFor(holder));
						return [...done, { answer, crossings: (await crossingsStored(harness)).length }];
					},
					Promise.resolve([]),
				);

				counted.forEach(({ answer }) => {
					assertSucceeded(answer, 'a creation');
				});
				assert.deepEqual(
					counted.map(({ crossings }) => crossings),
					[0, 1, 1, 2, 2],
				);
				assert.deepEqual(
					(await crossingsStored(harness)).map((data) => data['operationCount']),
					[2, 2],
				);
			},
		);
	});

	test('records one grant.rateExceeded for two writes of one actor crossing at once on two instances', async (context) => {
		await withHarness(
			{
				configuration: {
					grantRateThreshold: { operationCount: 1, windowSeconds: 60 },
					// Longer than the table hold: both writes wait it out and are counted together.
					storeTimeoutMilliseconds: 15_000,
				},
				fixture: grantsFixture(),
			},
			async (harness) => {
				const scope = cleanupFor(context);
				const beside = await startInstance(scope, harness);
				const sweepHolder = await harness.database.connect('migration');
				scope.defer(() => sweepHolder.end());
				const sweep = await holdRetentionSweep(sweepHolder);
				scope.defer(() => sweep.release());
				const first = await createGrant(await personCaller(harness, CAST.ownerOfA1), grantFor(CAST.recipient));
				const held = await holdTable(harness.database, GRANT_OPERATIONS);
				const sending = Promise.all(
					[harness.url, beside.url].map(async (url) =>
						createGrant(
							await personCaller(harness, CAST.ownerOfA1, { url }),
							grantFor(CAST.outsider, { resource: STUDY_B2 }),
						),
					),
				);
				const blocked = await untilBlocked(harness.clients.migration, sending, {
					count: 2,
				});
				await held.release();
				const answers = await sending;

				assertSucceeded(first, 'the first creation');
				assert.equal(blocked, true, 'both writes waited on the count together');
				answers.forEach((answer) => {
					assertRefusedAny(answer, 'a creation on a study Ana does not own');
				});
				assert.deepEqual(
					(await crossingsStored(harness)).map((data) => data['operationCount']),
					[2],
				);
			},
			context,
		);
	});
});
