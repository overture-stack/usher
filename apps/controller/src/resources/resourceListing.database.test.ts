import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertSucceeded,
	assertUnavailable,
	comparableSuccess,
	GRANT_STATES,
	holderOf,
	LISTING_QUERY,
	listedExternalIds,
	listedResource,
	listedResources,
	listResources,
	nextCursor,
	personCaller,
} from '../../testing/harness/admin.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import {
	answeredInFixture,
	CAST,
	fixtureGrant,
	grantsFixture,
	OPEN_STUDY,
	REGISTERED_STUDY,
	STUDY_A1,
	STUDY_B2,
} from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { seededId } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const STUDY_E5 = 'STUDY-E5';

const STUDY_F6 = 'STUDY-F6';

// Beside the fixture's own: Ana owns STUDY-E5 and STUDY-F6 too, each accepted, and her owner grant
// on STUDY-D4 awaits her answer; Cy declined an owner grant on STUDY-C3 and holds a pending
// submitter grant on STUDY-A1; the lookalike holds an accepted viewer grant there, their account
// since deleted from the directory; and the spare person's viewer grant there is revoked.
const LISTED = grantsFixture({
	decisions: [
		answeredInFixture('anaOwnsE5'),
		answeredInFixture('anaOwnsF6'),
		answeredInFixture('cyDeclinesC3', 'declined'),
		answeredInFixture('lookalikeViews'),
		answeredInFixture('spareRevoked'),
	],
	grants: {
		anaAwaitsD4: fixtureGrant('ownerOfA1', 'owner', {
			category: null,
			resource: REGISTERED_STUDY,
		}),
		anaOwnsE5: fixtureGrant('ownerOfA1', 'owner', {
			category: null,
			resource: STUDY_E5,
		}),
		anaOwnsF6: fixtureGrant('ownerOfA1', 'owner', {
			category: null,
			resource: STUDY_F6,
		}),
		cyDeclinesC3: fixtureGrant('recipient', 'owner', {
			category: null,
			resource: OPEN_STUDY,
		}),
		cySubmits: fixtureGrant('recipient', 'submitter', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
		}),
		lookalikeViews: fixtureGrant('lookalike', 'viewer', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
		}),
		spareRevoked: fixtureGrant('spare', 'viewer', {
			grantedBy: 'ownerOfA1',
			revoked: { by: 'ownerOfA1' },
		}),
	},
	resources: {
		[STUDY_E5]: { baseTier: 'grant', name: 'Sleep Study' },
		[STUDY_F6]: { baseTier: 'grant', name: 'Gait Study' },
	},
});

// Every person the fixture seeds but the lookalike.
const ACCOUNTS = [CAST.ownerOfA1, CAST.ownerOfB2, CAST.curator, CAST.recipient, CAST.spare, CAST.outsider].map(
	({ email, subject }) => ({ email, id: subject }),
);

const grantIdOf = (harness: Harness, name: string): string => seededId(harness.seeded.grants, name);

const withDirectory = async (
	context: Parameters<typeof cleanupFor>[0],
	work: (harness: Harness, directory: Awaited<ReturnType<typeof startDirectory>>) => Promise<void>,
): Promise<void> => {
	const directory = await startDirectory({ accounts: ACCOUNTS });
	cleanupFor(context).defer(() => directory.stop());
	await withHarness(
		{ configuration: directory.configuration, fixture: LISTED },
		(harness) => work(harness, directory),
		context,
	);
};

