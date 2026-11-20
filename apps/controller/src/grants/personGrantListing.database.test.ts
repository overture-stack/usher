import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertForbidden,
	assertNotFound,
	assertProblemSays,
	assertSucceeded,
	assertUnavailable,
	comparableSuccess,
	GRANT_STATES,
	INCLUDING_REVOKED,
	listedGrants,
	listPersonGrants,
	personCaller,
} from '../../testing/harness/admin.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import { answeredInFixture, CAST, fixtureGrant, grantsFixture, STUDY_B2 } from '../../testing/fixtures/grants.js';
import { UNNAMED_SHARER } from '../../testing/fixtures/listings.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { seededId } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const NOBODY = 'nobody@example.org';

// Cy's grants: a viewer grant on STUDY-A1 from Ana, accepted, and one there revoked; and a curator
// grant on STUDY-B2 from Dana, pending.
const CY_GRANTS = grantsFixture({
	decisions: [answeredInFixture('cyViewsA1'), answeredInFixture('cyRevoked')],
	grants: {
		cyCuratesB2: fixtureGrant('recipient', 'curator', {
			grantedBy: 'ownerOfB2',
			resource: STUDY_B2,
		}),
		cyRevoked: fixtureGrant('recipient', 'submitter', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
			revoked: { by: 'ownerOfA1' },
		}),
		cyViewsA1: fixtureGrant('recipient', 'viewer', { grantedBy: 'ownerOfA1' }),
	},
});

// Every person the fixture seeds, Ana with a given and a family name and Dana with neither.
const ACCOUNTS = [
	{ ...CAST.ownerOfA1, firstName: 'Ana', lastName: 'Example' },
	{ ...CAST.ownerOfB2, firstName: null, lastName: null },
	CAST.curator,
	CAST.recipient,
	CAST.outsider,
].map(({ email, subject, ...names }) => ({ email, id: subject, ...names }));

const grantIdOf = (harness: Harness, name: string): string => seededId(harness.seeded.grants, name);

const listedIds = (answer: Parameters<typeof listedGrants>[0]): readonly unknown[] =>
	listedGrants(answer)
		.map(({ id }) => id)
		.toSorted();

const withDirectory = async (
	context: Parameters<typeof cleanupFor>[0],
	work: (harness: Harness, directory: Awaited<ReturnType<typeof startDirectory>>) => Promise<void>,
): Promise<void> => {
	const directory = await startDirectory({ accounts: ACCOUNTS });
	cleanupFor(context).defer(() => directory.stop());
	await withHarness(
		{ configuration: directory.configuration, fixture: CY_GRANTS },
		(harness) => work(harness, directory),
		context,
	);
};

