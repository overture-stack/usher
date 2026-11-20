import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	type AdminResponse,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	comparableRefusal,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	type ExpectedRefusal,
	personCaller,
	PROBLEMS,
	revokeGrant,
} from '../../../testing/harness/admin.js';
import type { Person } from '../../../testing/harness/exchange.js';
import {
	answeredInFixture,
	CAST,
	createdId,
	fixtureGrant,
	grantFor,
	grantsFixture,
	HOUR_MS,
	instantFromNow,
	OPEN_STUDY,
	REGISTERED_STUDY,
	rowCounts,
	selfGrantUntil,
	storedGrant,
	STUDY_A1,
	STUDY_B2,
	uncategorizedGrantFor,
	UNKNOWN_STUDY,
	UNMARKED,
} from '../../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../../testing/harness/harness.js';
import { type BaseTier, inTurn, seededId } from '../../../testing/harness/policy.js';

interface NamedCaller {
	caller: AdminCaller;
	name: string;
}

const callersWho = (
	harness: Harness,
	people: readonly { name: string; person: Person }[],
): Promise<readonly NamedCaller[]> =>
	inTurn(people, async ({ name, person }) => ({
		caller: await personCaller(harness, person),
		name,
	}));

const callersWithoutAuthority = (harness: Harness): Promise<readonly NamedCaller[]> =>
	callersWho(harness, [
		{ name: 'the owner of another resource', person: CAST.ownerOfB2 },
		{ name: 'a curator on the resource', person: CAST.curator },
		{ name: 'an outsider', person: CAST.outsider },
	]);

const assertAnsweredAlike = (
	answer: AdminResponse,
	reference: AdminResponse,
	what: string,
	expected: ExpectedRefusal = PROBLEMS.resourceNotFound,
): void => {
	assertRefused(reference, expected, `${what}, the reference`);
	assertRefused(answer, expected, what);
	assert.deepEqual(comparableRefusal(answer), comparableRefusal(reference), what);
};

const holderOf = (person: Person): { subject: string } => ({
	subject: person.subject,
});

