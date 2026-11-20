import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	answerGrant,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	createGrant,
	personCaller,
	PROBLEMS,
	revokeGrant,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { fixedClock } from '../../testing/peripherals/clocks.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import { selectRows } from '../../testing/fixtures/database.js';
import {
	answeredInFixture,
	B2_OWN_CATEGORY,
	CAST,
	createdId,
	fixtureGrant,
	grantFor,
	grantsFixture,
	HOUR_MS,
	racedAtTheGrantsTable,
	rowCounts,
	SHOWN,
	storedDecisions,
	storedGrants,
	STUDY_A1,
	UNKNOWN_STUDY,
	UNMARKED,
} from '../../testing/fixtures/grants.js';
import { withHarness } from '../../testing/harness/harness.js';
import {
	highestPosition,
	inTurn,
	noticesAfter,
	POLICY_TABLES,
	qualified,
	seededId,
	usersWithSubject,
} from '../../testing/harness/policy.js';

const { grants } = POLICY_TABLES;

// Cy's viewer grant on STUDY-A1 under `unmarked`, accepted, which expired an hour ago.
const withExpiredViewing = (now: number): ReturnType<typeof grantsFixture> =>
	grantsFixture({
		decisions: [answeredInFixture('expired', 'accepted', new Date(now - 2 * HOUR_MS))],
		grants: {
			expired: fixtureGrant('recipient', 'viewer', {
				category: 'unmarked',
				expiresAt: new Date(now - HOUR_MS),
				grantedAt: new Date(now - 3 * HOUR_MS),
			}),
		},
	});

