import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { assertSucceeded, revokeApplicationKey } from '../../testing/harness/admin.js';
import { auditRows } from '../../testing/harness/auditEvents.js';
import { poll, pollAll, type RawStream } from '../../testing/harness/channel.js';
import { exchange, freshAssertion } from '../../testing/harness/exchange.js';
import {
	administratorCaller,
	AUDIENCES,
	collectStream,
	describeNotice,
	headCursors,
	pastTheFloor,
	rawStreamFrom,
	RESOURCES,
	SHORT_RETENTION,
	signedAssertion,
	startChannelHarness,
	tagOfSubject,
	trimNotices,
	untilNoticesOlderThan,
} from '../../testing/fixtures/channel.js';
import { type Harness, retentionFloorSeconds, startInstance } from '../../testing/harness/harness.js';
import {
	failNthInsert,
	holdRetentionSweep,
	insertNotices,
	noticePositions,
	POLICY_TABLES,
	qualified,
	simulateRestore,
} from '../../testing/harness/policy.js';
import { cleanupFor, eventually, nowSeconds } from '../../testing/harness/waiting.js';

const { portal, search, submission } = AUDIENCES;

const WAIT_MS = 10_000;

/** How often the Controller reads the stream with no wake-up, in the harness's configuration. */
const REREAD_MS = 2_000;

const SCHEDULING_SLACK_MS = 1_500;

/** The connections the Controller's store pool holds at most: the driver's default. */
const POOL_CONNECTIONS = 10;

const SUBJECT = 'subject-of-a-notice-written-directly';

/**
 * Writes baseline notices straight into the stream and gives the cursors the search audience reads
 * for them, with their positions, in order.
 */
const writtenBaselines = async (
	harness: Harness,
	count: number,
	createdAt?: Date,
): Promise<{ cursors: readonly string[]; positions: readonly bigint[] }> => {
	const application = harness.application(search);
	const before = (await headCursors(harness))[search] ?? '';
	await insertNotices(
		harness.clients.migration,
		Array.from({ length: count }, () => ({
			kind: 'baseline' as const,
			...(createdAt === undefined ? {} : { createdAt }),
		})),
	);
	const { notices } = await pollAll(harness.url, {
		after: before,
		application,
	});
	return {
		cursors: notices.map(({ cursor }) => cursor),
		positions: (await noticePositions(harness.clients.migration)).slice(-count),
	};
};

// The rows the record of used assertions holds, under the migration role.
const usedAssertionRows = async (client: pg.ClientBase): Promise<number> => {
	const { rows } = await client.query<{ held: number }>(
		`SELECT count(*)::int AS held FROM ${qualified(POLICY_TABLES.usedChannelAssertions)}`,
	);
	return rows[0]?.held ?? 0;
};

// The refusals recorded as unrepresentableJti, read under the migration role.
const unstorableRejections = async (harness: Harness): Promise<readonly unknown[]> =>
	(await auditRows(harness.clients.migration)).filter(
		({ type, data }) =>
			type === 'bio.overture.channelAssertion.rejection' && reasonOf(data) === 'unrepresentableJti',
	);

const reasonOf = (data: unknown): string =>
	typeof data === 'object' && data !== null && 'reason' in data ? String(data.reason) : '';

const statusesFrom = async (
	harness: Harness,
	cursor: string,
	scope: ReturnType<typeof cleanupFor>,
): Promise<{ poll: number; push: number }> => {
	const application = harness.application(search);
	const polled = await poll(harness.url, { after: cursor, application });
	const pushed = await rawStreamFrom(scope, harness.url, {
		application,
		lastEventId: cursor,
	});
	return { poll: polled.status, push: pushed.status };
};