suite('who may create and revoke a grant', () => {
	test('lets an administrator make submitter grants on any resource and leaves consumer access to its owners', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const refused = await inTurn(['viewer', 'editor', 'curator'], async (role) => ({
				answer: await createGrant(administrator, grantFor(CAST.recipient, { resource: STUDY_B2, role })),
				name: `a ${role} grant`,
				onUnknown: await createGrant(
					administrator,
					grantFor(CAST.recipient, { resource: UNKNOWN_STUDY, role }),
				),
			}));
			const after = await rowCounts(harness);
			const submitter = await createGrant(
				administrator,
				uncategorizedGrantFor(CAST.recipient, 'submitter', STUDY_B2),
			);
			const byOwner = await createGrant(
				await personCaller(harness, CAST.ownerOfB2),
				grantFor(CAST.recipient, { resource: STUDY_B2 }),
			);

			refused.forEach(({ answer, name, onUnknown }) => {
				assertAnsweredAlike(
					answer,
					onUnknown,
					`${name}: the refusal names no resource`,
					PROBLEMS.administratorGrantsNoConsumerAccess,
				);
			});
			assert.deepEqual(after, before);
			const stored = await storedGrant(harness, createdId(submitter, "the administrator's submitter grant"));
			assert.deepEqual(
				{
					category: stored.category,
					granter: stored.granterSubject,
					holder: stored.holderSubject,
					resource: stored.resource,
					role: stored.role,
				},
				{
					category: UNMARKED,
					granter: CAST.administrator.subject,
					holder: CAST.recipient.subject,
					resource: STUDY_B2,
					role: 'submitter',
				},
			);
			createdId(byOwner, "the owner's viewer grant");
		});
	});

	test('lets an owner create and revoke grants on their own resource', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);

			const grantId = createdId(await createGrant(owner, grantFor(CAST.recipient)), "the owner's grant");
			const revoked = await revokeGrant(owner, grantId);

			assertSucceeded(revoked, "revoking the owner's grant");
			const stored = await storedGrant(harness, grantId);
			assert.equal(stored.granterSubject, CAST.ownerOfA1.subject);
			assert.equal(stored.revokerSubject, CAST.ownerOfA1.subject);
			assert.notEqual(stored.revokedAt, null);
		});
	});

	test('treats an owner grant as authority only while it is accepted and unrevoked', async () => {
		const now = Date.now();
		const lapsed = {
			category: null,
			grantedAt: new Date(now - 3 * HOUR_MS),
		};
		const studies: Readonly<Record<string, { baseTier: BaseTier; externalId: string; seen: boolean }>> = {
			declinedOnControlled: {
				baseTier: 'grant',
				externalId: 'STUDY-D2',
				seen: false,
			},
			declinedOnOpen: { baseTier: 'open', externalId: 'STUDY-D1', seen: true },
			pending: { baseTier: 'grant', externalId: 'STUDY-P1', seen: true },
			revoked: { baseTier: 'grant', externalId: 'STUDY-R1', seen: false },
		};
		const studyOf = (state: string): string => studies[state]?.externalId ?? UNKNOWN_STUDY;
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [
						answeredInFixture('declinedOnControlled', 'rejected'),
						answeredInFixture('declinedOnOpen', 'rejected'),
						answeredInFixture('revoked', 'accepted', new Date(now - 2 * HOUR_MS)),
					],
					grants: {
						declinedOnControlled: fixtureGrant('ownerOfA1', 'owner', {
							category: null,
							resource: studyOf('declinedOnControlled'),
						}),
						declinedOnOpen: fixtureGrant('ownerOfA1', 'owner', {
							category: null,
							resource: studyOf('declinedOnOpen'),
						}),
						pending: fixtureGrant('ownerOfA1', 'owner', {
							category: null,
							resource: studyOf('pending'),
						}),
						revoked: fixtureGrant('ownerOfA1', 'owner', {
							...lapsed,
							resource: studyOf('revoked'),
							revoked: { at: new Date(now - HOUR_MS), by: 'ownerOfB2' },
						}),
					},
					resources: Object.fromEntries(
						Object.entries(studies).map(([state, { baseTier, externalId }]) => [
							externalId,
							{ baseTier, name: `Study owned while ${state}` },
						]),
					),
				}),
			},
			async (harness) => {
				const owner = await personCaller(harness, CAST.ownerOfA1);
				const before = await rowCounts(harness);

				const unknown = await createGrant(owner, grantFor(CAST.recipient, { resource: UNKNOWN_STUDY }));
				const refused = await inTurn(Object.entries(studies), async ([state, { externalId, seen }]) => ({
					answer: await createGrant(owner, grantFor(CAST.recipient, { resource: externalId })),
					seen,
					state,
				}));
				const after = await rowCounts(harness);
				const accepted = await createGrant(owner, grantFor(CAST.recipient));

				refused.forEach(({ answer, seen, state }) => {
					if (seen) {
						assertRefused(answer, PROBLEMS.noAuthorityOnResource, `an owner grant ${state}`);
						return;
					}
					assertAnsweredAlike(answer, unknown, `an owner grant ${state}`);
				});
				assert.deepEqual(after, before);
				createdId(accepted, 'an accepted owner grant');
			},
		);
	});

	test('answers a principal without grant authority on a resource exactly as for a resource that does not exist', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('declinedByLookalike', 'rejected')],
					grants: { declinedByLookalike: fixtureGrant('lookalike', 'viewer') },
				}),
			},
			async (harness) => {
				const callers = await callersWho(harness, [
					{
						name: 'a holder who declined their grant on it',
						person: CAST.lookalike,
					},
					{ name: 'the owner of another resource', person: CAST.ownerOfB2 },
					{ name: 'an outsider', person: CAST.outsider },
				]);
				const before = await rowCounts(harness);

				const attempts = await inTurn(callers, async ({ caller, name }) => ({
					known: await createGrant(caller, grantFor(CAST.recipient)),
					name,
					unknown: await createGrant(caller, grantFor(CAST.recipient, { resource: UNKNOWN_STUDY })),
				}));
				const after = await rowCounts(harness);
				const byOwner = await createGrant(
					await personCaller(harness, CAST.ownerOfA1),
					grantFor(CAST.recipient),
				);

				attempts.forEach(({ known, name, unknown }) => {
					assertAnsweredAlike(known, unknown, name);
				});
				assert.deepEqual(after, before);
				createdId(byOwner, "the resource's owner");
			},
		);
	});

	test('refuses a principal who may see a resource but holds no authority on it', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const [curator, outsider] = await callersWho(harness, [
				{ name: 'a curator on the resource', person: CAST.curator },
				{ name: 'an outsider', person: CAST.outsider },
			]);
			if (curator === undefined || outsider === undefined) {
				return assert.fail('a caller was never made');
			}
			const before = await rowCounts(harness);

			const refused = [
				{
					answer: await createGrant(curator.caller, grantFor(CAST.recipient)),
					name: 'a curator, on the controlled resource they hold a grant on',
				},
				...(await inTurn([OPEN_STUDY, REGISTERED_STUDY], async (resource) => ({
					answer: await createGrant(outsider.caller, grantFor(CAST.recipient, { resource })),
					name: `an outsider, on ${resource}`,
				}))),
			];
			const after = await rowCounts(harness);
			const byOwner = await createGrant(await personCaller(harness, CAST.ownerOfA1), grantFor(CAST.recipient));

			refused.forEach(({ answer, name }) => {
				assertRefused(answer, PROBLEMS.noAuthorityOnResource, name);
			});
			assert.deepEqual(after, before);
			createdId(byOwner, "the resource's owner");
		});
	});

	test('answers a revocation by a principal without authority on its resource exactly as for an unknown grant', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('recipientViews')],
					grants: {
						recipientViews: fixtureGrant('recipient', 'viewer', {
							grantedBy: 'ownerOfA1',
						}),
					},
				}),
			},
			async (harness) => {
				const grantId = seededId(harness.seeded.grants, 'recipientViews');
				const callers = await callersWithoutAuthority(harness);

				const attempts = await inTurn(callers, async ({ caller, name }) => ({
					held: await revokeGrant(caller, grantId),
					name,
					unknown: await revokeGrant(caller, randomUUID()),
				}));
				const afterRefusals = await storedGrant(harness, grantId);
				const byOwner = await revokeGrant(await personCaller(harness, CAST.ownerOfA1), grantId);

				attempts.forEach(({ held, name, unknown }) => {
					assertAnsweredAlike(held, unknown, name, PROBLEMS.grantNotFound);
				});
				assert.equal(afterRefusals.revokedAt, null);
				assertSucceeded(byOwner, "the resource's owner revoking");
			},
		);
	});

	test('lets nobody grant the administrator role', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const administratorRole = {
				holder: holderOf(CAST.recipient),
				resource: STUDY_A1,
				role: 'admin',
			};
			const before = await rowCounts(harness);

			const byAdministrator = await createGrant(administrator, administratorRole);
			const byOwner = await createGrant(await personCaller(harness, CAST.ownerOfA1), administratorRole);
			const after = await rowCounts(harness);
			const submitter = await createGrant(administrator, uncategorizedGrantFor(CAST.recipient, 'submitter'));

			assertRuleBroken(byAdministrator, 'an administrator');
			assertRuleBroken(byOwner, 'an owner');
			assert.deepEqual(after, before);
			createdId(submitter, "the administrator's submitter grant");
		});
	});

	test('lets an administrator make anyone but themselves an owner', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const ofThemselves = await createGrant(
				administrator,
				uncategorizedGrantFor(CAST.administrator, 'owner', STUDY_B2),
			);
			const after = await rowCounts(harness);
			const ofAnother = await createGrant(
				administrator,
				uncategorizedGrantFor(CAST.ownerOfA1, 'owner', STUDY_B2),
			);
			const byPeer = await createGrant(
				await administratorCaller(harness, {
					person: CAST.secondAdministrator,
				}),
				uncategorizedGrantFor(CAST.administrator, 'owner', STUDY_B2),
			);

			assertRefused(ofThemselves, PROBLEMS.administratorSelfOwnership, 'an administrator naming themself');
			assert.deepEqual(after, before);
			const stored = await inTurn(
				[createdId(ofAnother, 'another person'), createdId(byPeer, 'a peer administrator naming them')],
				(id) => storedGrant(harness, id),
			);
			assert.deepEqual(
				stored.map(({ category, granterSubject, holderSubject }) => ({
					category,
					granter: granterSubject,
					holder: holderSubject,
				})),
				[
					{
						category: null,
						granter: CAST.administrator.subject,
						holder: CAST.ownerOfA1.subject,
					},
					{
						category: null,
						granter: CAST.secondAdministrator.subject,
						holder: CAST.administrator.subject,
					},
				],
			);
		});
	});

	test('lets an owner add an owner to their own resource', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);

			const onOwn = await createGrant(owner, uncategorizedGrantFor(CAST.recipient, 'owner'));
			const onOther = await createGrant(owner, uncategorizedGrantFor(CAST.recipient, 'owner', STUDY_B2));
			const onUnknown = await createGrant(owner, uncategorizedGrantFor(CAST.recipient, 'owner', UNKNOWN_STUDY));

			const stored = await storedGrant(harness, createdId(onOwn, 'an owner on their own resource'));
			assert.equal(stored.role, 'owner');
			assert.equal(stored.holderSubject, CAST.recipient.subject);
			assertAnsweredAlike(onOther, onUnknown, 'another resource');
		});
	});

	test('lets the standard grant operation name only someone other than the caller', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const before = await rowCounts(harness);

			const refused = {
				'an administrator naming themselves': await createGrant(
					await administratorCaller(harness),
					grantFor(CAST.administrator),
				),
				'an owner naming themselves': await createGrant(owner, grantFor(CAST.ownerOfA1)),
			};
			const after = await rowCounts(harness);
			const forAnother = await createGrant(owner, grantFor(CAST.recipient));

			Object.entries(refused).forEach(([name, answer]) => {
				assertRuleBroken(answer, name);
				const { code = '', detail = '', title = '' } = answer.problem ?? {};
				assert.match(
					`${code} ${title} ${detail}`,
					/self-grant|grants\/self/iu,
					`${name}: the refusal names the self-grant operation`,
				);
			});
			assert.deepEqual(after, before);
			createdId(forAnother, 'an owner naming someone else');
		});
	});

	test("lets any administrator revoke any grant, a peer's self-grant included", async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('recipientViews')],
					grants: {
						recipientViews: fixtureGrant('recipient', 'viewer', {
							grantedBy: 'ownerOfA1',
						}),
					},
				}),
			},
			async (harness) => {
				const selfGrantId = createdId(
					await decideGrantRequest(
						await personCaller(harness, CAST.ownerOfA1),
						createdId(
							await createSelfGrant(
								await administratorCaller(harness),
								selfGrantUntil(instantFromNow(2 * HOUR_MS)),
							),
							"the first administrator's self-grant request",
						),
						'granted',
					),
					"the first administrator's self-grant",
				);
				const ownersGrantId = seededId(harness.seeded.grants, 'recipientViews');
				const peer = await administratorCaller(harness, {
					person: CAST.secondAdministrator,
				});

				const ofSelfGrant = await revokeGrant(peer, selfGrantId);
				const ofOwnersGrant = await revokeGrant(peer, ownersGrantId);

				assertSucceeded(ofSelfGrant, "revoking a peer's self-grant");
				assertSucceeded(ofOwnersGrant, "revoking an owner's grant");
				const stored = await Promise.all([selfGrantId, ownersGrantId].map((id) => storedGrant(harness, id)));
				stored.forEach(({ revokedAt, revokerSubject }) => {
					assert.notEqual(revokedAt, null);
					assert.equal(revokerSubject, CAST.secondAdministrator.subject);
				});
			},
		);
	});
});
