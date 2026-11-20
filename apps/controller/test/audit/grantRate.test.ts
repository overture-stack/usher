import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	assertForbidden,
	assertSucceeded,
	createGrant,
	type GrantCreated,
	personCaller,
	PROBLEMS,
} from '../../testing/harness/admin.js';
import { SEVERITY_ATTRIBUTE } from '../../testing/harness/auditEvents.js';
import { PEOPLE, type Person } from '../../testing/harness/exchange.js';
import {
	type AuditHarness,
	type AuditHarnessOptions,
	auditPolicy,
	auditRowsOfType,
	awaitEventsOfType,
	awaitOneEvent,
	BOUNDARY_RATE_THRESHOLD,
	CONTROLLED,
	dataOf,
	decided,
	eventsIn,
	exchangeBy,
	markOf,
	ofType,
	RATE_THRESHOLD,
	RESOURCES,
	startLoggedInstance,
	storedGrant,
	untilInstant,
	withAuditHarness,
} from '../../testing/fixtures/audit.js';
import { inTurn, type PolicyFixture } from '../../testing/harness/policy.js';
import { cleanupFor, eventually } from '../../testing/harness/waiting.js';

type Target = readonly [Person, string];

const WINDOW_MS = RATE_THRESHOLD.windowSeconds * 1000;

const BOUNDARY_WINDOW_MS = BOUNDARY_RATE_THRESHOLD.windowSeconds * 1000;

// Two either side of a window-length boundary, all four within one window of each other.
const BOUNDARY_OFFSETS_MS = Object.freeze([3500, 4500, 5500, 6500]);

const rateFixture = (): PolicyFixture =>
	auditPolicy({
		decisions: [decided('danaOwnsA1')],
		grants: {
			danaOwnsA1: {
				category: null,
				holder: { user: 'dana' },
				resource: RESOURCES.a1,
				role: 'owner',
			},
		},
	});

const rateOptions: AuditHarnessOptions = {
	configuration: { grantRateThreshold: RATE_THRESHOLD },
	fixture: rateFixture(),
};

const boundaryOptions: AuditHarnessOptions = {
	configuration: { grantRateThreshold: BOUNDARY_RATE_THRESHOLD },
	fixture: rateFixture(),
};

const TARGETS: readonly Target[] = Object.freeze([
	[PEOPLE.ana, RESOURCES.a1],
	[PEOPLE.bo, RESOURCES.a1],
	[PEOPLE.cy, RESOURCES.a1],
	[PEOPLE.eli, RESOURCES.a1],
	[PEOPLE.ana, RESOURCES.b2],
	[PEOPLE.bo, RESOURCES.b2],
]);

const targets = (from: number, count: number): readonly Target[] => TARGETS.slice(from, from + count);

const grantEach = (caller: AdminCaller, each: readonly Target[]): Promise<readonly GrantCreated[]> =>
	inTurn(each, ([person, resource]) =>
		createGrant(caller, {
			category: CONTROLLED,
			holder: { subject: person.subject },
			resource,
			role: 'viewer',
		}),
	);

const crossings = async ({ harness, log }: AuditHarness): Promise<number> => {
	const stored = await auditRowsOfType(harness.clients.migration, 'grant.rateExceeded');
	const logged = ofType(eventsIn(log), 'grant.rateExceeded');
	assert.equal(stored.length, logged.length, 'the log and the store agree');
	return logged.length;
};

const afterBarrier = async ({ harness, log }: AuditHarness): Promise<void> => {
	const barrier = markOf(log);
	await exchangeBy(harness, PEOPLE.ana);
	await awaitOneEvent(log, 'token.exchange', { since: barrier });
};

const untilCreationsLogged = async ({ log }: AuditHarness, count: number, since: number): Promise<void> => {
	await awaitEventsOfType(log, 'grant.creation', { count, since });
};

