import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	answerGrant,
	assertForbidden,
	assertNotFound,
	assertSucceeded,
	changeGrantExpiry,
	comparableRefusal,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	deniedEventReason,
	type GrantCreated,
	GRANT_REVOCATION_REASONS,
	personCaller,
	PROBLEMS,
	revokeGrant,
	SYSTEM_ASSIGNED_REASONS,
} from '../../testing/harness/admin.js';
import { emittedType, SEVERITY_ATTRIBUTE } from '../../testing/harness/auditEvents.js';
import { PEOPLE, type Person } from '../../testing/harness/exchange.js';
import {
	awaitEventsOfType,
	awaitEventWhere,
	awaitOneEvent,
	CONTROLLED,
	dataOf,
	eventsIn,
	exchangeBy,
	instantIn,
	liveGrantCount,
	markOf,
	namingGrant,
	ofType,
	RESOURCES,
	sharedAuditHarness,
	storedGrant,
	VIEWER_CAPABILITIES,
	withAuditHarness,
} from '../../testing/fixtures/audit.js';
import { inTurn } from '../../testing/harness/policy.js';
import { eventually } from '../../testing/harness/waiting.js';

const HOUR_MS = 3_600_000;

const UNREGISTERED = 'STUDY-Z9';

const DAY_MS = 86_400_000;

const viewerGrant = async (
	caller: AdminCaller,
	person: Person,
	resource: string,
	expiresAt?: string,
): Promise<GrantCreated> =>
	createGrant(caller, {
		category: CONTROLLED,
		holder: { subject: person.subject },
		resource,
		role: 'viewer',
		...(expiresAt === undefined ? {} : { expiresAt }),
	});

const createdId = (created: GrantCreated, operation: string): string => {
	assertSucceeded(created, operation);
	return created.grantId ?? assert.fail(`${operation} answered no grant id`);
};

