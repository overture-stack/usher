import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	type AdminResponse,
	assertRefused,
	assertRuleBroken,
	assertUnreadable,
	comparableRefusal,
	createSelfGrant,
	decideGrantRequest,
	personCaller,
	PROBLEMS,
	type SelfGrantCreation,
} from '../../../testing/harness/admin.js';
import type { Person } from '../../../testing/harness/exchange.js';
import {
	answeredInFixture,
	answerNames,
	CAST,
	CONTROLLED,
	createdId,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	instantFromNow,
	MINUTE_MS,
	OPEN_STUDY,
	grantRequestedBy,
	requestNotificationsOf,
	rowCounts,
	selfGrantUntil,
	SHOWN,
	storedDecisions,
	storedGrant,
	storedGrantRequest,
	STUDY_A1,
	STUDY_B2,
	UNKNOWN_STUDY,
	UNMARKED,
} from '../../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../../testing/harness/harness.js';
import { GRANT_REQUEST_NOTIFICATION, inTurn } from '../../../testing/harness/policy.js';

const twoHoursAhead = (): string => instantFromNow(2 * HOUR_MS);

const withoutExpiry: Omit<SelfGrantCreation, 'expiresAt'> = {
	category: CONTROLLED,
	resource: STUDY_A1,
	role: 'viewer',
};

const assertSelfGrantOf = async (harness: Harness, answer: AdminResponse, person: Person): Promise<void> => {
	const stored = await storedGrant(harness, createdId(answer, 'the self-grant'));
	assert.equal(stored.holderSubject, person.subject);
	assert.equal(stored.granterSubject, person.subject);
};

// The id of the grant an owner of STUDY-A1 writes by approving a self-grant request.
const approvedByOwner = async (harness: Harness, request: AdminResponse): Promise<string> =>
	createdId(
		await decideGrantRequest(
			await personCaller(harness, CAST.ownerOfA1),
			createdId(request, 'the self-grant request'),
			'grant',
		),
		'the approved self-grant',
	);

const selfGrantsBy = (
	caller: AdminCaller,
	attempts: Readonly<Record<string, SelfGrantCreation>>,
): Promise<readonly { answer: AdminResponse; name: string }[]> =>
	inTurn(Object.entries(attempts), async ([name, creation]) => ({
		answer: await createSelfGrant(caller, creation),
		name,
	}));

