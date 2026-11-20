import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	answerGrant,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	assertUnreadable,
	comparableRefusal,
	type GrantDecision,
	personCaller,
	PROBLEMS,
} from '../../../testing/harness/admin.js';
import {
	CAST,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	SHOWN,
	type StoredDecision,
	storedDecisions,
	storedGrant,
	STUDY_A1,
	STUDY_B2,
	withdrawCapabilityInStore,
} from '../../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../../testing/harness/harness.js';
import { inTurn, seededId } from '../../../testing/harness/policy.js';

const ACCEPTING: GrantDecision = {
	capabilities: SHOWN.viewer,
	decision: 'accepted',
};

const REJECTING: GrantDecision = {
	capabilities: SHOWN.viewer,
	decision: 'rejected',
};

const pendingForRecipient = grantsFixture({
	grants: { pending: fixtureGrant('recipient', 'viewer') },
});

const pendingId = (harness: Harness): string => seededId(harness.seeded.grants, 'pending');

const recipientOf = (harness: Harness): Promise<AdminCaller> => personCaller(harness, CAST.recipient);

const answersInTurn = (
	caller: AdminCaller,
	grantId: string,
	decisions: readonly GrantDecision[],
): Promise<readonly Awaited<ReturnType<typeof answerGrant>>[]> =>
	inTurn(decisions, (decision) => answerGrant(caller, grantId, decision));