suite('grant.rateExceeded', () => {
	test("records grant.rateExceeded when one actor's grant operations cross the configured count within the window", async () => {
		await withAuditHarness(rateOptions, async ({ harness, log }) => {
			const since = markOf(log);
			const started = Date.now();

			const created = await grantEach(await personCaller(harness, PEOPLE.owner), targets(0, 4));
			assert.ok(Date.now() - started < WINDOW_MS, 'the creations fell within the window');
			const event = await awaitOneEvent(log, 'grant.rateExceeded', { since });
			const data = dataOf(event);

			created.forEach((answer) => {
				assertSucceeded(answer, 'a creation');
			});
			assert.equal(data['actorId'], PEOPLE.owner.subject);
			assert.equal(data['operationCount'], 4);
			assert.equal(data['windowSeconds'], RATE_THRESHOLD.windowSeconds);
			assert.equal(Object.hasOwn(data, 'result'), false);
			assert.equal(event[SEVERITY_ATTRIBUTE], 'warning');
		});
	});

	test('completes the operation that crosses the threshold', async () => {
		await withAuditHarness(rateOptions, async ({ harness, log }) => {
			const since = markOf(log);

			const created = await grantEach(await personCaller(harness, PEOPLE.owner), targets(0, 4));
			await awaitOneEvent(log, 'grant.rateExceeded', { since });
			const crossing = created.at(-1);

			assert.ok(crossing);
			assertSucceeded(crossing, 'the crossing creation');
			assert.equal(typeof crossing.grantId, 'string');
			assert.equal((await storedGrant(harness.clients.migration, crossing.grantId ?? '')).revokedAt, null);
		});
	});

	test("counts one actor's operations across every controller instance", async (context) => {
		await withAuditHarness(
			rateOptions,
			async (audit) => {
				const { harness } = audit;
				const beside = await startLoggedInstance(cleanupFor(context), harness);

				const here = await grantEach(await personCaller(harness, PEOPLE.owner), targets(0, 2));
				const there = await grantEach(
					await personCaller(harness, PEOPLE.owner, {
						url: beside.instance.url,
					}),
					targets(2, 2),
				);
				const recorded = await eventually(
					async () => (await auditRowsOfType(harness.clients.migration, 'grant.rateExceeded')).length >= 1,
					10_000,
				);
				await afterBarrier(audit);
				const stored = await auditRowsOfType(harness.clients.migration, 'grant.rateExceeded');

				[...here, ...there].forEach((answer) => {
					assertSucceeded(answer, 'a creation');
				});
				assert.ok(recorded, 'a grant.rateExceeded was stored');
				assert.equal(stored.length, 1);
			},
			context,
		);
	});

	test('counts operations either side of a clock boundary together', async () => {
		await withAuditHarness(boundaryOptions, async (audit) => {
			const { harness, log } = audit;
			const owner = await personCaller(harness, PEOPLE.owner);
			const boundary = Math.ceil((Date.now() + 2000) / BOUNDARY_WINDOW_MS) * BOUNDARY_WINDOW_MS;
			const since = markOf(log);

			const created = await inTurn(
				BOUNDARY_OFFSETS_MS.map((offset, index) => ({ index, offset })),
				async ({ index, offset }) => {
					await untilInstant(boundary + offset);
					return grantEach(owner, targets(index, 1));
				},
			);
			const event = await awaitOneEvent(log, 'grant.rateExceeded', { since });

			created.flat().forEach((answer) => {
				assertSucceeded(answer, 'a creation');
			});
			assert.equal(dataOf(event)['actorId'], PEOPLE.owner.subject);
		});
	});

	test("counts each actor's operations apart", async () => {
		await withAuditHarness(rateOptions, async (audit) => {
			const { harness, log } = audit;
			const owner = await personCaller(harness, PEOPLE.owner);
			const dana = await personCaller(harness, PEOPLE.dana);
			const since = markOf(log);

			const apart = [...(await grantEach(owner, targets(0, 2))), ...(await grantEach(dana, targets(2, 2)))];
			await untilCreationsLogged(audit, 4, since);
			const beforeMore = await crossings(audit);
			const more = await grantEach(owner, targets(4, 2));
			const event = await awaitOneEvent(log, 'grant.rateExceeded', { since });

			[...apart, ...more].forEach((answer) => {
				assertSucceeded(answer, 'a creation');
			});
			assert.equal(beforeMore, 0);
			assert.equal(dataOf(event)['actorId'], PEOPLE.owner.subject);
		});
	});

	test('records no grant.rateExceeded for operations at the configured count', async () => {
		await withAuditHarness(rateOptions, async (audit) => {
			const { harness, log } = audit;
			const owner = await personCaller(harness, PEOPLE.owner);
			const since = markOf(log);

			const atCount = await grantEach(owner, targets(0, 3));
			await untilCreationsLogged(audit, 3, since);
			const atTheCount = await crossings(audit);
			const past = await grantEach(owner, targets(3, 1));
			const event = await awaitOneEvent(log, 'grant.rateExceeded', { since });

			[...atCount, ...past].forEach((answer) => {
				assertSucceeded(answer, 'a creation');
			});
			assert.equal(atTheCount, 0);
			assert.equal(dataOf(event)['operationCount'], 4);
		});
	});

	test('counts every grant operation attempted, a refused one included', async () => {
		await withAuditHarness(rateOptions, async ({ harness, log }) => {
			const owner = await personCaller(harness, PEOPLE.owner);
			const since = markOf(log);

			const allowed = await grantEach(owner, targets(0, 2));
			const refused = await grantEach(owner, [
				[PEOPLE.ana, RESOURCES.d4],
				[PEOPLE.bo, RESOURCES.d4],
			]);
			const event = await awaitOneEvent(log, 'grant.rateExceeded', { since });

			allowed.forEach((answer) => {
				assertSucceeded(answer, 'an allowed creation');
			});
			assert.equal(refused.length, 2);
			refused.forEach((answer) => {
				assertForbidden(
					answer,
					"a creation on a resource the owner doesn't own",
					PROBLEMS.noAuthorityOnResource.code,
				);
			});
			assert.equal(dataOf(event)['operationCount'], 4);
		});
	});

	test('records one grant.rateExceeded per crossing, however many operations follow it within the window', async () => {
		await withAuditHarness(rateOptions, async (audit) => {
			const { harness, log } = audit;
			const since = markOf(log);

			const created = await grantEach(await personCaller(harness, PEOPLE.owner), targets(0, 6));
			await awaitEventsOfType(log, 'grant.rateExceeded', { since });
			await untilCreationsLogged(audit, 6, since);
			await afterBarrier(audit);

			created.forEach((answer) => {
				assertSucceeded(answer, 'a creation');
			});
			assert.equal(await crossings(audit), 1);
		});
	});
});
