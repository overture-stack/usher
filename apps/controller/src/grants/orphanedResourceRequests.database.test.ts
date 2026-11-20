import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	administratorCaller,
	answerGrant,
	assertRefused,
	assertSucceeded,
	createGrant,
	decideGrantRequest,
	listGrantRequests,
	personCaller,
	PROBLEMS,
} from '../../testing/harness/admin.js';
import { auditRows, dataOf, emittedType, RULED_GRANT_EVENT_TYPES } from '../../testing/harness/auditEvents.js';
import {
	CAST,
	CONTROLLED,
	createdId,
	fixtureGrant,
	grantFor,
	grantsFixture,
	HOUR_MS,
	OPEN_STUDY,
	REGISTERED_STUDY,
	grantRequestedBy,
	requestNotificationsOf,
	SHOWN,
	storedDecisions,
	storedGrant,
	storedGrantRequest,
	storedGrants,
	UNMARKED,
} from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { ORPHANED_RESOURCE_REQUEST, seededId } from '../../testing/harness/policy.js';

// STUDY-D4 named to the spare owner by an owner grant they have not answered, so it has no counted
// owner; STUDY-C3 has no owner grant at all.
const PENDING_OWNER = 'spareNamedOwnerOfD4';

const pendingOwner = (): ReturnType<typeof grantsFixture> =>
	grantsFixture({
		grants: {
			[PENDING_OWNER]: fixtureGrant('spare', 'owner', {
				category: null,
				resource: REGISTERED_STUDY,
			}),
		},
	});

const inTwoHours = (): string => new Date(Date.now() + 2 * HOUR_MS).toISOString();

// The recipient's viewer grant on a study under `controlled`, ending in two hours.
const viewerOn = (resource: string, category: string = CONTROLLED): ReturnType<typeof grantFor> =>
	grantFor(CAST.recipient, { category, expiresAt: inTwoHours(), resource });

const requestIdOf = (answer: AdminResponse): string => {
	assert.equal(answer.status, 202, 'a request is answered 202');
	return createdId(answer, 'the request');
};

const member = (answer: AdminResponse, name: string): unknown =>
	typeof answer.body === 'object' && answer.body !== null ? Reflect.get(answer.body, name) : undefined;

const eventsNaming = async (
	harness: Harness,
	type: string,
	name: string,
	value: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(type))
		.map(dataOf)
		.filter((data) => data[name] === value);

