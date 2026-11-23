import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertForbidden,
	assertSucceeded,
	assertUnavailable,
	GRANT_STATES,
	type GrantView,
	INCLUDING_REVOKED,
	listedGrants,
	listOwnGrants,
	nextCursor,
	personCaller,
} from '../../testing/harness/admin.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import {
	answeredInFixture,
	CAST,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	SHOWN,
	STUDY_A1,
	STUDY_B2,
	withdrawCapabilityInStore,
} from '../../testing/fixtures/grants.js';
import { UNNAMED_SHARER } from '../../testing/fixtures/listings.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { seededId, storedCapabilities } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const RETIRED_STUDY = 'STUDY-R9';

const PAST = new Date(Date.now() - 2 * HOUR_MS);

// Cy's grants: on STUDY-A1, from Ana, a viewer grant pending and a submitter grant declined; on
// STUDY-B2, from Dana, a curator grant accepted and a viewer grant accepted and then revoked; and
// on a retired study, from Ana, a viewer grant accepted and since expired. The administrator holds
// a viewer grant from Ana on STUDY-A1, accepted, and one on STUDY-B2, revoked.
const OWN_GRANTS = grantsFixture({
	decisions: [
		answeredInFixture('cyDeclined', 'declined'),
		answeredInFixture('cyCurates'),
		answeredInFixture('cyRevoked'),
		answeredInFixture('cyRetired'),
		answeredInFixture('administratorViews'),
		answeredInFixture('administratorRevoked'),
	],
	grants: {
		administratorRevoked: fixtureGrant('administrator', 'viewer', {
			grantedBy: 'ownerOfB2',
			resource: STUDY_B2,
			revoked: { by: 'ownerOfB2' },
		}),
		administratorViews: fixtureGrant('administrator', 'viewer', {
			grantedBy: 'ownerOfA1',
		}),
		cyCurates: fixtureGrant('recipient', 'curator', {
			grantedBy: 'ownerOfB2',
			resource: STUDY_B2,
		}),
		cyDeclined: fixtureGrant('recipient', 'submitter', {
			category: 'unmarked',
			grantedBy: 'ownerOfA1',
		}),
		cyPending: fixtureGrant('recipient', 'viewer', { grantedBy: 'ownerOfA1' }),
		cyRetired: fixtureGrant('recipient', 'viewer', {
			expiresAt: PAST,
			grantedAt: new Date(PAST.getTime() - HOUR_MS),
			grantedBy: 'ownerOfA1',
			resource: RETIRED_STUDY,
		}),
		cyRevoked: fixtureGrant('recipient', 'viewer', {
			grantedBy: 'ownerOfB2',
			resource: STUDY_B2,
			revoked: { by: 'ownerOfB2' },
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

// The directory's accounts: Ana with a given and a family name, Dana with neither, and Cy and the
// administrator with the stand-in's own.
const ACCOUNTS = [
	{ ...CAST.ownerOfA1, firstName: 'Ana', lastName: 'Example' },
	{ ...CAST.ownerOfB2, firstName: null, lastName: null },
	CAST.recipient,
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

suite("a principal's own grants, in the store", () => {
	test('lists every grant the principal holds, pending and declined ones included, leaving out revoked ones and an expired one on a retired resource', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			const listing = await listOwnGrants(await personCaller(harness, CAST.recipient));

			assertSucceeded(listing, "Cy's own grants");
			assert.equal(nextCursor(listing), undefined);
			assert.deepEqual(
				byId(
					listedGrants(listing).map(({ id, resource, role, state }) => ({
						id,
						resource,
						role,
						state,
					})),
				),
				byId([
					{
						id: grantIdOf(harness, 'cyPending'),
						resource: STUDY_A1,
						role: 'viewer',
						state: GRANT_STATES.pending,
					},
					{
						id: grantIdOf(harness, 'cyDeclined'),
						resource: STUDY_A1,
						role: 'submitter',
						state: GRANT_STATES.declined,
					},
					{
						id: grantIdOf(harness, 'cyCurates'),
						resource: STUDY_B2,
						role: 'curator',
						state: GRANT_STATES.accepted,
					},
				]),
			);
			assert.ok(!listing.text.includes(RETIRED_STUDY));
		});
	});

	test("names each grant's granter by the directory's names alone, and one holding neither name as the fallback, naming no other person otherwise", async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			const listing = await listOwnGrants(await personCaller(harness, CAST.recipient));

			const grants = listedGrants(listing);
			assert.deepEqual(
				[
					listedOn(grants, grantIdOf(harness, 'cyPending')).grantedBy,
					listedOn(grants, grantIdOf(harness, 'cyCurates')).grantedBy,
				],
				[{ name: 'Ana Example' }, { name: UNNAMED_SHARER }],
			);
			assert.deepEqual(
				grants.map(({ holder }) => holder?.subject),
				grants.map(() => CAST.recipient.subject),
			);
			[CAST.ownerOfA1, CAST.ownerOfB2].forEach(({ email, subject }) => {
				assert.ok(!listing.text.includes(subject), 'a granter by subject');
				assert.ok(!listing.text.includes(email), 'a granter by address');
			});
		});
	});

	test('shows with each grant what its role lets its holder use now, and with its answer what was shown then', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			await withdrawCapabilityInStore(harness, 'curator', 'record.delete');
			const narrowed = SHOWN.curator.filter((name) => name !== 'record.delete');

			const listing = await listOwnGrants(await personCaller(harness, CAST.recipient));

			const curates = listedOn(listedGrants(listing), grantIdOf(harness, 'cyCurates'));
			assert.deepEqual(
				(curates.capabilities ?? []).map(({ description, displayName, name }) => ({
					description,
					displayName,
					name,
				})),
				await storedCapabilities(harness.clients.migration, narrowed),
			);
			const shown = curates.decision?.capabilities;
			assert.deepEqual(Array.isArray(shown) ? shown.map(String).toSorted() : shown, SHOWN.curator);
		});
	});

	test("refuses revoked grants to anyone but a platform administrator 403 administratorOnly, and lists a platform administrator's own when asked", async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			const administrator = await administratorCaller(harness);

			const asking = await listOwnGrants(await personCaller(harness, CAST.recipient), INCLUDING_REVOKED);
			const notAsked = await listOwnGrants(administrator);
			const asked = await listOwnGrants(administrator, INCLUDING_REVOKED);

			assertForbidden(asking, "Cy's asking", 'administratorOnly');
			assert.ok(!asking.text.includes(grantIdOf(harness, 'cyRevoked')));
			assert.deepEqual(
				listedGrants(notAsked).map(({ id }) => id),
				[grantIdOf(harness, 'administratorViews')],
			);
			assert.deepEqual(
				byId(listedGrants(asked).map(({ id, state }) => ({ id, state }))),
				byId([
					{
						id: grantIdOf(harness, 'administratorViews'),
						state: GRANT_STATES.accepted,
					},
					{
						id: grantIdOf(harness, 'administratorRevoked'),
						state: GRANT_STATES.revoked,
					},
				]),
			);
		});
	});

	test('lists none to a principal holding nothing, even while the directory cannot answer', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			const listing = await listOwnGrants(await personCaller(harness, CAST.outsider));

			assertSucceeded(listing, "the outsider's own grants");
			assert.deepEqual(listedGrants(listing), []);
			assert.deepEqual(directory.lookups(), []);
		});
	});

	test('answers 503 directoryUnavailable while the configured directory cannot answer, naming neither its secret nor its host', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		await withHarness({ configuration: directory.configuration, fixture: OWN_GRANTS }, async (harness) => {
			const listing = await listOwnGrants(await personCaller(harness, CAST.recipient));

			assertUnavailable(listing, "Cy's own grants", 'directoryUnavailable');
			const { host } = new URL(directory.configuration.directoryUrl);
			[directory.configuration.directoryClientSecret, host].forEach((withheld) => {
				assert.equal(listing.text.includes(withheld), false);
			});
		});
	});

	test('with no directory configured, names every granter by the fallback, leaves addresses out, and counts the holder as holding an account', async (context) => {
		await withHarness(
			{ fixture: OWN_GRANTS },
			async (harness) => {
				const listing = await listOwnGrants(await personCaller(harness, CAST.recipient));

				assertSucceeded(listing, "Cy's own grants");
				const grants = listedGrants(listing);
				assert.equal(grants.length, 3);
				assert.deepEqual(
					grants.map(({ grantedBy, holder }) => ({ grantedBy, holder })),
					grants.map(() => ({
						grantedBy: { name: UNNAMED_SHARER },
						holder: {
							email: undefined,
							hasAccount: true,
							subject: CAST.recipient.subject,
						},
					})),
				);
			},
			context,
		);
	});
});