suite('the resource listing for an owner, in the store', () => {
	test('lists a counted owner the resources they own alone, each with its grant summary and no grants', async (context) => {
		await withDirectory(context, async (harness) => {
			const ana = await listResources(await personCaller(harness, CAST.ownerOfA1));
			const dana = await listResources(await personCaller(harness, CAST.ownerOfB2));

			assert.deepEqual(listedExternalIds(ana), [STUDY_A1, STUDY_E5, STUDY_F6]);
			assert.deepEqual(listedExternalIds(dana), [STUDY_B2]);
			assert.deepEqual(listedResource(ana, STUDY_A1).grantSummary, {
				curator: 1,
				owner: 1,
				viewer: 1,
			});
			assert.deepEqual(
				listedResources(ana).map(({ grants }) => grants),
				[undefined, undefined, undefined],
			);
		});
	});

	test("pages an owner's resources in the order of their externalIds", async (context) => {
		await withDirectory(context, async (harness) => {
			const ana = await personCaller(harness, CAST.ownerOfA1);

			const first = await listResources(ana, {
				query: { [LISTING_QUERY.limit]: '2' },
			});
			const cursor = nextCursor(first);
			const second = await listResources(ana, {
				query: {
					[LISTING_QUERY.cursor]: cursor ?? '',
					[LISTING_QUERY.limit]: '2',
				},
			});

			assert.deepEqual(listedExternalIds(first), [STUDY_A1, STUDY_E5]);
			assert.notEqual(cursor, undefined);
			assert.deepEqual(listedExternalIds(second), [STUDY_F6]);
			assert.equal(nextCursor(second), undefined);
		});
	});

	test('answers alike every principal who is a counted owner of nothing, whatever else they hold', async (context) => {
		await withDirectory(context, async (harness) => {
			const answers = await Promise.all(
				[CAST.recipient, CAST.curator, CAST.outsider].map(async (person) =>
					listResources(await personCaller(harness, person)),
				),
			);
			const owner = await listResources(await personCaller(harness, CAST.ownerOfB2));

			answers.forEach((answer, index) => {
				assertSucceeded(answer, `listing ${index + 1}`);
				assert.deepEqual(answer.body, { next: null, resources: [] });
			});
			const [first, ...rest] = answers.map(comparableSuccess);
			rest.forEach((answer) => {
				assert.deepEqual(answer, first);
			});
			assert.deepEqual(listedExternalIds(owner), [STUDY_B2]);
		});
	});

	test("answers an owner's listing alike whether or not the directory can answer, since it names nobody", async (context) => {
		await withDirectory(context, async (harness, directory) => {
			const ana = await personCaller(harness, CAST.ownerOfA1);

			const answering = await listResources(ana);
			directory.failLookupsFrom(1);
			const failing = await listResources(ana);

			assertSucceeded(failing, "Ana's listing");
			assert.deepEqual(listedExternalIds(failing), [STUDY_A1, STUDY_E5, STUDY_F6]);
			assert.deepEqual(failing.body, answering.body);
		});
	});
});

suite('the resource listing for an administrator, in the store', () => {
	test('lists every resource with its unrevoked grants, each holder with the address the directory holds, and one it no longer holds as holding no account', async (context) => {
		await withDirectory(context, async (harness) => {
			const listing = await listResources(await administratorCaller(harness));

			assert.deepEqual(listedExternalIds(listing), [
				STUDY_A1,
				STUDY_B2,
				OPEN_STUDY,
				REGISTERED_STUDY,
				STUDY_E5,
				STUDY_F6,
			]);
			const onA1 = listedResource(listing, STUDY_A1).grants ?? [];
			assert.deepEqual(
				onA1.map(({ id }) => id).toSorted(),
				['curatesA1', 'cySubmits', 'lookalikeViews', 'ownsA1']
					.map((name) => grantIdOf(harness, name))
					.toSorted(),
			);
			const holders = Object.fromEntries(onA1.map((grant) => [String(grant.id), holderOf(grant)]));
			assert.deepEqual(
				[holders[grantIdOf(harness, 'cySubmits')], holders[grantIdOf(harness, 'lookalikeViews')]],
				[
					{
						email: CAST.recipient.email,
						noAccount: false,
						subject: CAST.recipient.subject,
					},
					{
						email: undefined,
						noAccount: true,
						subject: CAST.lookalike.subject,
					},
				],
			);
			assert.deepEqual(
				onA1
					.filter(({ id }) => id === grantIdOf(harness, 'cySubmits'))
					.map(({ grantedBy, role, state }) => ({ grantedBy, role, state })),
				[
					{
						grantedBy: { subject: CAST.ownerOfA1.subject },
						role: 'submitter',
						state: GRANT_STATES.pending,
					},
				],
			);
			assert.deepEqual(
				(listedResource(listing, OPEN_STUDY).grants ?? []).map(({ state }) => state),
				[GRANT_STATES.declined],
			);
			assert.ok(!listing.text.includes(CAST.lookalike.email));
		});
	});

	test('answers 503 directoryUnavailable while the directory cannot answer, and with none configured lists each holder with an account and no address', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		const failing = await withHarness(
			{ configuration: directory.configuration, fixture: LISTED },
			async (harness) => listResources(await administratorCaller(harness)),
			context,
		);
		const unconfigured = await withHarness(
			{ fixture: LISTED },
			async (harness) => listResources(await administratorCaller(harness)),
			context,
		);

		assertUnavailable(failing, "the administrator's listing", 'directoryUnavailable');
		assertSucceeded(unconfigured, 'the listing with no directory');
		const holders = listedResources(unconfigured).flatMap(({ grants }) => (grants ?? []).map(holderOf));
		assert.ok(holders.length > 0);
		assert.deepEqual(
			holders.map(({ email, noAccount }) => ({ email, noAccount })),
			holders.map(() => ({ email: undefined, noAccount: false })),
		);
	});
});
