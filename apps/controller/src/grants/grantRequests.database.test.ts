import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	administratorCaller,
	assertRefused,
	assertSucceeded,
	createSelfGrant,
	decideGrantRequest,
	listGrantRequests,
	personCaller,
	PROBLEMS,
} from '../../testing/harness/admin.js';
import { auditRows, dataOf, emittedType, RULED_GRANT_EVENT_TYPES } from '../../testing/harness/auditEvents.js';
import { adjustableClock } from '../../testing/peripherals/clocks.js';
import {
	answeredInFixture,
	CAST,
	CONTROLLED,
	createdId,
	fixtureGrant,
	grantRequestedBy,
	grantsFixture,
	HOUR_MS,
	MINUTE_MS,
	notificationsOf,
	requestNotificationsOf,
	selfGrantUntil,
	SHOWN,
	storedDecisions,
	storedGrant,
	storedGrantRequest,
	storedGrants,
	STUDY_A1,
} from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import {
	GRANT_REQUEST_NOTIFICATION,
	SELF_GRANT_NOTIFICATION,
	SELF_GRANT_REQUEST,
} from '../../testing/harness/policy.js';

// STUDY-A1 owned by Ana and by the spare owner, each by an accepted owner grant.
const twoOwners = (): ReturnType<typeof grantsFixture> =>
	grantsFixture({
		decisions: [answeredInFixture('spareOwnsA1')],
		grants: {
			spareOwnsA1: fixtureGrant('spare', 'owner', { category: null }),
		},
	});

const inTwoHours = (now: number = Date.now()): string => new Date(now + 2 * HOUR_MS).toISOString();

const recipientsOf = (
	notifications: readonly { kind: string; recipientSubject: string }[],
): readonly (readonly string[])[] => notifications.map(({ kind, recipientSubject }) => [kind, recipientSubject]);

const eventsNaming = async (
	harness: Harness,
	type: string,
	member: string,
	value: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(type))
		.map(dataOf)
		.filter((data) => data[member] === value);

const requestIdOf = (answer: AdminResponse): string => {
	assert.equal(answer.status, 202, 'a request is answered 202');
	return createdId(answer, 'the request');
};

