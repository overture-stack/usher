import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	administratorCaller,
	assertRefused,
	assertSucceeded,
	changeGrantExpiry,
	changeGrantRole,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	personCaller,
	PROBLEMS,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { distinctContents, principalNotice } from '../../testing/fixtures/database.js';
import {
	answeredInFixture,
	CAST,
	createdId,
	fixtureGrant,
	grantFor,
	grantsFixture,
	HOUR_MS,
	selfGrantUntil,
	SHOWN,
	storedDecisions,
	storedGrant,
	storedGrants,
	STUDY_A1,
} from '../../testing/fixtures/grants.js';
import { withHarness } from '../../testing/harness/harness.js';
import { highestPosition, noticesAfter, seededId } from '../../testing/harness/policy.js';

const DAY_MS = 24 * HOUR_MS;

const instantIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

// Cy's accepted viewer grant on STUDY-A1 ending in a day, an expired one on `unmarked` nothing
// replaced, and the spare owner's accepted owner grant on STUDY-A1.
const fixture = (): ReturnType<typeof grantsFixture> =>
	grantsFixture({
		decisions: [
			answeredInFixture('ending'),
			answeredInFixture('expired', 'accepted', new Date(Date.now() - 2 * DAY_MS)),
			answeredInFixture('spareOwnsA1'),
		],
		grants: {
			ending: fixtureGrant('recipient', 'viewer', {
				expiresAt: new Date(Date.now() + DAY_MS),
			}),
			expired: fixtureGrant('recipient', 'viewer', {
				category: 'unmarked',
				expiresAt: new Date(Date.now() - HOUR_MS),
				grantedAt: new Date(Date.now() - 3 * DAY_MS),
			}),
			spareOwnsA1: fixtureGrant('spare', 'owner', { category: null }),
		},
	});

const stateOf = (answer: AdminResponse): unknown =>
	typeof answer.body === 'object' && answer.body !== null ? Reflect.get(answer.body, 'state') : undefined;

