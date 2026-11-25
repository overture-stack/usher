import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	type AdminOverrides,
	type AdminResponse,
	answerGrant,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	assertUnreadable,
	assertUnsupportedMediaType,
	createGrant,
	type ExpectedRefusal,
	FIELD_CATEGORY_MEMBER,
	type GrantCreated,
	type GrantCreation,
	personCaller,
	PROBLEMS,
	sendRaw,
	stringsIn,
} from '../../../testing/harness/admin.js';
import {
	answeredInFixture,
	answerNames,
	answerNamesInstant,
	atOffset,
	B2_OWN_CATEGORY,
	CAST,
	CONTROLLED,
	createdId,
	fixtureGrant,
	grantFor,
	grantsFixture,
	HOUR_MS,
	instantFromNow,
	racedAtTheGrantsTable,
	rowCounts,
	SHOWN,
	storedDecisions,
	storedGrant,
	storedGrants,
	STUDY_A1,
	STUDY_B2,
	uncategorizedGrantFor,
	UNKNOWN_STUDY,
	UNMARKED,
	UUID_FORM,
} from '../../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../../testing/harness/harness.js';
import { inTurn, usersWithSubject } from '../../../testing/harness/policy.js';

const DAY_MS = 24 * HOUR_MS;

interface Attempt {
	creation: GrantCreation;
	overrides?: AdminOverrides;
}

interface Answered {
	answer: GrantCreated;
	name: string;
}

const creationsBy = (caller: AdminCaller, attempts: Readonly<Record<string, Attempt>>): Promise<readonly Answered[]> =>
	inTurn(Object.entries(attempts), async ([name, attempt]) => ({
		answer: await createGrant(caller, attempt.creation, attempt.overrides),
		name,
	}));

const assertEachRefused = (
	answered: readonly Answered[],
	assertion: (response: AdminResponse, label: string) => void,
): void => {
	answered.forEach(({ answer, name }) => {
		assertion(answer, name);
	});
};

const refusedAs =
	(expected: ExpectedRefusal) =>
	(response: AdminResponse, label: string): void =>
		assertRefused(response, expected, label);

const ownerOf = (harness: Harness): Promise<AdminCaller> => personCaller(harness, CAST.ownerOfA1);

const withMembers = (members: Readonly<Record<string, unknown>>): Attempt => ({
	creation: grantFor(CAST.recipient),
	overrides: { extraMembers: members },
});

const recipientsGrants = (harness: Harness): ReturnType<typeof storedGrants> =>
	storedGrants(harness, { holder: CAST.recipient.subject });

