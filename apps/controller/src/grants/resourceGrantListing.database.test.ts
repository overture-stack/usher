import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertForbidden,
	assertNotFound,
	assertSucceeded,
	assertUnavailable,
	carriesGrantSummary,
	comparableRefusal,
	GRANT_STATES,
	type GrantView,
	INCLUDING_REVOKED,
	listedGrants,
	listResourceGrants,
	personCaller,
	readResource,
	resourceView,
} from '../../testing/harness/admin.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import {
	answeredInFixture,
	CAST,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	OPEN_STUDY,
	STUDY_A1,
	UNKNOWN_STUDY,
} from '../../testing/fixtures/grants.js';
import { UNNAMED_SHARER } from '../../testing/fixtures/listings.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { seededId } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const RETIRED_STUDY = 'STUDY-R9';

const PAST = new Date(Date.now() - 2 * HOUR_MS);

// On STUDY-A1, beside Ana's ownership and Bo's curator grant: Cy's viewer grant from Ana, pending;
// Cy's submitter grant from Ana, declined; the spare person's viewer grant, revoked; the
// lookalike's viewer grant, expired, the lookalike's account since deleted from the directory; and
// the administrator's viewer grants, one granted to themself and one from Ana. On a retired study,
// Ana held a viewer grant, since expired.
const ON_A1 = grantsFixture({
	decisions: [
		answeredInFixture('cyDeclined', 'rejected'),
		answeredInFixture('spareRevoked'),
		answeredInFixture('lookalikeExpired'),
		answeredInFixture('administratorSelf'),
		answeredInFixture('administratorUnmarked'),
		answeredInFixture('anaRetired'),
	],
	grants: {
		administratorSelf: fixtureGrant('administrator', 'viewer', {
			expiresAt: new Date(Date.now() + 11 * HOUR_MS),
			grantedBy: 'administrator',
		}),
		administratorUnmarked: fixtureGrant('administrator', 'viewer', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
		}),
		anaRetired: fixtureGrant('ownerOfA1', 'viewer', {
			expiresAt: PAST,
			grantedAt: new Date(PAST.getTime() - HOUR_MS),
			resource: RETIRED_STUDY,
		}),
		cyDeclined: fixtureGrant('recipient', 'submitter', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
		}),
		cyPending: fixtureGrant('recipient', 'viewer', { grantedBy: 'ownerOfA1' }),
		lookalikeExpired: fixtureGrant('lookalike', 'viewer', {
			category: 'unmarked',
			expiresAt: PAST,
			grantedAt: new Date(PAST.getTime() - HOUR_MS),
			grantedBy: 'ownerOfA1',
		}),
		spareRevoked: fixtureGrant('spare', 'viewer', {
			grantedBy: 'ownerOfA1',
			revoked: { by: 'ownerOfA1' },
		}),
	},
	resources: {
		[RETIRED_STUDY]: {
			baseTier: 'grant',
			name: 'Retired cohort',
			retired: { at: new Date(PAST.getTime() + HOUR_MS) },
		},
	},
	users: { administrator: { subject: CAST.administrator.subject } },
});

// Every person the fixture seeds but the lookalike, Ana with a given and a family name.
const ACCOUNTS = [
	{ ...CAST.ownerOfA1, firstName: 'Ana', lastName: 'Example' },
	CAST.ownerOfB2,
	CAST.curator,
	CAST.recipient,
	CAST.spare,
	CAST.outsider,
	CAST.administrator,
].map(({ email, subject, ...names }) => ({ email, id: subject, ...names }));

const grantIdOf = (harness: Harness, name: string): string => seededId(harness.seeded.grants, name);

const byId = <Entry extends { id: unknown }>(entries: readonly Entry[]): readonly Entry[] =>
	entries.toSorted((first, second) => String(first.id).localeCompare(String(second.id)));

const listedOn = (grants: readonly GrantView[], id: string): GrantView => {
	const found = grants.find((grant) => grant.id === id);
	if (found !== undefined) {
		return found;
	}
	throw new Error(`the listing holds no grant ${id}`);
};