suite("an administrator's grant of access to records on an orphaned resource, as a request", () => {
	test('writes it as a request undecided, its requestedBy the administrator and its holder the person named, with its event and no outbox row or grant', async () => {
		await withHarness({ fixture: pendingOwner() }, async (harness) => {
			const administrator = await administratorCaller(harness);

			const answers = [
				await createGrant(administrator, viewerOn(REGISTERED_STUDY)),
				await createGrant(administrator, viewerOn(OPEN_STUDY)),
			];
			const requestIds = answers.map(requestIdOf);
			const stored = await Promise.all(requestIds.map((requestId) => storedGrantRequest(harness, requestId)));
			const asked = await Promise.all(
				requestIds.map((requestId) =>
					eventsNaming(harness, RULED_GRANT_EVENT_TYPES.grantRequest, 'requestId', requestId),
				),
			);

			assert.deepEqual(
				answers.map((answer) => [member(answer, 'kind'), member(answer, 'requestKind')]),
				[
					['grantRequest', ORPHANED_RESOURCE_REQUEST],
					['grantRequest', ORPHANED_RESOURCE_REQUEST],
				],
			);
			assert.deepEqual(
				stored.map((request) => ({
					capabilities: request.capabilities,
					category: request.category,
					decision: request.decision,
					holder: request.holderSubject,
					kind: request.kind,
					requestedBy: request.requestedBySubject,
					resource: request.resource,
					role: request.role,
				})),
				[REGISTERED_STUDY, OPEN_STUDY].map((resource) => ({
					capabilities: SHOWN.viewer,
					category: CONTROLLED,
					decision: null,
					holder: CAST.recipient.subject,
					kind: ORPHANED_RESOURCE_REQUEST,
					requestedBy: CAST.administrator.subject,
					resource,
					role: 'viewer',
				})),
			);
			assert.deepEqual(
				await Promise.all(requestIds.map((requestId) => requestNotificationsOf(harness, requestId))),
				[[], []],
			);
			assert.deepEqual(
				await storedGrants(harness, {
					holder: CAST.recipient.subject,
					role: 'viewer',
				}),
				[],
			);
			assert.deepEqual(
				asked.map((events) => events.map((data) => [data['kind'], data['granteeId']])),
				[
					[[ORPHANED_RESOURCE_REQUEST, CAST.recipient.subject]],
					[[ORPHANED_RESOURCE_REQUEST, CAST.recipient.subject]],
				],
			);
		});
	});

	test('lists it to every other administrator and to the one who asked, and to nobody else', async () => {
		await withHarness({ fixture: pendingOwner() }, async (harness) => {
			const requestId = requestIdOf(
				await createGrant(await administratorCaller(harness), viewerOn(REGISTERED_STUDY)),
			);
			const listedTo = async (caller: Parameters<typeof listGrantRequests>[0]): Promise<readonly unknown[]> => {
				const listed = await listGrantRequests(caller);
				assertSucceeded(listed, 'the listing');
				const requests = member(listed, 'requests');
				return Array.isArray(requests)
					? requests.map((request: unknown) =>
							typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : request,
						)
					: [];
			};

			const listed = [
				await listedTo(
					await administratorCaller(harness, {
						person: CAST.secondAdministrator,
					}),
				),
				await listedTo(await administratorCaller(harness)),
				await listedTo(await personCaller(harness, CAST.recipient)),
				await listedTo(await personCaller(harness, CAST.spare)),
			];

			assert.deepEqual(listed, [[requestId], [requestId], [], []]);
		});
	});

	test("grants it as another administrator, writing the grant pending its holder's answer, granted by that administrator and requested by the one who asked", async () => {
		await withHarness({ fixture: pendingOwner() }, async (harness) => {
			const expiresAt = inTwoHours();
			const requestId = requestIdOf(
				await createGrant(
					await administratorCaller(harness),
					grantFor(CAST.recipient, { expiresAt, resource: REGISTERED_STUDY }),
				),
			);

			const grantId = createdId(
				await decideGrantRequest(
					await administratorCaller(harness, {
						person: CAST.secondAdministrator,
					}),
					requestId,
					'granted',
				),
				'the grant',
			);

			const grant = await storedGrant(harness, grantId);
			const request = await storedGrantRequest(harness, requestId);
			const decisions = await eventsNaming(
				harness,
				RULED_GRANT_EVENT_TYPES.grantRequestDecision,
				'grantId',
				grantId,
			);
			assert.deepEqual(
				{
					expiresAt: grant.expiresAt?.getTime(),
					granter: grant.granterSubject,
					holder: grant.holderSubject,
					requestedBy: await grantRequestedBy(harness, grantId),
				},
				{
					expiresAt: Date.parse(expiresAt),
					granter: CAST.secondAdministrator.subject,
					holder: CAST.recipient.subject,
					requestedBy: CAST.administrator.subject,
				},
			);
			assert.deepEqual(await storedDecisions(harness, grantId), []);
			assert.deepEqual(
				[request.decision, request.deciderSubject, request.grantId],
				['granted', CAST.secondAdministrator.subject, grantId],
			);
			assert.deepEqual(
				decisions.map((data) => data['granteeId']),
				[CAST.recipient.subject],
			);
		});
	});

	test("records the holder's acceptance of what the role confers at the grant when the instance accepts grants at creation", async () => {
		await withHarness({ configuration: { autoAccept: true }, fixture: pendingOwner() }, async (harness) => {
			const requestId = requestIdOf(await createGrant(await administratorCaller(harness), viewerOn(OPEN_STUDY)));

			const grantId = createdId(
				await decideGrantRequest(
					await administratorCaller(harness, {
						person: CAST.secondAdministrator,
					}),
					requestId,
					'granted',
				),
				'the grant',
			);

			assert.deepEqual(
				(await storedDecisions(harness, grantId)).map(({ capabilities, decision, deciderSubject }) => [
					decision,
					deciderSubject,
					capabilities,
				]),
				[['accepted', CAST.recipient.subject, SHOWN.viewer]],
			);
		});
	});

	test('lets the counted owner the resource gains decide it, refuses an administrator granting it 403, and lets an administrator refuse it', async () => {
		await withHarness({ fixture: pendingOwner() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const peer = await administratorCaller(harness, {
				person: CAST.secondAdministrator,
			});
			const owner = await personCaller(harness, CAST.spare);
			const grantedId = requestIdOf(await createGrant(administrator, viewerOn(REGISTERED_STUDY)));
			const refusedId = requestIdOf(await createGrant(administrator, viewerOn(REGISTERED_STUDY, UNMARKED)));
			assertSucceeded(
				await answerGrant(owner, seededId(harness.seeded.grants, PENDING_OWNER), {
					capabilities: [...SHOWN.owner],
					decision: 'accepted',
				}),
				"the owner's acceptance",
			);

			const byPeer = await decideGrantRequest(peer, grantedId, 'granted');
			const byOwner = await decideGrantRequest(owner, grantedId, 'granted');
			const refusedByPeer = await decideGrantRequest(peer, refusedId, 'refused');
			const onOwned = await createGrant(administrator, viewerOn(REGISTERED_STUDY, UNMARKED));

			assertRefused(
				byPeer,
				PROBLEMS.administratorGrantsNoConsumerAccess,
				"an administrator's grant once the resource has a counted owner",
			);
			assert.equal(
				(await storedGrant(harness, createdId(byOwner, "the owner's grant"))).granterSubject,
				CAST.spare.subject,
			);
			assertSucceeded(refusedByPeer, "an administrator's refusal");
			assert.equal((await storedGrantRequest(harness, refusedId)).decision, 'refused');
			assertRefused(
				onOwned,
				PROBLEMS.administratorGrantsNoConsumerAccess,
				"an administrator's grant once the resource has a counted owner",
			);
		});
	});
});
