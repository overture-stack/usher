import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	answerGrant,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	comparableRefusal,
	GRANT_REVOCATION_REASONS,
	personCaller,
	PROBLEMS,
	revokeGrant,
	SYSTEM_ASSIGNED_REASONS,
} from '../../../testing/harness/admin.js';
import {
	answeredInFixture,
	answerNames,
	answerNamesInstant,
	CAST,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	revocationReasonsRecorded,
	SHOWN,
	storedDecisions,
	storedGrant,
} from '../../../testing/fixtures/grants.js';
import { withHarness } from '../../../testing/harness/harness.js';
import { inTurn, seededId } from '../../../testing/harness/policy.js';

const recipientViewing = grantsFixture({
	decisions: [answeredInFixture('recipientViews')],
	grants: {
		recipientViews: fixtureGrant('recipient', 'viewer', {
			grantedBy: 'ownerOfA1',
		}),
	},
});

suite('revoking a grant', () => {
	test('revokes a live grant by its id', async () => {
		await withHarness({ fixture: recipientViewing }, async (harness) => {
			const grantId = seededId(harness.seeded.grants, 'recipientViews');

			const revoked = await revokeGrant(await administratorCaller(harness), grantId);

			assertSucceeded(revoked, 'the revocation');
			const stored = await storedGrant(harness, grantId);
			assert.equal(stored.revokerSubject, CAST.administrator.subject);
			assert.notEqual(stored.revokedAt, null);
			assert.ok(answerNames(revoked, CAST.administrator.subject), 'the answer names the revoker');
			assert.ok(
				stored.revokedAt !== null && answerNamesInstant(revoked, stored.revokedAt),
				'the answer names the revocation time',
			);
			assert.equal(stored.holderSubject, CAST.recipient.subject);
		});
	});

	test('answers an unknown or malformed grant id with the not-found answer', async () => {
		await withHarness({ fixture: recipientViewing }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const unknown = await revokeGrant(administrator, randomUUID());

			const malformed = await inTurn(['not-a-uuid', '../STUDY-A1', ''], async (id) => ({
				answer: await revokeGrant(administrator, id),
				name: `the id ${JSON.stringify(id)}`,
			}));
			const afterRefusals = await storedGrant(harness, seededId(harness.seeded.grants, 'recipientViews'));
			const held = await revokeGrant(administrator, seededId(harness.seeded.grants, 'recipientViews'));

			assertRefused(unknown, PROBLEMS.grantNotFound, 'an unknown id');
			malformed.forEach(({ answer, name }) => {
				assertRefused(answer, PROBLEMS.grantNotFound, name);
				assert.deepEqual(comparableRefusal(answer), comparableRefusal(unknown), name);
			});
			assert.equal(afterRefusals.revokedAt, null);
			assertSucceeded(held, 'revoking a grant by its id');
		});
	});

	test("keeps a grant's first revocation", async () => {
		await withHarness({ fixture: recipientViewing }, async (harness) => {
			const grantId = seededId(harness.seeded.grants, 'recipientViews');
			assertSucceeded(await revokeGrant(await administratorCaller(harness), grantId), 'the first revocation');
			const first = await storedGrant(harness, grantId);

			const again = await revokeGrant(
				await administratorCaller(harness, {
					person: CAST.secondAdministrator,
				}),
				grantId,
			);
			const afterwards = await storedGrant(harness, grantId);

			assertRefused(again, PROBLEMS.doesNotHold, 'a second revocation');
			assert.deepEqual(
				{
					revokedAt: afterwards.revokedAt,
					revoker: afterwards.revokerSubject,
				},
				{ revokedAt: first.revokedAt, revoker: CAST.administrator.subject },
			);
		});
	});

	test('revokes a pending, a declined, an accepted and an expired grant alike', async () => {
		const now = Date.now();
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [
						answeredInFixture('accepted'),
						answeredInFixture('declined', 'declined'),
						answeredInFixture('expired', 'accepted', new Date(now - 2 * HOUR_MS)),
					],
					grants: {
						accepted: fixtureGrant('recipient', 'viewer', {
							category: 'unmarked',
						}),
						declined: fixtureGrant('recipient', 'curator'),
						expired: fixtureGrant('recipient', 'editor', {
							expiresAt: new Date(now - HOUR_MS),
							grantedAt: new Date(now - 3 * HOUR_MS),
						}),
						pending: fixtureGrant('recipient', 'viewer'),
					},
				}),
			},
			async (harness) => {
				const states = ['accepted', 'declined', 'expired', 'pending'];
				const grantIds = states.map((state) => seededId(harness.seeded.grants, state));
				const decisionsBefore = await inTurn(grantIds, (id) => storedDecisions(harness, id));
				const administrator = await administratorCaller(harness);

				const revoked = await inTurn(grantIds, (id) => revokeGrant(administrator, id));

				const decisionsAfter = await inTurn(grantIds, (id) => storedDecisions(harness, id));
				const stored = await inTurn(grantIds, (id) => storedGrant(harness, id));
				revoked.forEach((answer, index) => {
					assertSucceeded(answer, `revoking the ${states[index] ?? ''} grant`);
				});
				stored.forEach(({ revokedAt, revokerSubject }) => {
					assert.notEqual(revokedAt, null);
					assert.equal(revokerSubject, CAST.administrator.subject);
				});
				assert.deepEqual(decisionsAfter, decisionsBefore);
				assert.deepEqual(
					decisionsBefore.map((decisions) => decisions.length),
					[1, 1, 1, 0],
				);
			},
		);
	});

	test('keeps every owned resource with at least one owner', async () => {
		const now = Date.now();
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('revokedOwner', 'accepted', new Date(now - 2 * HOUR_MS))],
					grants: {
						revokedOwner: fixtureGrant('spare', 'owner', {
							category: null,
							grantedAt: new Date(now - 3 * HOUR_MS),
							revoked: { at: new Date(now - HOUR_MS), by: 'ownerOfA1' },
						}),
						pendingOwner: fixtureGrant('recipient', 'owner', {
							category: null,
						}),
					},
				}),
			},
			async (harness) => {
				const onlyOwnership = seededId(harness.seeded.grants, 'ownsA1');
				const administrator = await administratorCaller(harness);

				const whileAlone = await revokeGrant(administrator, onlyOwnership);
				const afterRefusal = await storedGrant(harness, onlyOwnership);
				assertSucceeded(
					await answerGrant(
						await personCaller(harness, CAST.recipient),
						seededId(harness.seeded.grants, 'pendingOwner'),
						{ capabilities: SHOWN.owner, decision: 'accept' },
					),
					'the second owner accepting',
				);
				const withSecondOwner = await revokeGrant(administrator, onlyOwnership);
				const afterRevocation = await storedGrant(harness, onlyOwnership);

				assertRefused(whileAlone, PROBLEMS.resourceNeedsAnOwner, "the last accepted owner's grant");
				assert.equal(afterRefusal.revokedAt, null);
				assertSucceeded(withSecondOwner, 'revoking one of two owners');
				assert.notEqual(afterRevocation.revokedAt, null);
			},
		);
	});

	test("takes a revocation's reason only from the vocabulary a caller may give", async () => {
		const tuples = ['viewer', 'editor', 'curator', 'submitter'].flatMap((role) =>
			['controlled', 'unmarked'].map((category) => ({ category, role })),
		);
		await withHarness(
			{
				fixture: grantsFixture({
					grants: Object.fromEntries(
						tuples.map(({ category, role }, index) => [
							`revoked${index}`,
							fixtureGrant('recipient', role, {
								category,
								grantedBy: 'ownerOfA1',
							}),
						]),
					),
				}),
			},
			async (harness) => {
				const reasons = Object.values(GRANT_REVOCATION_REASONS);
				const grantIds = tuples.map((_tuple, index) => seededId(harness.seeded.grants, `revoked${index}`));
				const [unreasoned, ...reasoned] = grantIds;
				if (unreasoned === undefined) {
					return assert.fail('the fixture holds no grant');
				}
				const administrator = await administratorCaller(harness);

				const refused = await inTurn(
					['left the study', SYSTEM_ASSIGNED_REASONS.resourceRetired, SYSTEM_ASSIGNED_REASONS.unspecified],
					async (reason) => ({
						answer: await revokeGrant(administrator, unreasoned, { reason }),
						reason,
					}),
				);
				const afterRefusals = await storedGrant(harness, unreasoned);
				const accepted = await inTurn(
					reasons.map((reason, index) => ({
						grantId: reasoned[index] ?? '',
						reason,
					})),
					async ({ grantId, reason }) => ({
						answer: await revokeGrant(administrator, grantId, { reason }),
						grantId,
						reason,
					}),
				);
				const noReason = await revokeGrant(administrator, unreasoned);

				assert.equal(reasoned.length, reasons.length);
				refused.forEach(({ answer, reason }) => {
					assertRuleBroken(answer, `the reason ${reason}`);
				});
				assert.equal(afterRefusals.revokedAt, null);
				const revoked = await inTurn(accepted, async ({ answer, grantId, reason }) => {
					assertSucceeded(answer, `the reason ${reason}`);
					return (await storedGrant(harness, grantId)).revokedAt !== null;
				});
				assert.deepEqual(
					revoked,
					reasons.map(() => true),
				);
				assertSucceeded(noReason, 'a revocation giving no reason');
				assert.deepEqual(await revocationReasonsRecorded(harness, unreasoned), [
					SYSTEM_ASSIGNED_REASONS.unspecified,
				]);
				assert.deepEqual(
					await inTurn(accepted, ({ grantId }) => revocationReasonsRecorded(harness, grantId)),
					reasons.map((reason) => [reason]),
				);
			},
		);
	});
});