// The unrevoked grants on STUDY-A1, by fixture name, with the state each is listed in.
const UNREVOKED: readonly (readonly [string, string])[] = [
	['administratorSelf', GRANT_STATES.accepted],
	['administratorUnmarked', GRANT_STATES.accepted],
	['curatesA1', GRANT_STATES.accepted],
	['cyDeclined', GRANT_STATES.rejected],
	['cyPending', GRANT_STATES.pending],
	['lookalikeExpired', GRANT_STATES.expired],
	['ownsA1', GRANT_STATES.accepted],
];

const withDirectory = async (
	context: Parameters<typeof cleanupFor>[0],
	work: (harness: Harness) => Promise<void>,
): Promise<void> => {
	const directory = await startDirectory({ accounts: ACCOUNTS });
	cleanupFor(context).defer(() => directory.stop());
	await withHarness({ configuration: directory.configuration, fixture: ON_A1 }, work, context);
};

suite('the grants on a resource, in the store', () => {
	test('lists every unrevoked grant on a resource to a platform administrator, its holder with the address the directory holds, its granter by subject', async (context) => {
		await withDirectory(context, async (harness) => {
			const listing = await listResourceGrants(await administratorCaller(harness), STUDY_A1);

			assertSucceeded(listing, "the administrator's listing");
			const grants = listedGrants(listing);
			assert.deepEqual(
				byId(grants.map(({ id, state }) => ({ id, state }))),
				byId(
					UNREVOKED.map(([name, state]) => ({
						id: grantIdOf(harness, name),
						state,
					})),
				),
			);
			assert.deepEqual(
				[
					listedOn(grants, grantIdOf(harness, 'cyPending')).holder,
					listedOn(grants, grantIdOf(harness, 'lookalikeExpired')).holder,
					listedOn(grants, grantIdOf(harness, 'cyPending')).grantedBy,
				],
				[
					{
						email: CAST.recipient.email,
						hasAccount: true,
						subject: CAST.recipient.subject,
					},
					{
						email: undefined,
						hasAccount: false,
						subject: CAST.lookalike.subject,
					},
					{ subject: CAST.ownerOfA1.subject },
				],
			);
			assert.ok(!listing.text.includes(CAST.lookalike.email));
		});
	});

	test("marks a self-grant, and shows each grant's latest decision as recorded, none while pending", async (context) => {
		await withDirectory(context, async (harness) => {
			const grants = listedGrants(await listResourceGrants(await administratorCaller(harness), STUDY_A1));

			assert.deepEqual(
				grants.filter(({ selfGrant }) => selfGrant === true).map(({ id }) => id),
				[grantIdOf(harness, 'administratorSelf')],
			);
			assert.deepEqual(
				[
					listedOn(grants, grantIdOf(harness, 'cyPending')).decision,
					listedOn(grants, grantIdOf(harness, 'cyDeclined')).decision?.decision,
				],
				[undefined, GRANT_STATES.rejected],
			);
		});
	});

	test('lists revoked grants only to a platform administrator asking for them, refusing an owner asking 403 administratorOnly', async (context) => {
		await withDirectory(context, async (harness) => {
			const revoked = grantIdOf(harness, 'spareRevoked');

			const asked = await listResourceGrants(await administratorCaller(harness), STUDY_A1, INCLUDING_REVOKED);
			const ownerAsking = await listResourceGrants(
				await personCaller(harness, CAST.ownerOfA1),
				STUDY_A1,
				INCLUDING_REVOKED,
			);

			assert.deepEqual(listedOn(listedGrants(asked), revoked).state, GRANT_STATES.revoked);
			assertForbidden(ownerAsking, 'the owner asking', 'administratorOnly');
			assert.ok(!ownerAsking.text.includes(revoked));
		});
	});

	test('lists the grants on a resource to its owner, each granter by name alone', async (context) => {
		await withDirectory(context, async (harness) => {
			const listing = await listResourceGrants(await personCaller(harness, CAST.ownerOfA1), STUDY_A1);

			const grants = listedGrants(listing);
			assert.deepEqual(
				grants.map(({ id }) => id).toSorted(),
				UNREVOKED.map(([name]) => grantIdOf(harness, name)).toSorted(),
			);
			assert.deepEqual(
				[
					listedOn(grants, grantIdOf(harness, 'cyPending')).grantedBy,
					listedOn(grants, grantIdOf(harness, 'curatesA1')).grantedBy,
				],
				[{ name: 'Ana Example' }, { name: UNNAMED_SHARER }],
			);
			assert.deepEqual(
				grants.filter(({ granterSubject }) => granterSubject !== undefined),
				[],
			);
		});
	});

	test('answers a principal who may not see a resource as for one that does not exist, and one who may see it without authority 403 noAuthorityOnResource', async (context) => {
		await withDirectory(context, async (harness) => {
			const dana = await personCaller(harness, CAST.ownerOfB2);
			const ana = await personCaller(harness, CAST.ownerOfA1);

			const mayNotSee = [
				[await listResourceGrants(dana, STUDY_A1), dana],
				[await listResourceGrants(ana, RETIRED_STUDY), ana],
			] as const;
			const mayNotAct = [
				await listResourceGrants(await personCaller(harness, CAST.curator), STUDY_A1),
				await listResourceGrants(await personCaller(harness, CAST.outsider), OPEN_STUDY),
			];

			await Promise.all(
				mayNotSee.map(async ([answer, caller], index) => {
					assertNotFound(answer, `unseen ${index + 1}`, 'resourceNotFound');
					assert.deepEqual(
						comparableRefusal(answer),
						comparableRefusal(await listResourceGrants(caller, UNKNOWN_STUDY)),
					);
				}),
			);
			mayNotAct.forEach((answer, index) => {
				assertForbidden(answer, `seen ${index + 1}`, 'noAuthorityOnResource');
			});
		});
	});

	test('answers 503 directoryUnavailable while the configured directory cannot answer', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		await withHarness(
			{ configuration: directory.configuration, fixture: ON_A1 },
			async (harness) => {
				const listing = await listResourceGrants(await personCaller(harness, CAST.ownerOfA1), STUDY_A1);

				assertUnavailable(listing, "the owner's listing", 'directoryUnavailable');
			},
			context,
		);
	});

	test('with no directory configured, names every granter by the fallback and leaves addresses out', async (context) => {
		await withHarness(
			{ fixture: ON_A1 },
			async (harness) => {
				const grants = listedGrants(
					await listResourceGrants(await personCaller(harness, CAST.ownerOfA1), STUDY_A1),
				);

				assert.equal(grants.length, UNREVOKED.length);
				assert.deepEqual(
					grants.map(({ grantedBy, holder }) => ({
						email: holder?.email,
						grantedBy,
						hasAccount: holder?.hasAccount,
					})),
					grants.map(() => ({
						email: undefined,
						grantedBy: { name: UNNAMED_SHARER },
						hasAccount: true,
					})),
				);
			},
			context,
		);
	});
});

suite("a resource's grant summary, in the store", () => {
	test('counts the holders of each role by their accepted, unexpired, unrevoked grants, each holder once, to administrators and owners alone', async (context) => {
		await withDirectory(context, async (harness) => {
			const administrator = await administratorCaller(harness);

			const asAdministrator = await readResource(administrator, STUDY_A1);
			const asOwner = await readResource(await personCaller(harness, CAST.ownerOfA1), STUDY_A1);
			const asHolder = await readResource(await personCaller(harness, CAST.curator), STUDY_A1);
			const unheld = await readResource(administrator, OPEN_STUDY);

			[asAdministrator, asOwner, asHolder, unheld].forEach((answer, index) => {
				assertSucceeded(answer, `read ${index + 1}`);
			});
			[asAdministrator, asOwner].forEach((answer) => {
				assert.deepEqual(resourceView(answer.body).grantSummary, {
					curator: 1,
					owner: 1,
					viewer: 1,
				});
			});
			assert.equal(carriesGrantSummary(asHolder.body), false);
			assert.deepEqual(resourceView(unheld.body).grantSummary, {});
		});
	});
});