suite('grant events', () => {
	const shared = sharedAuditHarness();

	test('records grant.creation naming the actor, the grantee by subject, the resource, the category as the payload names it, the role and the new grant', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const grantId = createdId(
			await viewerGrant(await personCaller(harness, PEOPLE.owner), PEOPLE.ana, RESOURCES.a1),
			'the creation',
		);
		const event = await awaitEventWhere(log, 'grant.creation', namingGrant(grantId), { since });
		const data = dataOf(event);

		assert.equal(data['actorId'], PEOPLE.owner.subject);
		assert.equal(data['granteeSubject'], PEOPLE.ana.subject);
		assert.equal(data['resourceId'], RESOURCES.a1);
		assert.equal(data['category'], CONTROLLED);
		assert.equal(data['role'], 'viewer');
		assert.equal(data['grantId'], grantId);
		assert.equal(data['result'], 'succeeded');
		assert.equal(event[SEVERITY_ATTRIBUTE], 'info');
	});

	test('records the role each grant names, an owner grant naming the wildcard category as null', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const ownerGrantId = createdId(
			await createGrant(await administratorCaller(harness), {
				holder: { subject: PEOPLE.dana.subject },
				resource: RESOURCES.a1,
				role: 'owner',
			}),
			'the owner grant',
		);
		const viewerGrantId = createdId(
			await viewerGrant(await personCaller(harness, PEOPLE.owner), PEOPLE.cy, RESOURCES.a1),
			'the viewer grant',
		);
		const ownerData = dataOf(
			await awaitEventWhere(log, 'grant.creation', namingGrant(ownerGrantId), {
				since,
			}),
		);
		const viewerData = dataOf(
			await awaitEventWhere(log, 'grant.creation', namingGrant(viewerGrantId), {
				since,
			}),
		);

		assert.equal(ownerData['role'], 'owner');
		assert.equal(Object.hasOwn(ownerData, 'category'), true);
		assert.equal(ownerData['category'], null);
		assert.equal(viewerData['role'], 'viewer');
		assert.equal(viewerData['category'], CONTROLLED);
	});

	test('records a grant creation by a principal lacking the authority as denied for that lack, naming no grant, whether or not the principal may see the resource', async () => {
		const { harness, log } = await shared();
		const bo = await personCaller(harness, PEOPLE.bo);
		const countsOf = (): Promise<readonly number[]> =>
			inTurn([RESOURCES.a1, RESOURCES.c3], (resource) =>
				liveGrantCount(harness.clients.migration, PEOPLE.eli.subject, resource),
			);
		const before = await countsOf();
		const since = markOf(log);

		const onVisible = await viewerGrant(bo, PEOPLE.eli, RESOURCES.a1);
		const onHidden = await viewerGrant(bo, PEOPLE.eli, RESOURCES.c3);
		const onAbsent = await viewerGrant(bo, PEOPLE.eli, UNREGISTERED);
		const events = await awaitEventsOfType(log, 'grant.creation', {
			count: 3,
			since,
		});
		const afterRefusals = await countsOf();
		const control = await viewerGrant(await personCaller(harness, PEOPLE.owner), PEOPLE.eli, RESOURCES.a1);

		assertForbidden(onVisible, 'a grant on a resource Bo may see', PROBLEMS.noAuthorityOnResource.code);
		assertNotFound(onHidden, 'a grant on a resource Bo may not see', PROBLEMS.resourceNotFound.code);
		assert.deepEqual(comparableRefusal(onHidden), comparableRefusal(onAbsent));
		assert.deepEqual(afterRefusals, before);
		assertSucceeded(control, "the owner's creation");
		assert.equal(events.length, 3);
		assert.deepEqual(
			events.map((event) => [dataOf(event)['resourceId'], dataOf(event)['reason']]),
			[
				[RESOURCES.a1, deniedEventReason(PROBLEMS.noAuthorityOnResource.code, false)],
				[RESOURCES.c3, deniedEventReason(PROBLEMS.resourceNotFound.code, true)],
				[undefined, deniedEventReason(PROBLEMS.resourceNotFound.code, false)],
			],
		);
		events.forEach((event) => {
			const data = dataOf(event);
			assert.equal(data['actorId'], PEOPLE.bo.subject);
			assert.equal(data['result'], 'denied');
			assert.equal(Object.hasOwn(data, 'grantId'), false);
		});
	});

	test("records an administrator's grant of consumer access as denied, naming the rule it broke", async () => {
		const { harness, log } = await shared();
		const administrator = await administratorCaller(harness);
		const countOf = (): Promise<number> =>
			liveGrantCount(harness.clients.migration, PEOPLE.bo.subject, RESOURCES.a1);
		const before = await countOf();
		const since = markOf(log);

		const refused = await viewerGrant(administrator, PEOPLE.bo, RESOURCES.a1);
		const event = await awaitOneEvent(log, 'grant.creation', { since });
		const afterRefusal = await countOf();
		const control = await createGrant(administrator, {
			holder: { subject: PEOPLE.bo.subject },
			resource: RESOURCES.d4,
			role: 'owner',
		});
		const data = dataOf(event);

		assertForbidden(
			refused,
			"the administrator's consumer grant",
			PROBLEMS.administratorGrantsNoConsumerAccess.code,
		);
		assert.equal(afterRefusal, before);
		assertSucceeded(control, "the administrator's owner grant");
		assert.equal(data['actorId'], PEOPLE.administrator.subject);
		assert.equal(data['result'], 'denied');
		assert.equal(data['reason'], deniedEventReason(PROBLEMS.administratorGrantsNoConsumerAccess.code, false));
		assert.equal(Object.hasOwn(data, 'grantId'), false);
	});

	test('records an administrator naming themself owner as denied, naming the rule it broke, through either grant operation', async () => {
		const { harness, log } = await shared();
		const administrator = await administratorCaller(harness);
		const selfMark = markOf(log);

		const throughSelfGrant = await createSelfGrant(administrator, {
			expiresAt: instantIn(2 * HOUR_MS),
			resource: RESOURCES.c3,
			role: 'owner',
		});
		const selfEvent = await awaitOneEvent(log, 'grant.selfCreation', {
			since: selfMark,
		});
		const creationMark = markOf(log);
		const throughCreation = await createGrant(administrator, {
			holder: { subject: PEOPLE.administrator.subject },
			resource: RESOURCES.c3,
			role: 'owner',
		});
		const creationEvent = await awaitOneEvent(log, 'grant.creation', {
			since: creationMark,
		});
		const afterRefusals = await liveGrantCount(
			harness.clients.migration,
			PEOPLE.administrator.subject,
			RESOURCES.c3,
		);
		const byPeer = await createGrant(await administratorCaller(harness, { person: PEOPLE.eli }), {
			holder: { subject: PEOPLE.administrator.subject },
			resource: RESOURCES.c3,
			role: 'owner',
		});

		[throughSelfGrant, throughCreation].forEach((refused) => {
			assertForbidden(
				refused,
				'the administrator naming themself owner',
				PROBLEMS.administratorSelfOwnership.code,
			);
		});
		assert.equal(afterRefusals, 0);
		assertSucceeded(byPeer, "another administrator's owner grant");
		[selfEvent, creationEvent].forEach((event) => {
			const data = dataOf(event);
			assert.equal(data['actorId'], PEOPLE.administrator.subject);
			assert.equal(data['result'], 'denied');
			assert.equal(data['reason'], deniedEventReason(PROBLEMS.administratorSelfOwnership.code, false));
			assert.equal(Object.hasOwn(data, 'grantId'), false);
		});
	});

	test("records an administrator's self-grant request as grant.request, and its decision as grant.requestDecision, each at warning and carrying its expiry", async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const requestId = createdId(
			await createSelfGrant(await administratorCaller(harness), {
				category: CONTROLLED,
				expiresAt: instantIn(2 * HOUR_MS),
				resource: RESOURCES.a1,
				role: 'viewer',
			}),
			'the self-grant request',
		);
		const requested = await awaitEventWhere(log, 'grant.request', (data) => data['requestId'] === requestId, {
			since,
		});
		const grantId = createdId(
			await decideGrantRequest(await personCaller(harness, PEOPLE.owner), requestId, 'grant'),
			'the approved self-grant',
		);
		const approved = await awaitEventWhere(log, 'grant.requestDecision', namingGrant(grantId), { since });
		const stored = await storedGrant(harness.clients.migration, grantId);
		const creations = ofType(eventsIn(log, since), 'grant.creation').filter((other) =>
			namingGrant(grantId)(dataOf(other)),
		);
		const asked = dataOf(requested);
		const decided = dataOf(approved);

		assert.equal(asked['actorId'], PEOPLE.administrator.subject);
		assert.equal(asked['resourceId'], RESOURCES.a1);
		assert.equal(asked['category'], CONTROLLED);
		assert.equal(asked['role'], 'viewer');
		assert.equal(decided['actorId'], PEOPLE.owner.subject);
		assert.equal(decided['requestId'], requestId);
		assert.equal(decided['requestedBySubject'], PEOPLE.administrator.subject);
		assert.ok(stored.expiresAt);
		[asked, decided].forEach((data) => {
			assert.equal(Date.parse(String(data['expiresAt'])), stored.expiresAt?.getTime());
		});
		assert.equal(requested[SEVERITY_ATTRIBUTE], 'warning');
		assert.equal(approved[SEVERITY_ATTRIBUTE], 'warning');
		assert.deepEqual(creations, []);
	});

	test("records an owner's grant to themselves on their own resource as grant.selfCreation", async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const grantId = createdId(
			await createSelfGrant(await personCaller(harness, PEOPLE.owner), {
				category: CONTROLLED,
				expiresAt: instantIn(2 * HOUR_MS),
				resource: RESOURCES.b2,
				role: 'viewer',
			}),
			'the self-grant',
		);
		const data = dataOf(
			await awaitEventWhere(log, 'grant.selfCreation', namingGrant(grantId), {
				since,
			}),
		);

		assert.equal(data['actorId'], PEOPLE.owner.subject);
		assert.equal(data['resourceId'], RESOURCES.b2);
	});

	test('records grant.revocation naming the actor, the grantee, the resource, the category, the role, the grant and the reason', async () => {
		const { harness, log } = await shared();
		const owner = await personCaller(harness, PEOPLE.owner);
		const withReason = createdId(await viewerGrant(owner, PEOPLE.ana, RESOURCES.b2), "Ana's grant");
		const withoutReason = createdId(await viewerGrant(owner, PEOPLE.bo, RESOURCES.b2), "Bo's grant");
		const since = markOf(log);

		assertSucceeded(
			await revokeGrant(await administratorCaller(harness), withReason, {
				reason: GRANT_REVOCATION_REASONS.accessReview,
			}),
			'the revocation with a reason',
		);
		assertSucceeded(await revokeGrant(owner, withoutReason), 'the revocation without one');
		const event = await awaitEventWhere(log, 'grant.revocation', namingGrant(withReason), { since });
		const unreasoned = dataOf(
			await awaitEventWhere(log, 'grant.revocation', namingGrant(withoutReason), { since }),
		);
		const data = dataOf(event);

		assert.equal(data['actorId'], PEOPLE.administrator.subject);
		assert.equal(data['granteeSubject'], PEOPLE.ana.subject);
		assert.equal(data['resourceId'], RESOURCES.b2);
		assert.equal(data['category'], CONTROLLED);
		assert.equal(data['role'], 'viewer');
		assert.equal(data['grantId'], withReason);
		assert.equal(data['reason'], GRANT_REVOCATION_REASONS.accessReview);
		assert.equal(data['result'], 'succeeded');
		assert.equal(event[SEVERITY_ATTRIBUTE], 'info');
		assert.equal(unreasoned['actorId'], PEOPLE.owner.subject);
		assert.equal(unreasoned['reason'], SYSTEM_ASSIGNED_REASONS.unspecified);
	});

	test('records a revocation by a principal lacking the authority as denied for that lack, leaving the grant in force', async () => {
		const { harness, log } = await shared();
		const owner = await personCaller(harness, PEOPLE.owner);
		const grantId = createdId(await viewerGrant(owner, PEOPLE.cy, RESOURCES.c3), "Cy's grant");
		const since = markOf(log);

		const bo = await personCaller(harness, PEOPLE.bo);

		const refused = await revokeGrant(bo, grantId);
		const event = await awaitOneEvent(log, 'grant.revocation', { since });
		const absentMark = markOf(log);
		const onAbsent = await revokeGrant(bo, randomUUID());
		const absentEvent = await awaitOneEvent(log, 'grant.revocation', {
			since: absentMark,
		});
		const afterRefusal = await storedGrant(harness.clients.migration, grantId);
		const control = await revokeGrant(owner, grantId);
		const data = dataOf(event);

		assertNotFound(refused, "Bo's revocation of Cy's grant", PROBLEMS.grantNotFound.code);
		assert.deepEqual(comparableRefusal(refused), comparableRefusal(onAbsent));
		assert.equal(afterRefusal.revokedAt, null);
		assertSucceeded(control, "the owner's revocation");
		assert.equal(data['actorId'], PEOPLE.bo.subject);
		assert.equal(data['result'], 'denied');
		assert.equal(data['reason'], deniedEventReason(PROBLEMS.grantNotFound.code, true));
		assert.equal(dataOf(absentEvent)['actorId'], PEOPLE.bo.subject);
		assert.equal(dataOf(absentEvent)['result'], 'denied');
		assert.equal(dataOf(absentEvent)['reason'], deniedEventReason(PROBLEMS.grantNotFound.code, false));
	});

	test("records grant.extension at info when a grant's end moves later, carrying both ends", async () => {
		const { harness, log } = await shared();
		const owner = await personCaller(harness, PEOPLE.owner);
		const before = instantIn(DAY_MS);
		const after = instantIn(2 * DAY_MS);
		const grantId = createdId(await viewerGrant(owner, PEOPLE.dana, RESOURCES.c3, before), "Dana's grant");
		const since = markOf(log);

		assertSucceeded(await changeGrantExpiry(owner, grantId, after), 'the extension');
		const [event] = await awaitEventsOfType(log, 'grant.extension', { since });
		assert.ok(event);
		const data = dataOf(event);

		assert.equal(data['actorId'], PEOPLE.owner.subject);
		assert.equal(data['resourceId'], RESOURCES.c3);
		assert.equal(data['category'], CONTROLLED);
		assert.equal(Date.parse(String(data['endBefore'])), Date.parse(before));
		assert.equal(Date.parse(String(data['endAfter'])), Date.parse(after));
		assert.equal(event[SEVERITY_ATTRIBUTE], 'info');
	});

	test("records grant.reduction at warning when a grant's end moves earlier and stays in the future", async () => {
		const { harness, log } = await shared();
		const owner = await personCaller(harness, PEOPLE.owner);
		const before = instantIn(2 * DAY_MS);
		const after = instantIn(DAY_MS);
		const grantId = createdId(await viewerGrant(owner, PEOPLE.eli, RESOURCES.c3, before), "Eli's grant");
		const since = markOf(log);

		assertSucceeded(await changeGrantExpiry(owner, grantId, after), 'the reduction');
		const [event] = await awaitEventsOfType(log, 'grant.reduction', { since });
		assert.ok(event);
		const data = dataOf(event);

		assert.equal(data['actorId'], PEOPLE.owner.subject);
		assert.equal(Date.parse(String(data['endBefore'])), Date.parse(before));
		assert.equal(Date.parse(String(data['endAfter'])), Date.parse(after));
		assert.equal(event[SEVERITY_ATTRIBUTE], 'warning');
		assert.deepEqual(ofType(eventsIn(log, since), 'grant.extension'), []);
	});

	test('records nothing when a grant expires', async () => {
		await withAuditHarness({}, async ({ harness, log }) => {
			const expiresAt = Date.now() + 6_000;
			const grantId = createdId(
				await viewerGrant(
					await personCaller(harness, PEOPLE.owner),
					PEOPLE.bo,
					RESOURCES.a1,
					new Date(expiresAt).toISOString(),
				),
				"Bo's grant",
			);
			assertSucceeded(
				await answerGrant(await personCaller(harness, PEOPLE.bo), grantId, {
					capabilities: VIEWER_CAPABILITIES,
					decision: 'accept',
				}),
				'the acceptance',
			);
			const beforeMark = markOf(log);
			await exchangeBy(harness, PEOPLE.bo);
			const [held] = await awaitEventsOfType(log, 'token.exchange', {
				since: beforeMark,
			});
			const expiredMark = markOf(log);

			const passed = await eventually(async () => Date.now() > expiresAt + 1000, 15_000);
			await exchangeBy(harness, PEOPLE.bo);
			const [lapsed] = await awaitEventsOfType(log, 'token.exchange', {
				since: expiredMark,
			});
			const naming = eventsIn(log).filter((event) => namingGrant(grantId)(dataOf(event)));

			assert.ok(passed);
			assert.ok(held);
			assert.ok(lapsed);
			assert.equal(dataOf(held)['grantCount'], 1);
			assert.equal(dataOf(lapsed)['grantCount'], 0);
			assert.deepEqual(naming.map(({ type }) => type).toSorted(), [
				emittedType('grant.creation'),
				emittedType('grant.decision'),
			]);
			assert.deepEqual(
				eventsIn(log, beforeMark)
					.map(({ type }) => type)
					.filter((type) => type !== emittedType('applicationKey.confirmation')),
				[emittedType('token.exchange'), emittedType('token.exchange')],
			);
		});
	});
});