suite("a person's grants, in the store", () => {
	test('lists to a platform administrator every unrevoked grant of the person holding an address, sent in any letter case, each granter by subject', async (context) => {
		await withDirectory(context, async (harness) => {
			const listing = await listPersonGrants(
				await administratorCaller(harness),
				CAST.recipient.email.toUpperCase(),
			);

			assertSucceeded(listing, "the administrator's listing");
			assert.deepEqual(
				listedIds(listing),
				[grantIdOf(harness, 'cyCuratesB2'), grantIdOf(harness, 'cyViewsA1')].toSorted(),
			);
			assert.deepEqual(
				listedGrants(listing)
					.map(({ grantedBy }) => grantedBy)
					.toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
				[CAST.ownerOfA1.subject, CAST.ownerOfB2.subject]
					.map((subject) => ({ subject }))
					.toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
			);
		});
	});

	test('refuses a platform administrator an address no single account holds 404 holderNotFound, a partial one among them, and lists none for an account holding nothing', async (context) => {
		await withDirectory(context, async (harness) => {
			const administrator = await administratorCaller(harness);

			const nobody = await listPersonGrants(administrator, NOBODY);
			const partial = await listPersonGrants(administrator, 'cy@example');
			const holdsNothing = await listPersonGrants(administrator, CAST.outsider.email);

			assertNotFound(nobody, 'an address nobody holds', 'holderNotFound');
			assertNotFound(partial, 'a partial address', 'holderNotFound');
			assertSucceeded(holdsNothing, 'an account holding nothing');
			assert.deepEqual(listedGrants(holdsNothing), []);
		});
	});

	test('lists to an owner only the grants on resources they own, each granter by name, answering alike an address nobody holds, one holding nothing and one holding grants elsewhere', async (context) => {
		await withDirectory(context, async (harness) => {
			const ana = await personCaller(harness, CAST.ownerOfA1);
			const dana = await personCaller(harness, CAST.ownerOfB2);

			const toAna = await listPersonGrants(ana, CAST.recipient.email);
			const toDana = await listPersonGrants(dana, CAST.recipient.email);
			const unseen = [
				await listPersonGrants(ana, NOBODY),
				await listPersonGrants(ana, CAST.outsider.email),
				await listPersonGrants(ana, CAST.ownerOfB2.email),
			];

			assert.deepEqual(listedIds(toAna), [grantIdOf(harness, 'cyViewsA1')]);
			assert.deepEqual(listedIds(toDana), [grantIdOf(harness, 'cyCuratesB2')]);
			assert.deepEqual(
				[...listedGrants(toAna), ...listedGrants(toDana)].map(({ grantedBy }) => grantedBy),
				[{ name: 'Ana Example' }, { name: UNNAMED_SHARER }],
			);
			unseen.forEach((answer, index) => {
				assertSucceeded(answer, `unseen ${index + 1}`);
				assert.deepEqual(listedGrants(answer), []);
			});
			const [first, ...rest] = unseen.map(comparableSuccess);
			rest.forEach((answer) => {
				assert.deepEqual(answer, first);
			});
		});
	});

	test('answers a principal neither administering nor owning anything alike whatever the address, asking the directory nothing', async (context) => {
		await withDirectory(context, async (harness, directory) => {
			const curator = await personCaller(harness, CAST.curator);
			const before = directory.lookups().length;

			const held = await listPersonGrants(curator, CAST.recipient.email);
			const unheld = await listPersonGrants(curator, NOBODY);

			[held, unheld].forEach((answer) => {
				assertSucceeded(answer, "the curator's listing");
				assert.deepEqual(listedGrants(answer), []);
			});
			assert.deepEqual(comparableSuccess(held), comparableSuccess(unheld));
			assert.equal(directory.lookups().length, before);
		});
	});

	test("lists a person's revoked grants only to a platform administrator asking for them, refusing an owner asking 403 administratorOnly", async (context) => {
		await withDirectory(context, async (harness) => {
			const revoked = grantIdOf(harness, 'cyRevoked');

			const asked = await listPersonGrants(
				await administratorCaller(harness),
				CAST.recipient.email,
				INCLUDING_REVOKED,
			);
			const ownerAsking = await listPersonGrants(
				await personCaller(harness, CAST.ownerOfA1),
				CAST.recipient.email,
				INCLUDING_REVOKED,
			);

			assert.deepEqual(
				listedGrants(asked)
					.filter(({ id }) => id === revoked)
					.map(({ state }) => state),
				[GRANT_STATES.revoked],
			);
			assertForbidden(ownerAsking, 'the owner asking', 'administratorOnly');
			assert.ok(!ownerAsking.text.includes(revoked));
		});
	});

	test("answers 503 directoryUnavailable while the configured directory cannot answer, telling the caller to try again, and 503 directoryNotConfigured with none configured and no Retry-After, telling the caller to list a resource's grants", async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		const failing = await withHarness(
			{ configuration: directory.configuration, fixture: CY_GRANTS },
			async (harness) => listPersonGrants(await administratorCaller(harness), CAST.recipient.email),
			context,
		);
		const unconfigured = await withHarness(
			{ fixture: CY_GRANTS },
			async (harness) => listPersonGrants(await personCaller(harness, CAST.ownerOfA1), CAST.recipient.email),
			context,
		);

		assertUnavailable(failing, 'the failing listing', 'directoryUnavailable');
		assertProblemSays(failing, /Try again later\.$/u, 'the failing listing');
		assert.doesNotMatch(
			failing.problem?.detail ?? '',
			/\/admin\/resources\//u,
			'the failing listing offers no listing that needs the directory too',
		);
		assertUnavailable(unconfigured, 'the unconfigured listing', 'directoryNotConfigured');
		assert.equal(unconfigured.headers.get('retry-after'), null, 'the unconfigured listing names no retry');
		assertProblemSays(unconfigured, /GET \/admin\/resources\/\{externalId\}\/grants/u, 'the unconfigured listing');
	});
});