suite("a grant's change in the store", () => {
	test("moves a grant's end, writing a principal notice for its holder alone, and revives an expired grant nothing replaced", async () => {
		await withHarness({ fixture: fixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const client = harness.clients.migration;
			const later = instantIn(2 * DAY_MS);
			const since = await highestPosition(client);

			const extended = await changeGrantExpiry(owner, seededId(harness.seeded.grants, 'ending'), later);
			const notices = await noticesAfter(client, since);
			const revived = await changeGrantExpiry(owner, seededId(harness.seeded.grants, 'expired'), later);

			assertSucceeded(extended, 'the extension');
			assert.equal(
				(await storedGrant(harness, seededId(harness.seeded.grants, 'ending'))).expiresAt?.getTime(),
				Date.parse(later),
			);
			assert.deepEqual(distinctContents(notices), [principalNotice(CAST.recipient.subject)]);
			assertSucceeded(revived, 'the revival');
			assert.equal(stateOf(revived), 'accepted');
		});
	});

	test('refuses a grant a newer grant on its terms replaced 409 grantReplaced, leaving it as it was', async () => {
		await withHarness({ fixture: fixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const expiredId = seededId(harness.seeded.grants, 'expired');
			createdId(
				await createGrant(owner, grantFor(CAST.recipient, { category: 'global.unmarked' })),
				'the newer grant',
			);

			const refused = await changeGrantExpiry(owner, expiredId, instantIn(DAY_MS));

			assertRefused(refused, PROBLEMS.grantReplaced, 'the replaced grant');
			assert.ok(((await storedGrant(harness, expiredId)).expiresAt?.getTime() ?? 0) < Date.now());
		});
	});

	test("changes a grant's role leaving its holder's answers as they were, and refuses one colliding with a grant held on its terms 409 alreadyHolds", async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('views'), answeredInFixture('edits')],
					grants: {
						edits: fixtureGrant('recipient', 'editor'),
						views: fixtureGrant('recipient', 'viewer'),
					},
				}),
			},
			async (harness) => {
				const owner = await personCaller(harness, CAST.ownerOfA1);
				const viewsId = seededId(harness.seeded.grants, 'views');

				const widened = await changeGrantRole(owner, viewsId, 'curator');
				const colliding = await changeGrantRole(owner, viewsId, 'editor');

				assertSucceeded(widened, 'the widening');
				assert.equal((await storedGrant(harness, viewsId)).role, 'curator');
				assert.deepEqual(
					(await storedDecisions(harness, viewsId)).map(({ capabilities }) => capabilities),
					[SHOWN.viewer],
				);
				assertRefused(colliding, PROBLEMS.alreadyHolds, 'the collision');
				assert.equal((await storedGrant(harness, viewsId)).role, 'curator');
			},
		);
	});

	test('refuses an expiry on an owner grant 422 ownerGrantsDoNotExpire', async () => {
		await withHarness({ fixture: fixture() }, async (harness) => {
			const refused = await changeGrantExpiry(
				await personCaller(harness, CAST.ownerOfA1),
				seededId(harness.seeded.grants, 'spareOwnsA1'),
				instantIn(DAY_MS),
			);

			assertRefused(refused, PROBLEMS.ownerGrantsDoNotExpire, "the owner grant's expiry");
		});
	});

	test("holds a granted self-grant's end within the longest self-grant life of its request", async () => {
		await withHarness({ fixture: fixture() }, async (harness) => {
			const longest = harness.configuration.selfGrantMaximumLifetimeSeconds * 1000;
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const asked = await createSelfGrant(
				await administratorCaller(harness),
				selfGrantUntil(instantIn(2 * HOUR_MS)),
			);
			const grantId = createdId(
				await decideGrantRequest(owner, createdId(asked, 'the request'), 'grant'),
				'the grant',
			);

			const tooLong = await changeGrantExpiry(owner, grantId, instantIn(longest + HOUR_MS));
			const removed = await changeGrantExpiry(owner, grantId, null);
			const within = await changeGrantExpiry(owner, grantId, instantIn(longest - HOUR_MS));

			assertRefused(tooLong, PROBLEMS.selfGrantTooLong, 'too long');
			assertRefused(removed, PROBLEMS.selfGrantExpiryRequired, 'no expiry');
			assertSucceeded(within, 'within the longest life');
			assert.deepEqual(
				(
					await storedGrants(harness, {
						holder: CAST.administrator.subject,
						resource: STUDY_A1,
					})
				).length,
				1,
			);
		});
	});

	test("refuses a platform administrator extending a grant they hold 403 selfWideningNotPermitted, leaving its end, and names the grant on an owner's extension of it", async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('administratorSubmits')],
					grants: {
						administratorSubmits: fixtureGrant('administrator', 'submitter', {
							expiresAt: new Date(Date.now() + DAY_MS),
						}),
					},
					users: { administrator: { subject: CAST.administrator.subject } },
				}),
			},
			async (harness) => {
				const grantId = seededId(harness.seeded.grants, 'administratorSubmits');
				const ending = (await storedGrant(harness, grantId)).expiresAt;

				const refused = await changeGrantExpiry(
					await administratorCaller(harness),
					grantId,
					instantIn(2 * DAY_MS),
				);
				const kept = (await storedGrant(harness, grantId)).expiresAt;
				const extended = await changeGrantExpiry(
					await personCaller(harness, CAST.ownerOfA1),
					grantId,
					instantIn(2 * DAY_MS),
				);
				const extensions = (await auditRows(harness.clients.migration))
					.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantExtension))
					.map(dataOf)
					.filter((data) => data['result'] === 'succeeded');

				assertRefused(
					refused,
					PROBLEMS.selfWideningNotPermitted,
					"the administrator's extension of their own grant",
				);
				assert.deepEqual(kept, ending);
				assertSucceeded(extended, "the owner's extension");
				assert.deepEqual(
					extensions.map((data) => data['grantId']),
					[grantId],
				);
			},
		);
	});
});