suite("a grant's creation in the store", () => {
	test('commits the grant, its holder met first, its acceptance under auto-accept, its notices and its grant.creation together', async () => {
		await withHarness({ configuration: { autoAccept: true }, fixture: grantsFixture() }, async (harness) => {
			const client = harness.clients.migration;
			const since = await highestPosition(client);
			const before = await usersWithSubject(client, CAST.newcomer.subject);

			const grantId = createdId(
				await createGrant(await personCaller(harness, CAST.ownerOfA1), grantFor(CAST.newcomer)),
				'the creation',
			);

			assert.equal(before, 0);
			assert.equal(await usersWithSubject(client, CAST.newcomer.subject), 1);
			assert.deepEqual(
				(await storedDecisions(harness, grantId)).map(({ capabilities, decision, deciderSubject }) => ({
					capabilities,
					decider: deciderSubject,
					decision,
				})),
				[
					{
						capabilities: SHOWN.viewer,
						decider: CAST.newcomer.subject,
						decision: 'accepted',
					},
				],
			);
			assert.ok((await noticesAfter(client, since)).length > 0);
			const created = (await auditRows(client))
				.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
				.map(dataOf)
				.filter((data) => data['grantId'] === grantId);
			assert.equal(created.length, 1);
			assert.equal(created[0]?.['granteeId'], CAST.newcomer.subject);
		});
	});

	test('writes nothing of a refused creation, the person it would have met included', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const before = await rowCounts(harness);

			const refused = await createGrant(
				await personCaller(harness, CAST.ownerOfA1),
				grantFor(CAST.newcomer, { category: B2_OWN_CATEGORY }),
			);

			assertRuleBroken(refused, "another resource's own category");
			assert.deepEqual(await rowCounts(harness), before);
		});
	});

	test('ends an expired grant on the same terms and writes the new one beside it, keeping the old one otherwise as it was', async () => {
		const now = Date.now();
		await withHarness({ fixture: withExpiredViewing(now) }, async (harness) => {
			const [expired] = await storedGrants(harness, {
				holder: CAST.recipient.subject,
			});

			const grantId = createdId(
				await createGrant(
					await personCaller(harness, CAST.ownerOfA1),
					grantFor(CAST.recipient, { category: UNMARKED }),
				),
				'the creation again',
			);

			const held = await storedGrants(harness, {
				holder: CAST.recipient.subject,
			});
			assert.deepEqual(
				held.map(({ id }) => id),
				[expired?.id, grantId],
			);
			assert.deepEqual(held[0], expired);
			const [ended] = await selectRows<{ endedAt: Date | null }>(
				harness.clients.migration,
				`SELECT ${grants.columns.endedAt} AS "endedAt" FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
				[expired?.id],
			);
			assert.ok((ended?.endedAt?.getTime() ?? 0) >= now, 'the expired grant ended at the creation');
		});
	});

	test('keeps one grant when two creations race to end one expired grant on their terms, answering the other 409 alreadyHolds', async () => {
		const now = Date.now();
		await withHarness({ fixture: withExpiredViewing(now) }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);

			const answers = await racedAtTheGrantsTable(harness, 2, () =>
				createGrant(owner, grantFor(CAST.recipient, { category: UNMARKED })),
			);

			const created = answers.filter(({ status }) => status >= 200 && status < 300);
			const lost = answers.filter(({ status }) => status >= 300);
			assert.equal(created.length, 1);
			lost.forEach((answer) => {
				assertRefused(answer, PROBLEMS.alreadyHolds, 'the losing creation');
			});
			const held = await storedGrants(harness, {
				holder: CAST.recipient.subject,
			});
			assert.equal(held.length, 2);
		});
	});

	test("names in a refused creation's event a resource registered under the externalId its body names, and none for an externalId no resource holds", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const caller = await personCaller(harness, CAST.outsider);

			const answers = [
				await createGrant(caller, grantFor(CAST.newcomer)),
				await createGrant(caller, grantFor(CAST.newcomer, { resource: UNKNOWN_STUDY })),
			];
			const refusals = (await auditRows(harness.clients.migration))
				.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
				.map(dataOf)
				.filter((data) => data['actorId'] === CAST.outsider.subject);

			answers.forEach((answer) => {
				assertRefused(answer, PROBLEMS.resourceNotFound, 'the creation');
			});
			assert.deepEqual(
				refusals.map((data) =>
					Object.hasOwn(data, 'resourceId') ? [data['reason'], data['resourceId']] : [data['reason']],
				),
				[['noAuthorityOnResource', STUDY_A1], ['resourceNotFound']],
			);
		});
	});
});

suite("a grant's answers and revocation in the store", () => {
	test("orders a holder's answers given on one configured instant, each a millisecond after the one before", async () => {
		await withHarness(
			{
				configuration: { clock: fixedClock(Date.now()) },
				fixture: grantsFixture({
					grants: { pending: fixtureGrant('recipient', 'viewer') },
				}),
			},
			async (harness) => {
				const grantId = seededId(harness.seeded.grants, 'pending');
				const recipient = await personCaller(harness, CAST.recipient);

				const answers = await inTurn(['accepted', 'rejected', 'accepted'] as const, (decision) =>
					answerGrant(recipient, grantId, {
						capabilities: SHOWN.viewer,
						decision,
					}),
				);

				answers.forEach((answer, index) => {
					assertSucceeded(answer, `answer ${index}`);
				});
				const instants = (await storedDecisions(harness, grantId)).map(({ decidedAt }) => decidedAt.getTime());
				const [first = 0] = instants;
				assert.deepEqual(instants, [first, first + 1, first + 2]);
			},
		);
	});

	test("keeps a resource's last owner when its two owners' grants are revoked at once, answering the later 409 resourceNeedsAnOwner", async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('alsoOwnsA1')],
					grants: {
						alsoOwnsA1: fixtureGrant('spare', 'owner', { category: null }),
					},
				}),
			},
			async (harness) => {
				const administrator = await administratorCaller(harness);
				const ownerships = ['ownsA1', 'alsoOwnsA1'].map((name) => seededId(harness.seeded.grants, name));
				const held = await holdTable(harness.database, grants);
				const revoking = Promise.all(ownerships.map((grantId) => revokeGrant(administrator, grantId)));
				const blocked = await untilBlocked(harness.clients.migration, revoking, { count: 2 });
				await held.release();

				const answers = await revoking;

				assert.ok(blocked, 'both revocations waited on the grants table');

				assert.deepEqual(answers.map(({ status }) => status).toSorted(), [200, 409]);
				answers
					.filter(({ status }) => status === 409)
					.forEach((answer) => {
						assertRefused(answer, PROBLEMS.resourceNeedsAnOwner, 'the later');
					});
				const live = (await storedGrants(harness, { resource: STUDY_A1, role: 'owner' })).filter(
					({ revokedAt }) => revokedAt === null,
				);
				assert.equal(live.length, 1);
			},
		);
	});
});