suite('the revocation channel, against the store', () => {
	test('answers each audience with the notices it receives after a cursor, in position order, on the poll and the push alike', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const cursors = await headCursors(harness);
		const stream = await collectStream(scope, harness.url, {
			application: harness.application(search),
			lastEventId: cursors[search] ?? null,
		});

		await insertNotices(harness.clients.migration, [
			{ kind: 'category', resourceExternalId: RESOURCES.a1 },
			{ kind: 'category', resourceExternalId: RESOURCES.c3 },
			{ kind: 'category', resourceExternalId: RESOURCES.d4 },
			{ audience: harness.application(search).id, kind: 'servedResources' },
			{ kind: 'principal', subject: SUBJECT },
			{ kind: 'baseline' },
			{ kind: 'signOutEveryone' },
		]);
		const polled = Object.fromEntries(
			await Promise.all(
				[portal, search, submission].map(async (audience) => {
					const { notices } = await pollAll(harness.url, {
						after: cursors[audience] ?? '',
						application: harness.application(audience),
					});
					return [audience, notices.map(describeNotice)] as const;
				}),
			),
		);
		const pushed = await stream.waitFor((notices) => notices.length >= 5, WAIT_MS);

		const tag = async (audience: string): Promise<string> =>
			`principal ${await tagOfSubject(harness.application(audience), SUBJECT)}`;
		assert.deepEqual(polled, {
			[portal]: [await tag(portal), 'baseline', 'signOutEveryone'],
			[search]: [`category ${RESOURCES.a1}`, 'servedResources', await tag(search), 'baseline', 'signOutEveryone'],
			[submission]: [`category ${RESOURCES.c3}`, await tag(submission), 'baseline', 'signOutEveryone'],
		});
		assert.deepEqual(pushed.map(describeNotice), polled[search]);
	});

	test('pushes a notice another writer committed to an open stream within the reread interval', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const cursors = await headCursors(harness);
		const stream = await collectStream(scope, harness.url, {
			application: harness.application(portal),
			lastEventId: cursors[portal] ?? null,
		});
		await stream.drain();

		await insertNotices(harness.clients.migration, [{ kind: 'signOutEveryone' }]);
		const committedAt = performance.now();
		await stream.waitFor((notices) => notices.length >= 1, WAIT_MS);

		const [arrival] = stream.notices();
		assert.equal(arrival?.notice.kind, 'signOutEveryone');
		assert.ok(
			(arrival?.arrivedAt ?? Infinity) - committedAt <= REREAD_MS + SCHEDULING_SLACK_MS,
			'the notice arrived later than the reread interval allows',
		);
	});

	test("answers polls while more streams are open than the store's pool holds connections", async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const application = harness.application(search);
		const cursors = await headCursors(harness);

		const streams = await Promise.all(
			Array.from({ length: POOL_CONNECTIONS + 2 }, () =>
				rawStreamFrom(scope, harness.url, {
					application,
					lastEventId: cursors[search] ?? '',
				}),
			),
		);
		await eventually(async () => streams.every((stream) => stream.chunks().length > 0), WAIT_MS, 20);
		const startedAt = performance.now();
		const answers = await Promise.all([
			poll(harness.url, { application }),
			poll(harness.url, { after: cursors[search] ?? '', application }),
		]);

		streams.forEach((stream) => {
			assert.equal(stream.status, 200);
		});
		answers.forEach(({ answer, status }) => {
			assert.equal(status, 200);
			assert.equal(answer?.kind, 'answer');
		});
		assert.ok(performance.now() - startedAt < 1_000);
	});

	test('ends every stream it holds when the controller stops', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const cursors = await headCursors(harness);
		const streams = await Promise.all(
			[portal, search].map((audience) =>
				rawStreamFrom(scope, harness.url, {
					application: harness.application(audience),
					lastEventId: cursors[audience] ?? '',
				}),
			),
		);

		const stoppedAt = performance.now();
		await harness.stopController();
		const endedAt = await Promise.all(streams.map(({ ended }) => ended));

		streams.forEach((stream) => {
			assert.equal(stream.status, 200);
		});
		endedAt.forEach((at) => {
			assert.ok(at - stoppedAt < WAIT_MS);
		});
	});

	test('answers 410 on both channels to a cursor below the trim watermark, and serves one at it', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope, {
			configuration: SHORT_RETENTION,
		});
		// The test's own trim is the only one: a run of the sweep reaching the notices written below
		// would move the watermark past a cursor before the test reads past it.
		const holder = await harness.database.connect('migration');
		scope.defer(() => holder.end());
		await holdRetentionSweep(holder);
		assert.ok(await untilNoticesOlderThan(harness.clients.migration, retentionFloorSeconds(harness.configuration)));
		const { cursors, positions } = await writtenBaselines(harness, 3, pastTheFloor(harness));

		const watermark = await trimNotices(harness.clients.runtime);

		assert.equal(watermark, positions[2]);
		assert.deepEqual(await statusesFrom(harness, cursors[0] ?? '', scope), {
			poll: 410,
			push: 410,
		});
		assert.deepEqual(await statusesFrom(harness, cursors[2] ?? '', scope), {
			poll: 200,
			push: 200,
		});
	});

	test('answers 410 on both channels to a cursor whose position a restore gave to a later notice, the epoch kept', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const { cursors, positions } = await writtenBaselines(harness, 3);

		await simulateRestore(harness.clients.migration, {
			epoch: 'kept',
			keptThrough: positions[0] ?? 0n,
		});
		await insertNotices(harness.clients.migration, [{ kind: 'signOutEveryone' }]);
		const kept = await pollAll(harness.url, {
			after: cursors[0] ?? '',
			application: harness.application(search),
		});

		assert.deepEqual(await statusesFrom(harness, cursors[1] ?? '', scope), {
			poll: 410,
			push: 410,
		});
		assert.deepEqual(kept.notices.map(describeNotice), ['signOutEveryone']);
	});

	test("records a refused channel assertion as channelAssertion.rejection by the system, denied, naming its reason, its application and the request's address", async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const application = harness.application(search);
		const now = nowSeconds();

		const refused = await poll(harness.url, {
			application,
			assertion: await signedAssertion(application, {
				claims: { exp: now - 40, iat: now - 100 },
			}),
		});

		// The refusal is recorded beside the answer, so its row is waited for rather than read at once.
		const rejectionRows = async () =>
			(await auditRows(harness.clients.migration)).filter(
				({ type }) => type === 'bio.overture.channelAssertion.rejection',
			);
		await eventually(async () => (await rejectionRows()).length > 0, WAIT_MS);
		const rejections = await rejectionRows();

		assert.equal(refused.status, 401);
		assert.deepEqual(
			rejections.map(({ data, severity }) => ({ data, severity })),
			[
				{
					data: {
						actorId: null,
						actorType: 'system',
						applicationId: application.id,
						instance: harness.configuration.instanceName,
						reason: 'expiredAssertion',
						result: 'denied',
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
				},
			],
		);
	});

	test('counts each refusal it could not verify by reason and registered application, recording one channelAssertion.rejectionTally for each, and records a reused assertion on its own', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const portalApplication = harness.application(portal);
		const searchApplication = harness.application(search);
		const cursors = await headCursors(harness);
		const reused = await freshAssertion(searchApplication);

		const refusals = [
			await poll(harness.url, {
				application: searchApplication,
				assertion: null,
			}),
			await poll(harness.url, {
				application: searchApplication,
				assertion: null,
			}),
			await poll(harness.url, {
				application: searchApplication,
				assertion: await signedAssertion(searchApplication, {
					header: { typ: 'JWT' },
				}),
			}),
			await poll(harness.url, {
				application: searchApplication,
				assertion: await signedAssertion(searchApplication, {
					claims: { iss: 'unknown-test' },
				}),
			}),
		];
		const opened = await rawStreamFrom(scope, harness.url, {
			application: searchApplication,
			assertion: reused,
			lastEventId: cursors[search] ?? '',
		});
		const reopened = await rawStreamFrom(scope, harness.url, {
			application: searchApplication,
			assertion: reused,
			lastEventId: cursors[search] ?? '',
		});
		assertSucceeded(
			await revokeApplicationKey(
				await administratorCaller(harness),
				portalApplication.id,
				portalApplication.keyId,
				{ reason: 'retired' },
			),
			"the revocation of the portal's key",
		);
		const holdingNone = await poll(harness.url, {
			application: portalApplication,
		});
		await harness.stopController();

		[...refusals, holdingNone].forEach(({ status }) => {
			assert.equal(status, 401);
		});
		assert.deepEqual([opened.status, reopened.status], [200, 401]);
		const rows = await auditRows(harness.clients.migration);
		// Each interval's counts are recorded together, so their rows are read in the order of their reasons.
		const dataOfType = (type: string): readonly unknown[] =>
			rows
				.filter((row) => row.type === type)
				.map(({ data }) => data)
				.toSorted((first, second) => reasonOf(first).localeCompare(reasonOf(second)));
		const system = {
			actorId: null,
			actorType: 'system',
			instance: harness.configuration.instanceName,
		};
		assert.deepEqual(dataOfType('bio.overture.channelAssertion.rejectionTally'), [
			{ ...system, count: 2, reason: 'missingAssertion' },
			{
				...system,
				applicationId: portalApplication.id,
				count: 1,
				reason: 'noLiveKey',
			},
			{ ...system, count: 1, reason: 'unknownApplication' },
			{ ...system, count: 1, reason: 'unreadableAssertion' },
		]);
		assert.deepEqual(dataOfType('bio.overture.channelAssertion.rejection'), [
			{
				...system,
				applicationId: searchApplication.id,
				reason: 'reusedAssertion',
				result: 'denied',
				sourceIp: '127.0.0.1',
			},
		]);
	});

	test('refuses a second use of one assertion on the same instance, and on another instance sharing the store, which holds its one record', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const beside = await startInstance(scope, harness);
		const searchApplication = harness.application(search);
		const cursors = await headCursors(harness);
		const assertion = await freshAssertion(searchApplication);
		const presented = (url: URL): Promise<RawStream> =>
			rawStreamFrom(scope, url, {
				application: searchApplication,
				assertion,
				lastEventId: cursors[search] ?? '',
			});

		const opened = await presented(harness.url);
		const repeated = await presented(harness.url);
		const elsewhere = await presented(beside.url);

		assert.deepEqual([opened.status, repeated.status, elsewhere.status], [200, 401, 401]);
		assert.equal(await usedAssertionRows(harness.clients.migration), 1);
	});

	test('refuses a stream whose assertion the store cannot record with 503 storeUnavailable, opening no stream and recording nothing, and serves the same assertion once the store takes its record', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const searchApplication = harness.application(search);
		const cursors = await headCursors(harness);
		const assertion = await freshAssertion(searchApplication);
		const presented = (): Promise<RawStream> =>
			rawStreamFrom(scope, harness.url, {
				application: searchApplication,
				assertion,
				lastEventId: cursors[search] ?? '',
			});
		const fault = await failNthInsert(scope, harness.clients.migration, POLICY_TABLES.usedChannelAssertions, 1);

		const refused = await presented();
		await refused.ended;
		await fault.remove();
		const rowsAfterRefusal = await usedAssertionRows(harness.clients.migration);
		const served = await presented();

		assert.equal(refused.status, 503);
		assert.equal(JSON.parse(refused.text()).code, 'storeUnavailable');
		assert.equal(rowsAfterRefusal, 0);
		assert.equal(served.status, 200);
		assert.equal(await usedAssertionRows(harness.clients.migration), 1);
	});

	test('refuses a validly signed assertion whose jti cannot be stored with the one 401 on the stream and on the exchange, recording it as unrepresentableJti, with no record written and no 503', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const searchApplication = harness.application(search);
		const cursors = await headCursors(harness);
		const unstorable = await Promise.all(
			['jti-with-a-\u0000-NUL', 'jti-with-an-\ud800-surrogate'].map((jti) =>
				signedAssertion(searchApplication, { claims: { jti } }),
			),
		);

		// The stream answers at once with its one refusal, and a refused stream never stays open, so no
		// presentation here waits on a body that would not end.
		const answers = await unstorable.reduce<Promise<readonly { code: unknown; status: number }[]>>(
			async (earlier, assertion) => {
				const stream = await rawStreamFrom(scope, harness.url, {
					application: searchApplication,
					assertion,
					lastEventId: cursors[search] ?? '',
				});
				await Promise.race([
					stream.ended,
					new Promise<undefined>((resolve) => {
						setTimeout(() => {
							resolve(undefined);
						}, WAIT_MS);
					}),
				]);
				const streamed = { code: JSON.parse(stream.text()).code, status: stream.status };
				const exchanged = await exchange(harness.url, { application: searchApplication, assertion });
				return [
					...(await earlier),
					streamed,
					{ code: JSON.parse(exchanged.body).code, status: exchanged.status },
				];
			},
			Promise.resolve([]),
		);
		const recorded = await eventually(
			async () => (await unstorableRejections(harness)).length === unstorable.length,
			WAIT_MS,
			50,
		);

		assert.deepEqual(
			answers,
			unstorable.flatMap(() => [
				{ code: 'channelAssertionRefused', status: 401 },
				{ code: 'channelAssertionRefused', status: 401 },
			]),
		);
		assert.equal(recorded, true, 'the refusals were not recorded as unrepresentableJti');
		assert.equal(await usedAssertionRows(harness.clients.migration), 0);
	});

	test('ends a stream opened under a key once that key is revoked', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startChannelHarness(scope);
		const application = harness.application(portal);
		const cursors = await headCursors(harness);
		const stream = await rawStreamFrom(scope, harness.url, {
			application,
			lastEventId: cursors[portal] ?? '',
		});

		const revokedAt = performance.now();
		assertSucceeded(
			await revokeApplicationKey(await administratorCaller(harness), application.id, application.keyId, {
				reason: 'compromised',
			}),
			"the revocation of the portal's key",
		);
		const endedAt = await Promise.race([
			stream.ended,
			new Promise<undefined>((resolve) => {
				setTimeout(() => {
					resolve(undefined);
				}, WAIT_MS);
			}),
		]);

		assert.equal(stream.status, 200);
		assert.ok(endedAt !== undefined, 'the stream outlived its key');
		assert.ok(endedAt - revokedAt < WAIT_MS);
	});
});