suite('creating a self-grant', () => {
	test('creates a self-grant for the caller with its expiry once an owner approves its request', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const expiresAt = twoHoursAhead();

			const created = await createSelfGrant(await administratorCaller(harness), selfGrantUntil(expiresAt));
			const grantId = await approvedByOwner(harness, created);

			const stored = await storedGrant(harness, grantId);
			assert.equal(created.status, 202);
			assert.equal(await grantRequestedBy(harness, grantId), CAST.administrator.subject);
			assert.deepEqual(
				{
					category: stored.category,
					expiresAt: stored.expiresAt?.getTime(),
					granter: stored.granterSubject,
					holder: stored.holderSubject,
					resource: stored.resource,
					role: stored.role,
				},
				{
					category: CONTROLLED,
					expiresAt: Date.parse(expiresAt),
					granter: CAST.ownerOfA1.subject,
					holder: CAST.administrator.subject,
					resource: STUDY_A1,
					role: 'viewer',
				},
			);
			assert.ok(answerNames(created, CAST.administrator.subject), 'the answer names its requester');
		});
	});

	test('requires an expiry on every self-grant', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const absent = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()), {
				body: JSON.stringify(withoutExpiry),
			});
			const nullExpiry = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()), {
				extraMembers: { expiresAt: null },
			});
			const after = await rowCounts(harness);
			const withExpiry = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()));

			assertUnreadable(absent, 'no expiry');
			assertUnreadable(nullExpiry, 'a null expiry');
			assert.deepEqual(after, before);
			createdId(withExpiry, 'a self-grant with its expiry');
		});
	});

	test("holds a self-grant's expiry within the instance's maximum", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const longest = harness.configuration.selfGrantMaximumLifetimeSeconds * 1000;
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const pastLongest = await createSelfGrant(
				administrator,
				selfGrantUntil(instantFromNow(longest + MINUTE_MS)),
			);
			const afterRefusal = await rowCounts(harness);
			const atLongest = await createSelfGrant(administrator, selfGrantUntil(instantFromNow(longest)));
			await harness.restart({ selfGrantMaximumLifetimeSeconds: 4 * 3600 });
			const underFourHours = await administratorCaller(harness);
			const fiveHours = await createSelfGrant(
				underFourHours,
				selfGrantUntil(instantFromNow(5 * HOUR_MS), { category: UNMARKED }),
			);
			const fourHours = await createSelfGrant(
				underFourHours,
				selfGrantUntil(instantFromNow(4 * HOUR_MS), { category: UNMARKED }),
			);

			assertRuleBroken(pastLongest, 'a minute past 24 hours');
			assert.deepEqual(afterRefusal, before);
			createdId(atLongest, '24 hours ahead');
			assertRuleBroken(fiveHours, 'five hours under four');
			createdId(fourHours, 'four hours under four');
		});
	});

	test("takes a self-grant's expiry in the future", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const refused = await selfGrantsBy(administrator, {
				'an expiry an hour past': selfGrantUntil(instantFromNow(-HOUR_MS)),
				'an expiry now': selfGrantUntil(instantFromNow(0)),
			});
			const after = await rowCounts(harness);
			const ahead = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()));

			refused.forEach(({ answer, name }) => {
				assertRuleBroken(answer, name);
			});
			assert.deepEqual(after, before);
			createdId(ahead, 'an expiry ahead');
		});
	});

	test('lets an owner self-grant on their own resource under the same rules', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const before = await rowCounts(harness);

			const noExpiry = await createSelfGrant(owner, selfGrantUntil(twoHoursAhead()), {
				body: JSON.stringify(withoutExpiry),
			});
			const onOther = await createSelfGrant(owner, selfGrantUntil(twoHoursAhead(), { resource: STUDY_B2 }));
			const onUnknown = await createSelfGrant(
				owner,
				selfGrantUntil(twoHoursAhead(), { resource: UNKNOWN_STUDY }),
			);
			const after = await rowCounts(harness);
			const onOwn = await createSelfGrant(owner, selfGrantUntil(twoHoursAhead()));

			assertUnreadable(noExpiry, 'no expiry');
			assertRefused(onUnknown, PROBLEMS.resourceNotFound, 'an unknown resource');
			assertRefused(onOther, PROBLEMS.resourceNotFound, 'another resource');
			assert.deepEqual(comparableRefusal(onOther), comparableRefusal(onUnknown));
			assert.deepEqual(after, before);
			await assertSelfGrantOf(harness, onOwn, CAST.ownerOfA1);
		});
	});

	test('makes a self-grant only for the caller', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const forAnother = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()), {
				extraMembers: { holder: { subject: CAST.recipient.subject } },
			});
			const after = await rowCounts(harness);
			const forThemselves = await createSelfGrant(administrator, selfGrantUntil(twoHoursAhead()));

			assertRuleBroken(forAnother, 'a self-grant naming a holder');
			assert.deepEqual(after, before);
			const asked = await storedGrantRequest(harness, createdId(forThemselves, 'the self-grant request'));
			assert.deepEqual(
				{ holder: asked.holderSubject, requester: asked.requestedBySubject },
				{
					holder: CAST.administrator.subject,
					requester: CAST.administrator.subject,
				},
			);
		});
	});

	test('self-grants only a data-plane role', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const expiresAt = twoHoursAhead();
			const before = await rowCounts(harness);

			const administratorRole = await createSelfGrant(administrator, {
				expiresAt,
				resource: STUDY_A1,
				role: 'admin',
			});
			const ownerRole = await createSelfGrant(administrator, {
				expiresAt,
				resource: STUDY_A1,
				role: 'owner',
			});
			const after = await rowCounts(harness);
			const viewer = await createSelfGrant(administrator, selfGrantUntil(expiresAt));

			assertRuleBroken(administratorRole, 'the admin role');
			assertRefused(ownerRole, PROBLEMS.administratorSelfOwnership, 'an administrator making themself owner');
			assert.deepEqual(after, before);
			createdId(viewer, 'the viewer role');
		});
	});

	test('answers a self-grant by a principal without grant authority exactly as for an unknown resource', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const callers = await inTurn(
				[
					{ name: 'the owner of another resource', person: CAST.ownerOfB2 },
					{ name: 'an outsider', person: CAST.outsider },
				],
				async ({ name, person }) => ({
					caller: await personCaller(harness, person),
					name,
				}),
			);
			const before = await rowCounts(harness);

			const attempts = await inTurn(callers, async ({ caller, name }) => ({
				known: await createSelfGrant(caller, selfGrantUntil(twoHoursAhead())),
				name,
				unknown: await createSelfGrant(caller, selfGrantUntil(twoHoursAhead(), { resource: UNKNOWN_STUDY })),
			}));
			const after = await rowCounts(harness);
			const byOwner = await createSelfGrant(
				await personCaller(harness, CAST.ownerOfA1),
				selfGrantUntil(twoHoursAhead()),
			);

			attempts.forEach(({ known, name, unknown }) => {
				assertRefused(unknown, PROBLEMS.resourceNotFound, `${name}, unknown`);
				assertRefused(known, PROBLEMS.resourceNotFound, name);
				assert.deepEqual(comparableRefusal(known), comparableRefusal(unknown), name);
			});
			assert.deepEqual(after, before);
			createdId(byOwner, "the resource's owner");
		});
	});

	test('refuses a self-grant by a principal who may see the resource but holds no authority on it', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const curator = await personCaller(harness, CAST.curator);
			const outsider = await personCaller(harness, CAST.outsider);
			const before = await rowCounts(harness);

			const onHeld = await createSelfGrant(curator, selfGrantUntil(twoHoursAhead()));
			const onOpen = await createSelfGrant(outsider, selfGrantUntil(twoHoursAhead(), { resource: OPEN_STUDY }));
			const after = await rowCounts(harness);
			const byOwner = await createSelfGrant(
				await personCaller(harness, CAST.ownerOfA1),
				selfGrantUntil(twoHoursAhead()),
			);

			assertRefused(
				onHeld,
				PROBLEMS.noAuthorityOnResource,
				'a curator, on the controlled resource they hold a grant on',
			);
			assertRefused(onOpen, PROBLEMS.noAuthorityOnResource, 'an outsider, on an open resource');
			assert.deepEqual(after, before);
			createdId(byOwner, "the resource's owner");
		});
	});

	test("records a self-grant's request as its acceptance", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const grantId = await approvedByOwner(
				harness,
				await createSelfGrant(await administratorCaller(harness), selfGrantUntil(twoHoursAhead())),
			);

			const decisions = await storedDecisions(harness, grantId);
			const { grantedAt } = await storedGrant(harness, grantId);

			assert.deepEqual(
				decisions.map(({ capabilities, decision, deciderSubject }) => ({
					capabilities,
					decider: deciderSubject,
					decision,
				})),
				[
					{
						capabilities: SHOWN.viewer,
						decider: CAST.administrator.subject,
						decision: 'accepted',
					},
				],
			);
			const [acceptance] = decisions;
			assert.ok(
				acceptance !== undefined && Math.abs(acceptance.decidedAt.getTime() - grantedAt.getTime()) < 1000,
				'the acceptance is written with the grant',
			);
		});
	});

	test('tells each owner of the resource of a self-grant request on it', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('spareOwnsA1')],
					grants: {
						pendingOwner: fixtureGrant('recipient', 'owner', {
							category: null,
						}),
						spareOwnsA1: fixtureGrant('spare', 'owner', { category: null }),
					},
				}),
			},
			async (harness) => {
				const requestId = createdId(
					await createSelfGrant(await administratorCaller(harness), selfGrantUntil(twoHoursAhead())),
					'the self-grant request',
				);

				const notifications = await requestNotificationsOf(harness, requestId);

				assert.deepEqual(
					notifications
						.map(({ deliveredAt, kind, recipientSubject }) => ({
							deliveredAt,
							kind,
							recipient: recipientSubject,
						}))
						.toSorted((first, second) => first.recipient.localeCompare(second.recipient)),
					[CAST.ownerOfA1.subject, CAST.spare.subject]
						.toSorted((first, second) => first.localeCompare(second))
						.map((recipient) => ({
							deliveredAt: null,
							kind: GRANT_REQUEST_NOTIFICATION,
							recipient,
						})),
				);
			},
		);
	});
});