suite('creating a grant', () => {
	test('creates a grant on a resource named by its externalId', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const sentAt = Date.now();

			const created = await createGrant(owner, grantFor(CAST.recipient));
			const answeredAt = Date.now();

			const grantId = createdId(created, 'the creation');
			assert.match(grantId, UUID_FORM);
			const stored = await storedGrant(harness, grantId);
			assert.deepEqual(
				{
					category: stored.category,
					expiresAt: stored.expiresAt,
					granter: stored.granterSubject,
					holder: stored.holderSubject,
					resource: stored.resource,
					revokedAt: stored.revokedAt,
					role: stored.role,
				},
				{
					category: CONTROLLED,
					expiresAt: null,
					granter: CAST.ownerOfA1.subject,
					holder: CAST.recipient.subject,
					resource: STUDY_A1,
					revokedAt: null,
					role: 'viewer',
				},
			);
			assert.ok(
				stored.grantedAt.getTime() >= sentAt - 1000 && stored.grantedAt.getTime() <= answeredAt + 1000,
				'the grant time is the creation',
			);
			assert.deepEqual(await storedDecisions(harness, grantId), []);
			[STUDY_A1, CONTROLLED, 'viewer', CAST.recipient.subject, CAST.ownerOfA1.subject].forEach((named) => {
				assert.ok(answerNames(created, named), `the answer names ${named}`);
			});
			assert.ok(answerNamesInstant(created, stored.grantedAt), 'the answer names the grant time');
		});
	});

	test('answers a grant on an unknown resource with the resource-not-found error', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const administrator = await administratorCaller(harness);
			const resources = [UNKNOWN_STUDY, STUDY_A1.toLowerCase()];
			const before = await rowCounts(harness);

			const byOwner = await creationsBy(
				owner,
				Object.fromEntries(
					resources.map((resource) => [
						`an owner's grant on ${resource}`,
						{ creation: grantFor(CAST.recipient, { resource }) },
					]),
				),
			);
			const byAdministrator = await creationsBy(
				administrator,
				Object.fromEntries(
					resources.map((resource) => [
						`an administrator's grant on ${resource}`,
						{
							creation: uncategorizedGrantFor(CAST.recipient, 'submitter', resource),
						},
					]),
				),
			);
			const after = await rowCounts(harness);
			const known = await createGrant(owner, grantFor(CAST.recipient));

			assertEachRefused([...byOwner, ...byAdministrator], refusedAs(PROBLEMS.resourceNotFound));
			assert.deepEqual(after, before);
			createdId(known, 'a grant on STUDY-A1');
		});
	});

	test('accepts a category the resource offers', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const before = await rowCounts(harness);

			const refused = await creationsBy(owner, {
				'a bare category name': {
					creation: grantFor(CAST.recipient, { category: 'controlled' }),
				},
				'an unregistered global category': {
					creation: grantFor(CAST.recipient, {
						category: 'global.nonexistent',
					}),
				},
				"another resource's own category": {
					creation: grantFor(CAST.recipient, { category: B2_OWN_CATEGORY }),
				},
			});
			const after = await rowCounts(harness);
			const accepted = await creationsBy(owner, {
				[CONTROLLED]: {
					creation: grantFor(CAST.recipient, { category: CONTROLLED }),
				},
				[UNMARKED]: {
					creation: grantFor(CAST.recipient, { category: UNMARKED }),
				},
			});

			assertEachRefused(refused, assertRuleBroken);
			assert.deepEqual(after, before);
			const categories = await inTurn(
				accepted,
				async ({ answer, name }) => (await storedGrant(harness, createdId(answer, name))).category,
			);
			assert.deepEqual(categories, [CONTROLLED, UNMARKED]);
		});
	});

	test('requires a record category on a data-plane role', async () => {
		await withHarness(
			{
				configuration: { submitterCategory: CONTROLLED },
				fixture: grantsFixture(),
			},
			async (harness) => {
				const owner = await ownerOf(harness);
				const before = await rowCounts(harness);

				const refused = await creationsBy(
					owner,
					Object.fromEntries(
						['viewer', 'editor', 'curator'].map((role) => [
							`a ${role} grant naming no category`,
							{
								creation: {
									holder: { subject: CAST.recipient.subject },
									resource: STUDY_A1,
									role,
								},
							},
						]),
					),
				);
				const after = await rowCounts(harness);
				const categorized = await createGrant(owner, grantFor(CAST.recipient));
				const submitter = await createGrant(
					await administratorCaller(harness),
					uncategorizedGrantFor(CAST.recipient, 'submitter'),
				);

				assertEachRefused(refused, assertRuleBroken);
				assert.deepEqual(after, before);
				createdId(categorized, 'a viewer grant naming its category');
				const { category } = await storedGrant(
					harness,
					createdId(submitter, 'a submitter grant naming no category'),
				);
				assert.equal(category, CONTROLLED);
			},
		);
	});

	test('gives a control-plane role the whole resource', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const before = await rowCounts(harness);

			const naming = await createGrant(administrator, {
				...uncategorizedGrantFor(CAST.recipient, 'owner'),
				categories: [CONTROLLED],
			});
			const after = await rowCounts(harness);
			const whole = await createGrant(administrator, uncategorizedGrantFor(CAST.recipient, 'owner'));

			assertRuleBroken(naming, 'an owner grant naming a category');
			assert.deepEqual(after, before);
			const stored = await storedGrant(harness, createdId(whole, 'an owner grant naming no category'));
			assert.deepEqual({ category: stored.category, role: stored.role }, { category: null, role: 'owner' });
		});
	});

	test('takes no expiry on an owner grant', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);
			const expiresAt = instantFromNow(30 * DAY_MS);
			const before = await rowCounts(harness);

			const byAdministrator = await createGrant(administrator, {
				...uncategorizedGrantFor(CAST.recipient, 'owner', STUDY_B2),
				expiresAt,
			});
			const byOwner = await createGrant(await ownerOf(harness), {
				...uncategorizedGrantFor(CAST.recipient, 'owner'),
				expiresAt,
			});
			const after = await rowCounts(harness);
			const withoutExpiry = await createGrant(
				administrator,
				uncategorizedGrantFor(CAST.recipient, 'owner', STUDY_B2),
			);

			assertRefused(
				byAdministrator,
				PROBLEMS.ownerGrantsDoNotExpire,
				"an administrator's owner grant with an expiry",
			);
			assertRefused(byOwner, PROBLEMS.ownerGrantsDoNotExpire, "an owner's owner grant with an expiry");
			assert.deepEqual(after, before);
			const { expiresAt: stored } = await storedGrant(
				harness,
				createdId(withoutExpiry, 'an owner grant with no expiry'),
			);
			assert.equal(stored, null);
		});
	});

	test('refuses a field category on a grant whose role carries record.delete', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const curator = grantFor(CAST.recipient, { role: 'curator' });
			const before = await rowCounts(harness);

			const withField = await createGrant(owner, curator, {
				extraMembers: { [FIELD_CATEGORY_MEMBER]: UNMARKED },
			});
			const after = await rowCounts(harness);
			const recordsAlone = await createGrant(owner, curator);

			assertRuleBroken(withField, 'a curator grant with a field category');
			assert.deepEqual(after, before);
			createdId(recordsAlone, 'the curator grant on records alone');
		});
	});

	test("takes a grant's record category alone in the first release", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const before = await rowCounts(harness);

			const withField = await createGrant(owner, grantFor(CAST.recipient), {
				extraMembers: { [FIELD_CATEGORY_MEMBER]: UNMARKED },
			});
			const after = await rowCounts(harness);
			const recordsAlone = await createGrant(owner, grantFor(CAST.recipient));

			assertRuleBroken(withField, 'a viewer grant with a field category');
			assert.deepEqual(after, before);
			createdId(recordsAlone, 'the viewer grant on records alone');
		});
	});

	test('accepts only a defined role', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const before = await rowCounts(harness);

			const refused = await creationsBy(
				owner,
				Object.fromEntries(
					['superuser', 'Viewer', 'surveyor', ''].map((role) => [
						`the role ${JSON.stringify(role)}`,
						{ creation: grantFor(CAST.recipient, { role }) },
					]),
				),
			);
			const after = await rowCounts(harness);
			const defined = await createGrant(owner, grantFor(CAST.recipient));

			assertEachRefused(refused, assertRuleBroken);
			assert.deepEqual(after, before);
			createdId(defined, 'the viewer role');
		});
	});

	test('names a person as the holder in the first release', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const before = await rowCounts(harness);

			const group = await createGrant(owner, grantFor(CAST.recipient), {
				extraMembers: { holder: { group: 'study-a1-team' } },
			});
			const bothWays = await createGrant(owner, grantFor(CAST.recipient), {
				extraMembers: {
					holder: {
						email: CAST.recipient.email,
						subject: CAST.recipient.subject,
					},
				},
			});
			const after = await rowCounts(harness);
			const person = await createGrant(owner, grantFor(CAST.recipient));

			assertRuleBroken(group, 'a group as the holder');
			assertRuleBroken(bothWays, 'a holder named by subject and address at once');
			assert.deepEqual(after, before);
			createdId(person, 'a person by subject');
		});
	});

	test('takes an expiry only as an instant', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const ahead = new Date(Math.floor((Date.now() + 30 * DAY_MS) / 1000) * 1000);
			const before = await rowCounts(harness);

			const notInstants = await creationsBy(owner, {
				'a bare date': withMembers({
					expiresAt: ahead.toISOString().slice(0, 10),
				}),
				'a word': withMembers({ expiresAt: 'tomorrow' }),
				'an instant with no offset': withMembers({
					expiresAt: ahead.toISOString().slice(0, 19),
				}),
			});
			const epochSeconds = await createGrant(owner, grantFor(CAST.recipient), {
				extraMembers: { expiresAt: ahead.getTime() / 1000 },
			});
			const past = await createGrant(owner, grantFor(CAST.recipient, { expiresAt: instantFromNow(-HOUR_MS) }));
			const after = await rowCounts(harness);
			const withOffset = await createGrant(owner, grantFor(CAST.recipient, { expiresAt: atOffset(ahead, -300) }));

			assertEachRefused(notInstants, assertRuleBroken);
			assertUnreadable(epochSeconds, 'seconds since the epoch');
			assertRuleBroken(past, 'an instant past');
			assert.deepEqual(after, before);
			const { expiresAt } = await storedGrant(harness, createdId(withOffset, 'an instant at an offset'));
			assert.equal(expiresAt?.getTime(), ahead.getTime());
			assert.ok(
				stringsIn(withOffset.body).some(
					(value) => value.endsWith('Z') && Date.parse(value) === ahead.getTime(),
				),
				'the answer reads the expiry back in UTC',
			);
		});
	});

	test('takes no start date', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const start = instantFromNow(DAY_MS);
			const before = await rowCounts(harness);

			const refused = await creationsBy(owner, {
				'a startDate member': withMembers({ startDate: start.slice(0, 10) }),
				'a startsAt member': withMembers({ startsAt: start }),
			});
			const after = await rowCounts(harness);
			const immediate = await createGrant(owner, grantFor(CAST.recipient));

			assertEachRefused(refused, assertUnreadable);
			assert.deepEqual(after, before);
			createdId(immediate, 'a grant from now');
		});
	});

	test('records the caller as the granter', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const before = await rowCounts(harness);

			const refused = await creationsBy(owner, {
				'a granter named by a holder object': withMembers({
					grantedBy: { subject: CAST.ownerOfB2.subject },
				}),
				'a granter named by subject': withMembers({
					grantedBy: CAST.ownerOfB2.subject,
				}),
			});
			const after = await rowCounts(harness);
			const unnamed = await createGrant(owner, grantFor(CAST.recipient));

			assertEachRefused(refused, assertRuleBroken);
			assert.deepEqual(after, before);
			const { granterSubject } = await storedGrant(harness, createdId(unnamed, 'a grant naming no granter'));
			assert.equal(granterSubject, CAST.ownerOfA1.subject);
		});
	});

	test("reads a grant's creation only as one JSON object of known members", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await ownerOf(harness);
			const json = JSON.stringify(grantFor(CAST.recipient));
			const departures: Readonly<Record<string, AdminOverrides>> = {
				'a __proto__ member': {
					body: `{"__proto__":{"role":"curator"},${json.slice(1)}`,
				},
				'a list holding the creation': { body: `[${json}]` },
				'a member named twice': {
					body: `${json.slice(0, -1)},"role":"curator"}`,
				},
			};
			const mediaTypes = ['application/merge-patch+json', 'application/x-www-form-urlencoded', 'text/plain'];
			const asCreation = (overrides: AdminOverrides): { creation: GrantCreation; overrides: AdminOverrides } => ({
				creation: grantFor(CAST.recipient),
				overrides,
			});
			const before = await rowCounts(harness);

			const unreadable = await creationsBy(
				owner,
				Object.fromEntries(
					Object.entries(departures).map(([name, overrides]) => [name, asCreation(overrides)]),
				),
			);
			const unsupported = await creationsBy(
				owner,
				Object.fromEntries(
					mediaTypes.map((mediaType) => [
						`the media type ${mediaType}`,
						asCreation({ headers: { 'content-type': mediaType } }),
					]),
				),
			);
			const noMediaType = await sendRaw(owner, (caller) => createGrant(caller, grantFor(CAST.recipient)), {
				contentType: null,
			});
			const after = await rowCounts(harness);
			const plain = await createGrant(owner, grantFor(CAST.recipient));

			assertEachRefused(unreadable, assertUnreadable);
			assertEachRefused(unsupported, assertUnsupportedMediaType);
			assertUnsupportedMediaType(noMediaType, 'a body with no media type');
			assert.deepEqual(after, before);
			const { role } = await storedGrant(harness, createdId(plain, 'the creation as JSON'));
			assert.equal(role, 'viewer');
		});
	});

	test('writes no decision when auto-accept is off', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const grantId = createdId(
				await createGrant(await ownerOf(harness), grantFor(CAST.recipient)),
				'the creation',
			);

			const atCreation = await storedDecisions(harness, grantId);
			const answered = await answerGrant(await personCaller(harness, CAST.recipient), grantId, {
				capabilities: SHOWN.viewer,
				decision: 'accept',
			});
			const afterAnswer = await storedDecisions(harness, grantId);

			assert.deepEqual(atCreation, []);
			assertSucceeded(answered, 'the recipient accepting');
			assert.equal(afterAnswer.length, 1, 'the answer is the first decision');
		});
	});

	test('writes an accepting decision for the holder when auto-accept is on', async () => {
		await withHarness({ configuration: { autoAccept: true }, fixture: grantsFixture() }, async (harness) => {
			const grantId = createdId(
				await createGrant(await ownerOf(harness), grantFor(CAST.recipient)),
				'the creation',
			);

			const decisions = await storedDecisions(harness, grantId);

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
		});
	});

	test('answers a grant the holder already holds with the already-holds error', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [
						answeredInFixture('acceptedUnmarked'),
						answeredInFixture('declinedCurator', 'declined'),
					],
					grants: {
						acceptedUnmarked: fixtureGrant('recipient', 'viewer', {
							category: 'unmarked',
						}),
						declinedCurator: fixtureGrant('recipient', 'curator'),
						pendingViewer: fixtureGrant('recipient', 'viewer'),
					},
				}),
			},
			async (harness) => {
				const owner = await ownerOf(harness);
				const held = await recipientsGrants(harness);

				const refused = await creationsBy(owner, {
					'a declined grant': {
						creation: grantFor(CAST.recipient, { role: 'curator' }),
					},
					'a pending grant': { creation: grantFor(CAST.recipient) },
					'an accepted grant': {
						creation: grantFor(CAST.recipient, { category: UNMARKED }),
					},
				});
				const afterRefusals = await recipientsGrants(harness);
				const another = await createGrant(owner, grantFor(CAST.recipient, { role: 'editor' }));

				assertEachRefused(refused, refusedAs(PROBLEMS.alreadyHolds));
				assert.equal(held.length, 3);
				assert.deepEqual(afterRefusals, held);
				createdId(another, 'a grant at another role');
			},
		);
	});

	test('creates a grant again after the earlier one was revoked or has expired', async () => {
		const now = Date.now();
		await withHarness(
			{
				fixture: grantsFixture({
					decisions: [answeredInFixture('expired', 'accepted', new Date(now - 2 * HOUR_MS))],
					grants: {
						expired: fixtureGrant('recipient', 'viewer', {
							category: 'unmarked',
							expiresAt: new Date(now - HOUR_MS),
							grantedAt: new Date(now - 3 * HOUR_MS),
						}),
						revoked: fixtureGrant('recipient', 'viewer', {
							grantedAt: new Date(now - 3 * HOUR_MS),
							revoked: { at: new Date(now - HOUR_MS), by: 'ownerOfA1' },
						}),
					},
				}),
			},
			async (harness) => {
				const earlier = await recipientsGrants(harness);

				const again = await creationsBy(await ownerOf(harness), {
					'after a revoked grant': { creation: grantFor(CAST.recipient) },
					'after an expired grant': {
						creation: grantFor(CAST.recipient, { category: UNMARKED }),
					},
				});

				const created = again.map(({ answer, name }) => createdId(answer, name));
				const held = await recipientsGrants(harness);
				assert.equal(earlier.length, 2);
				assert.deepEqual(
					held.map(({ id }) => id).toSorted(),
					[...earlier.map(({ id }) => id), ...created].toSorted(),
				);
				earlier.forEach((kept) => {
					assert.deepEqual(
						held.find(({ id }) => id === kept.id),
						kept,
						'the earlier grant is kept as it was',
					);
				});
			},
		);
	});

	test('keeps one live grant when identical creations race', async () => {
		// Longer than the grants table hold racedAtTheGrantsTable takes: each creation waits it out rather than timing out.
		await withHarness(
			{ configuration: { storeTimeoutMilliseconds: 15_000 }, fixture: grantsFixture() },
			async (harness) => {
				const owner = await ownerOf(harness);

				const answers = await racedAtTheGrantsTable(harness, 3, () =>
					createGrant(owner, grantFor(CAST.recipient)),
				);

				const created = answers.filter(({ status }) => status >= 200 && status < 300);
				const lost = answers.filter(({ status }) => status >= 300);
				assert.equal(created.length, 1, 'one creation succeeds');
				lost.forEach((answer, index) => {
					assertRefused(answer, PROBLEMS.alreadyHolds, `losing creation ${index}`);
				});
				const live = (await recipientsGrants(harness)).filter(
					({ resource, revokedAt, role }) => resource === STUDY_A1 && revokedAt === null && role === 'viewer',
				);
				assert.equal(live.length, 1);
			},
		);
	});

	test('creates a grant for an account that has never used an application', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const { newcomer } = CAST;
			const beforehand = await usersWithSubject(harness.clients.migration, newcomer.subject);

			const grantId = createdId(
				await createGrant(await ownerOf(harness), grantFor(newcomer)),
				'a grant for an account never seen',
			);
			const answered = await answerGrant(await personCaller(harness, newcomer), grantId, {
				capabilities: SHOWN.viewer,
				decision: 'accept',
			});

			assert.equal(beforehand, 0);
			const stored = await storedGrant(harness, grantId);
			assert.deepEqual(
				{ issuer: stored.holderIssuer, subject: stored.holderSubject },
				{
					issuer: harness.identityProvider.issuer,
					subject: newcomer.subject,
				},
			);
			assertSucceeded(answered, "the newcomer's first answer");
			assert.deepEqual(
				(await storedDecisions(harness, grantId)).map(({ deciderSubject }) => deciderSubject),
				[newcomer.subject],
			);
		});
	});
});