suite('grant requests through the store', () => {
	test("commits an administrator's self-grant as a request, undecided, with what they were shown, its event and an outbox row for each owner, and writes no grant", async () => {
		await withHarness({ fixture: twoOwners() }, async (harness) => {
			const asked = await createSelfGrant(await administratorCaller(harness), selfGrantUntil(inTwoHours()));
			const requestId = requestIdOf(asked);

			const stored = await storedGrantRequest(harness, requestId);

			assert.deepEqual(
				{
					capabilities: stored.capabilities,
					category: stored.category,
					decision: stored.decision,
					holder: stored.holderSubject,
					kind: stored.kind,
					requestedBy: stored.requestedBySubject,
					resource: stored.resource,
					role: stored.role,
				},
				{
					capabilities: SHOWN.viewer,
					category: CONTROLLED,
					decision: null,
					holder: CAST.administrator.subject,
					kind: SELF_GRANT_REQUEST,
					requestedBy: CAST.administrator.subject,
					resource: STUDY_A1,
					role: 'viewer',
				},
			);
			assert.deepEqual(
				recipientsOf(await requestNotificationsOf(harness, requestId)),
				[CAST.ownerOfA1.subject, CAST.spare.subject]
					.toSorted()
					.map((subject) => [GRANT_REQUEST_NOTIFICATION, subject]),
			);
			assert.deepEqual(
				await storedGrants(harness, {
					holder: CAST.administrator.subject,
					resource: STUDY_A1,
				}),
				[],
			);
			assert.equal(
				(await eventsNaming(harness, RULED_GRANT_EVENT_TYPES.grantRequest, 'requestId', requestId)).length,
				1,
			);
		});
	});

	test("grants a request in one transaction: the grant naming who asked for it beside who granted it, the holder's acceptance of what they were shown, and the decision naming the grant", async () => {
		await withHarness({ fixture: twoOwners() }, async (harness) => {
			const expiresAt = inTwoHours();
			const requestId = requestIdOf(
				await createSelfGrant(await administratorCaller(harness), selfGrantUntil(expiresAt)),
			);

			const grantId = createdId(
				await decideGrantRequest(await personCaller(harness, CAST.ownerOfA1), requestId, 'granted'),
				'the grant',
			);

			const grant = await storedGrant(harness, grantId);
			const request = await storedGrantRequest(harness, requestId);
			assert.deepEqual(
				{
					expiresAt: grant.expiresAt?.getTime(),
					granter: grant.granterSubject,
					holder: grant.holderSubject,
					requestedBy: await grantRequestedBy(harness, grantId),
				},
				{
					expiresAt: Date.parse(expiresAt),
					granter: CAST.ownerOfA1.subject,
					holder: CAST.administrator.subject,
					requestedBy: CAST.administrator.subject,
				},
			);
			assert.deepEqual(
				(await storedDecisions(harness, grantId)).map(({ capabilities, decision, deciderSubject }) => [
					decision,
					deciderSubject,
					capabilities,
				]),
				[['accepted', CAST.administrator.subject, SHOWN.viewer]],
			);
			assert.deepEqual(
				[request.decision, request.deciderSubject, request.grantId],
				['granted', CAST.ownerOfA1.subject, grantId],
			);
			assert.deepEqual(
				(await eventsNaming(harness, RULED_GRANT_EVENT_TYPES.grantRequestDecision, 'grantId', grantId)).map(
					({ decision, requestedById }) => [decision, requestedById],
				),
				[['granted', CAST.administrator.subject]],
			);
			assert.deepEqual(await eventsNaming(harness, 'grant.creation', 'grantId', grantId), []);
		});
	});

	test('keeps a decision once made, refuses one by the principal who asked, and lets a request lapse at its expiry', async () => {
		const clock = adjustableClock();
		await withHarness({ configuration: { clock: clock.clock }, fixture: twoOwners() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const refusedId = requestIdOf(await createSelfGrant(administrator, selfGrantUntil(inTwoHours())));
			const lapsingId = requestIdOf(
				await createSelfGrant(
					administrator,
					selfGrantUntil(new Date(clock.clock.now() + MINUTE_MS).toISOString(), {
						category: 'global.unmarked',
					}),
				),
			);

			const own = await decideGrantRequest(administrator, refusedId, 'granted');
			assertSucceeded(await decideGrantRequest(owner, refusedId, 'refused'), 'the refusal');
			const again = await decideGrantRequest(await personCaller(harness, CAST.spare), refusedId, 'granted');
			clock.advance(MINUTE_MS + 1000);
			const lapsed = await decideGrantRequest(await personCaller(harness, CAST.ownerOfA1), lapsingId, 'granted');

			assertRefused(own, PROBLEMS.ownRequest, 'deciding their own request');
			assertRefused(again, PROBLEMS.requestDecided, 'a second decision');
			assertRefused(lapsed, PROBLEMS.requestLapsed, 'a lapsed request');
			assert.equal((await storedGrantRequest(harness, refusedId)).decision, 'refused');
			assert.equal((await storedGrantRequest(harness, lapsingId)).decision, null);
		});
	});

	test('refuses asking again while a request on the same terms is pending, and answers anyone else deciding as for a request that does not exist', async () => {
		await withHarness({ fixture: twoOwners() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const requestId = requestIdOf(await createSelfGrant(administrator, selfGrantUntil(inTwoHours())));

			const twice = await createSelfGrant(administrator, selfGrantUntil(inTwoHours()));
			const byOutsider = await decideGrantRequest(
				await personCaller(harness, CAST.outsider),
				requestId,
				'granted',
			);
			const byOtherOwner = await decideGrantRequest(
				await personCaller(harness, CAST.ownerOfB2),
				requestId,
				'granted',
			);

			assertRefused(twice, PROBLEMS.alreadyRequested, 'asking twice');
			assertRefused(byOutsider, PROBLEMS.requestNotFound, 'an outsider');
			assertRefused(byOtherOwner, PROBLEMS.requestNotFound, 'another owner');
			assert.equal((await storedGrantRequest(harness, requestId)).decision, null);
		});
	});

	test('lists the pending requests a caller may decide, and their own in any state, to nobody else', async () => {
		await withHarness({ fixture: twoOwners() }, async (harness) => {
			const requestId = requestIdOf(
				await createSelfGrant(await administratorCaller(harness), selfGrantUntil(inTwoHours())),
			);
			const listedTo = async (caller: Parameters<typeof listGrantRequests>[0]): Promise<readonly unknown[]> => {
				const listed = await listGrantRequests(caller);
				assertSucceeded(listed, 'the listing');
				const requests: unknown =
					typeof listed.body === 'object' && listed.body !== null
						? Reflect.get(listed.body, 'requests')
						: undefined;
				return Array.isArray(requests)
					? requests.map((request: unknown) =>
							typeof request === 'object' && request !== null
								? [Reflect.get(request, 'id'), Reflect.get(request, 'state')]
								: request,
						)
					: [];
			};

			const toOwner = await listedTo(await personCaller(harness, CAST.ownerOfA1));
			const toPeer = await listedTo(
				await administratorCaller(harness, {
					person: CAST.secondAdministrator,
				}),
			);
			const toAdministrator = await listedTo(await administratorCaller(harness));
			const toOtherOwner = await listedTo(await personCaller(harness, CAST.ownerOfB2));
			const toOutsider = await listedTo(await personCaller(harness, CAST.outsider));
			assertSucceeded(
				await decideGrantRequest(await personCaller(harness, CAST.ownerOfA1), requestId, 'refused'),
				'the refusal',
			);
			const toOwnerOnceDecided = await listedTo(await personCaller(harness, CAST.ownerOfA1));
			const toAdministratorOnceDecided = await listedTo(await administratorCaller(harness));

			assert.deepEqual(
				[toOwner, toPeer, toAdministrator, toOtherOwner, toOutsider],
				[[[requestId, 'pending']], [[requestId, 'pending']], [[requestId, 'pending']], [], []],
			);
			assert.deepEqual(toOwnerOnceDecided, []);
			assert.deepEqual(toAdministratorOnceDecided, [[requestId, 'refused']]);
		});
	});

	test("issues an owner's self-grant at once with their acceptance, telling the resource's other owners alone", async () => {
		await withHarness({ fixture: twoOwners() }, async (harness) => {
			const grantId = createdId(
				await createSelfGrant(await personCaller(harness, CAST.ownerOfA1), selfGrantUntil(inTwoHours())),
				"the owner's self-grant",
			);

			const grant = await storedGrant(harness, grantId);

			assert.deepEqual(
				[grant.granterSubject, grant.holderSubject],
				[CAST.ownerOfA1.subject, CAST.ownerOfA1.subject],
			);
			assert.deepEqual(
				(await storedDecisions(harness, grantId)).map(({ decision }) => decision),
				['accepted'],
			);
			assert.deepEqual(recipientsOf(await notificationsOf(harness, grantId)), [
				[SELF_GRANT_NOTIFICATION, CAST.spare.subject],
			]);
			assert.equal(await grantRequestedBy(harness, grantId), null);
		});
	});
});