suite('answering a grant', () => {
	test("records the recipient's acceptance with the capabilities they were shown", async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const sentAt = Date.now();

			const answered = await answerGrant(await recipientOf(harness), pendingId(harness), ACCEPTING);
			const answeredAt = Date.now();

			assertSucceeded(answered, 'the acceptance');
			const decisions = await storedDecisions(harness, pendingId(harness));
			assert.deepEqual(
				decisions.map(({ capabilities, decision, deciderSubject }) => ({
					capabilities,
					decider: deciderSubject,
					decision,
				})),
				[
					{
						capabilities: SHOWN.viewer,
						decider: CAST.recipient.subject,
						decision: 'accepted',
					},
				],
			);
			const [acceptance] = decisions;
			const decidedAt = acceptance?.decidedAt.getTime() ?? Number.NaN;
			assert.ok(
				decidedAt >= sentAt - 1000 && decidedAt <= answeredAt + 1000,
				'the decision is timed at its answer',
			);
		});
	});

	test("records the recipient's decline", async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const answered = await answerGrant(await recipientOf(harness), pendingId(harness), REJECTING);

			assertSucceeded(answered, 'the decline');
			assert.deepEqual(
				(await storedDecisions(harness, pendingId(harness))).map(({ decision, deciderSubject }) => ({
					decider: deciderSubject,
					decision,
				})),
				[{ decider: CAST.recipient.subject, decision: 'rejected' }],
			);
		});
	});

	test("accepts an answer only from the grant's holder", async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const callers = {
				"a token carrying the holder's address under another subject": await personCaller(
					harness,
					CAST.lookalike,
					{
						mint: {
							claims: {
								email: CAST.recipient.email,
								preferred_username: CAST.recipient.email,
							},
						},
					},
				),
				'an administrator': await administratorCaller(harness),
				'an outsider': await personCaller(harness, CAST.outsider),
				"the resource's owner": await personCaller(harness, CAST.ownerOfA1),
			};

			const refused = await inTurn(Object.entries(callers), async ([name, caller]) => ({
				answer: await answerGrant(caller, pendingId(harness), ACCEPTING),
				name,
			}));
			const afterRefusals = await storedDecisions(harness, pendingId(harness));
			const byHolder = await answerGrant(await recipientOf(harness), pendingId(harness), ACCEPTING);

			refused.forEach(({ answer, name }) => {
				assertRefused(answer, PROBLEMS.grantNotFound, name);
			});
			assert.deepEqual(afterRefusals, []);
			assertSucceeded(byHolder, "the holder's answer");
			assert.equal((await storedDecisions(harness, pendingId(harness))).length, 1);
		});
	});

	test('appends every answer and reads the latest as current', async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const answers = await answersInTurn(await recipientOf(harness), pendingId(harness), [
				ACCEPTING,
				REJECTING,
				ACCEPTING,
			]);

			answers.forEach((answer, index) => {
				assertSucceeded(answer, `answer ${index}`);
			});
			const decisions = await storedDecisions(harness, pendingId(harness));
			assert.deepEqual(
				decisions.map(({ decision }) => decision),
				['accepted', 'rejected', 'accepted'],
			);
			decisions.slice(1).forEach(({ decidedAt }, index) => {
				assert.ok(
					decidedAt.getTime() > (decisions[index]?.decidedAt.getTime() ?? 0),
					'each answer is later than the one before',
				);
			});
			assert.equal(decisions.at(-1)?.decision, 'accepted');
		});
	});

	test('orders answers given within one second', async () => {
		const studies = [
			{ category: 'controlled', resource: STUDY_A1 },
			{ category: 'unmarked', resource: STUDY_A1 },
			{ category: 'controlled', resource: STUDY_B2 },
		];
		await withHarness(
			{
				fixture: grantsFixture({
					grants: Object.fromEntries(
						studies.map(({ category, resource }, attempt) => [
							`attempt${attempt}`,
							fixtureGrant('recipient', 'viewer', { category, resource }),
						]),
					),
				}),
			},
			async (harness) => {
				const recipient = await recipientOf(harness);
				const answerPair = async (attempt: number): Promise<readonly StoredDecision[] | undefined> => {
					if (attempt >= studies.length) {
						return undefined;
					}
					const grantId = seededId(harness.seeded.grants, `attempt${attempt}`);
					const answers = await answersInTurn(recipient, grantId, [REJECTING, ACCEPTING]);
					answers.forEach((answer, index) => {
						assertSucceeded(answer, `attempt ${attempt}, answer ${index}`);
					});
					const decisions = await storedDecisions(harness, grantId);
					const [first, last] = decisions;
					return first !== undefined &&
						last !== undefined &&
						last.decidedAt.getTime() - first.decidedAt.getTime() < 1000
						? decisions
						: answerPair(attempt + 1);
				};

				const withinOneSecond = await answerPair(0);

				assert.ok(
					withinOneSecond !== undefined,
					'a pair of answers landed within one second in three attempts',
				);
				const [declined, accepted] = withinOneSecond;
				assert.equal(declined?.decision, 'rejected');
				assert.equal(accepted?.decision, 'accepted');
				assert.ok(
					accepted !== undefined && declined !== undefined && accepted.decidedAt > declined.decidedAt,
					'the later answer is current',
				);
			},
		);
	});

	test('accepts only the two answers', async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const recipient = await recipientOf(harness);
			const words = ['accept', 'ACCEPTED', 'pending', 'revoked', 'expired', ''];

			const refused = await inTurn(words, async (word) => ({
				answer: await answerGrant(recipient, pendingId(harness), ACCEPTING, {
					extraMembers: { decision: word },
				}),
				name: `the answer ${JSON.stringify(word)}`,
			}));
			const absent = await answerGrant(recipient, pendingId(harness), ACCEPTING, {
				body: JSON.stringify({ capabilities: SHOWN.viewer }),
			});
			const notText = await answerGrant(recipient, pendingId(harness), ACCEPTING, {
				extraMembers: { decision: true },
			});
			const afterRefusals = await storedDecisions(harness, pendingId(harness));
			const accepted = await answerGrant(recipient, pendingId(harness), ACCEPTING);

			refused.forEach(({ answer, name }) => {
				assertRuleBroken(answer, name);
			});
			assertUnreadable(absent, 'no answer');
			assertUnreadable(notText, 'an answer that is no string');
			assert.deepEqual(afterRefusals, []);
			assertSucceeded(accepted, 'the answer accepted');
		});
	});

	test('takes an answer only to a live grant', async () => {
		const now = Date.now();
		await withHarness(
			{
				fixture: grantsFixture({
					grants: {
						expired: fixtureGrant('recipient', 'viewer', {
							category: 'unmarked',
							expiresAt: new Date(now - HOUR_MS),
							grantedAt: new Date(now - 3 * HOUR_MS),
						}),
						pending: fixtureGrant('recipient', 'curator'),
						revoked: fixtureGrant('recipient', 'viewer', {
							grantedAt: new Date(now - 3 * HOUR_MS),
							revoked: { at: new Date(now - HOUR_MS), by: 'ownerOfA1' },
						}),
					},
				}),
			},
			async (harness) => {
				const recipient = await recipientOf(harness);
				const ended = ['expired', 'revoked'];

				const refused = await inTurn(ended, async (state) => ({
					answer: await answerGrant(recipient, seededId(harness.seeded.grants, state), ACCEPTING),
					state,
				}));
				const decisions = await inTurn(ended, (state) =>
					storedDecisions(harness, seededId(harness.seeded.grants, state)),
				);
				const live = await answerGrant(recipient, pendingId(harness), {
					capabilities: SHOWN.curator,
					decision: 'accepted',
				});

				refused.forEach(({ answer, state }) => {
					assertRefused(answer, PROBLEMS.doesNotHold, `a grant ${state}`);
				});
				assert.deepEqual(decisions, [[], []]);
				assertSucceeded(live, 'a live grant');
			},
		);
	});

	test("records shown capabilities only as the grant's role confers them now", async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const recipient = await recipientOf(harness);
			const mismatches = {
				'a capability the role does not carry': [...SHOWN.viewer, 'record.delete'],
				'part of what the role carries': ['record.view'],
			};

			const refused = await inTurn(Object.entries(mismatches), async ([name, capabilities]) => ({
				answer: await answerGrant(recipient, pendingId(harness), {
					capabilities,
					decision: 'accepted',
				}),
				name,
			}));
			await withdrawCapabilityInStore(harness, 'viewer', 'record.export');
			const asGranted = await answerGrant(recipient, pendingId(harness), {
				capabilities: SHOWN.viewer,
				decision: 'accepted',
			});
			const afterRefusals = await storedDecisions(harness, pendingId(harness));
			const asNow = await answerGrant(recipient, pendingId(harness), {
				capabilities: ['record.view', 'record.count'],
				decision: 'accepted',
			});

			refused.forEach(({ answer, name }) => {
				assertRuleBroken(answer, name);
			});
			assertRuleBroken(asGranted, 'what the role carried when the grant was made');
			assert.deepEqual(afterRefusals, []);
			assertSucceeded(asNow, 'what the role carries now, in another order');
			assert.deepEqual(
				(await storedDecisions(harness, pendingId(harness))).map(({ capabilities }) => capabilities),
				[['record.count', 'record.view']],
			);
		});
	});

	test('keeps at least one owner when an owner declines their owner grant', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					grants: {
						pendingOwner: fixtureGrant('recipient', 'owner', {
							category: null,
						}),
					},
				}),
			},
			async (harness) => {
				const ownership = seededId(harness.seeded.grants, 'ownsA1');
				const owner = await personCaller(harness, CAST.ownerOfA1);
				const declining: GrantDecision = {
					capabilities: SHOWN.owner,
					decision: 'rejected',
				};

				const whileAlone = await answerGrant(owner, ownership, declining);
				const afterRefusal = await storedDecisions(harness, ownership);
				assertSucceeded(
					await answerGrant(await recipientOf(harness), seededId(harness.seeded.grants, 'pendingOwner'), {
						capabilities: SHOWN.owner,
						decision: 'accepted',
					}),
					'a second owner accepting',
				);
				const withSecondOwner = await answerGrant(owner, ownership, declining);
				const afterDecline = await storedDecisions(harness, ownership);

				assertRefused(whileAlone, PROBLEMS.resourceNeedsAnOwner, 'the only accepted owner declining');
				const { detail = '', title = '' } = whileAlone.problem ?? {};
				assert.match(`${title} ${detail}`, /owner/iu);
				assert.match(`${title} ${detail}`, /add/iu);
				assert.deepEqual(
					afterRefusal.map(({ decision }) => decision),
					['accepted'],
				);
				assertSucceeded(withSecondOwner, 'declining beside a second owner');
				assert.equal(afterDecline.at(-1)?.decision, 'rejected');
			},
		);
	});

	test('changes nothing on the grant itself', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					grants: {
						pending: fixtureGrant('recipient', 'viewer', {
							expiresAt: new Date(Math.floor((Date.now() + 48 * HOUR_MS) / 1000) * 1000),
							grantedBy: 'ownerOfA1',
						}),
					},
				}),
			},
			async (harness) => {
				const before = await storedGrant(harness, pendingId(harness));

				const answers = await answersInTurn(await recipientOf(harness), pendingId(harness), [
					ACCEPTING,
					REJECTING,
				]);

				answers.forEach((answer, index) => {
					assertSucceeded(answer, `answer ${index}`);
				});
				assert.deepEqual(await storedGrant(harness, pendingId(harness)), before);
				assert.notEqual(before.expiresAt, null);
			},
		);
	});

	test('answers an unknown or malformed grant id with the not-found answer', async () => {
		await withHarness({ fixture: pendingForRecipient }, async (harness) => {
			const recipient = await recipientOf(harness);

			const unknown = await answerGrant(recipient, randomUUID(), ACCEPTING);
			const malformed = await answerGrant(recipient, 'not-a-uuid', ACCEPTING);
			const own = await answerGrant(recipient, pendingId(harness), ACCEPTING);

			assertRefused(unknown, PROBLEMS.grantNotFound, 'an unknown id');
			assertRefused(malformed, PROBLEMS.grantNotFound, 'a malformed id');
			assert.deepEqual(comparableRefusal(malformed), comparableRefusal(unknown));
			assertSucceeded(own, "the holder's own grant");
		});
	});
});
