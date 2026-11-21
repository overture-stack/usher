import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	assertForbidden,
	assertNotFound,
	comparableSuccess,
	GRANT_STATES,
	type GrantView,
	INCLUDING_REVOKED,
	listedGrants,
	listOwnGrants,
	listPersonGrants,
	PROBLEMS,
} from '../../../testing/harness/admin.js';
import {
	CAST,
	CAST_NAMES,
	CATEGORIES,
	expiryOf,
	fileRealm,
	grantIdOf,
	HAL_NAME,
	listingPolicy,
	NOBODY_ADDRESS,
	seededGrant,
	STUDIES,
	SUBMITTER_CAPABILITIES,
	suiteWorld,
	UNNAMED_SHARER,
	wholeSecondNow,
} from '../../../testing/fixtures/listings.js';
import { storedCapabilities } from '../../../testing/harness/policy.js';

const realm = fileRealm();

const grantIds = (response: AdminResponse): readonly unknown[] =>
	listedGrants(response)
		.map(({ id }) => id)
		.toSorted();

const ownGrantOn = (response: AdminResponse, externalId: string): GrantView => {
	const found = listedGrants(response).find(({ resource }) => resource === externalId);
	if (found !== undefined) {
		return found;
	}
	throw new Error(`the caller's own grants hold none on ${externalId}`);
};

suite("listing a person's grants", () => {
	const world = suiteWorld(realm, (started) => ({
		policy: listingPolicy(started, wholeSecondNow()),
	}));

	test('lists every grant a person holds across resources, found by exact address', async () => {
		const given = await world();

		const listing = await listPersonGrants(await given.caller('administrator'), CAST.bo);

		assert.deepEqual(
			listedGrants(listing)
				.map(({ id, resource, role, state }) => ({ id, resource, role, state }))
				.toSorted((first, second) => String(first.resource).localeCompare(String(second.resource))),
			[
				{
					id: grantIdOf(given, 'a1Bo'),
					resource: STUDIES.a1,
					role: 'submitter',
					state: GRANT_STATES.accepted,
				},
				{
					id: grantIdOf(given, 'b2Bo'),
					resource: STUDIES.b2,
					role: 'submitter',
					state: GRANT_STATES.pending,
				},
			],
		);
	});

	test('finds a person only by their exact address, in any letter case', async () => {
		const given = await world();
		const administrator = await given.caller('administrator');

		const partial = await listPersonGrants(administrator, 'sub.bo@example');
		const wildcard = await listPersonGrants(administrator, 's*@example.org');
		const otherCase = await listPersonGrants(administrator, CAST.bo.toUpperCase());

		assertNotFound(partial, 'a partial address', 'holderNotFound');
		assertNotFound(wildcard, 'a wildcard', 'holderNotFound');
		assert.deepEqual(grantIds(otherCase), [grantIdOf(given, 'a1Bo'), grantIdOf(given, 'b2Bo')].toSorted());
	});

	test('lists a person holding nothing as holding none', async () => {
		const given = await world();
		const administrator = await given.caller('administrator');

		const holdsNothing = await listPersonGrants(administrator, CAST.holdsNothing);
		const holdsSome = await listPersonGrants(administrator, CAST.bo);

		assert.deepEqual(listedGrants(holdsNothing), []);
		assert.ok(listedGrants(holdsSome).length > 0);
	});

	test("lists a person's grants to an owner only on resources that owner manages", async () => {
		const given = await world();

		const toAna = await listPersonGrants(await given.caller('ana'), CAST.bo);
		const toHal = await listPersonGrants(await given.caller('hal'), CAST.bo);

		assert.deepEqual(grantIds(toAna), [grantIdOf(given, 'a1Bo')]);
		assert.deepEqual(grantIds(toHal), [grantIdOf(given, 'b2Bo')]);
	});

	test('answers a caller without authority the same way whatever the address', async () => {
		const given = await world();
		const outsider = await given.caller('outsider');
		const administrator = await given.caller('administrator');

		const held = await listPersonGrants(outsider, CAST.bo);
		const unheld = await listPersonGrants(outsider, NOBODY_ADDRESS);
		const heldToAdministrator = await listPersonGrants(administrator, CAST.bo);
		const unheldToAdministrator = await listPersonGrants(administrator, NOBODY_ADDRESS);

		assert.deepEqual(comparableSuccess(held), comparableSuccess(unheld));
		[held, unheld].forEach((answer) => {
			assert.notEqual(answer.problem?.code, PROBLEMS.holderNotFound.code);
		});
		[STUDIES.a1, STUDIES.b2].forEach((externalId) => {
			assert.ok(!held.text.includes(externalId), `the answer names ${externalId}`);
		});
		assert.notDeepEqual(comparableSuccess(heldToAdministrator), comparableSuccess(unheldToAdministrator));
	});

	test('answers an owner the same way for an address no account holds as for an account holding nothing on their resources', async () => {
		const given = await world();
		const owner = await given.caller('ana');

		const noAccount = await listPersonGrants(owner, NOBODY_ADDRESS);
		const holdsNothing = await listPersonGrants(owner, CAST.holdsNothing);
		const holdsElsewhere = await listPersonGrants(owner, CAST.hal);
		const holdsSome = await listPersonGrants(owner, CAST.bo);

		assert.deepEqual(comparableSuccess(noAccount), comparableSuccess(holdsNothing));
		assert.deepEqual(comparableSuccess(noAccount), comparableSuccess(holdsElsewhere));
		[noAccount, holdsNothing, holdsElsewhere].forEach((answer) => {
			assert.notEqual(answer.problem?.code, PROBLEMS.holderNotFound.code);
		});
		assert.deepEqual(grantIds(holdsSome), [grantIdOf(given, 'a1Bo')]);
	});

	test("shows a person's revoked grants only to an administrator who asks for them", async () => {
		const given = await world();
		const administrator = await given.caller('administrator');
		const owner = await given.caller('ana');
		const eve = grantIdOf(given, 'a1Eve');

		const administratorAsking = await listPersonGrants(administrator, CAST.eve, INCLUDING_REVOKED);
		const administratorNotAsking = await listPersonGrants(administrator, CAST.eve);
		const ownerAsking = await listPersonGrants(owner, CAST.eve, INCLUDING_REVOKED);
		const ownerNotAsking = await listPersonGrants(owner, CAST.eve);

		assert.deepEqual(
			listedGrants(administratorAsking).map(({ id, state }) => ({ id, state })),
			[{ id: eve, state: GRANT_STATES.revoked }],
		);
		assert.deepEqual(listedGrants(administratorNotAsking), []);
		assert.deepEqual(listedGrants(ownerNotAsking), []);
		assertForbidden(ownerAsking, 'the owner asking', 'administratorOnly');
		assert.ok(!ownerAsking.text.includes(eve));
	});
});

suite('listing my own grants', () => {
	const world = suiteWorld(realm, (started) => ({
		policy: listingPolicy(started, wholeSecondNow()),
	}));

	test("lists the caller's own grants, pending ones included", async () => {
		const given = await world();

		const listing = await listOwnGrants(await given.caller('bo'));

		assert.deepEqual(
			listedGrants(listing)
				.map(({ category, expiresAt, resource, state }) => ({
					category,
					expiresAt: expiryOf(expiresAt),
					resource,
					state,
				}))
				.toSorted((first, second) => String(first.resource).localeCompare(String(second.resource))),
			[
				{
					category: CATEGORIES.unmarked,
					expiresAt: undefined,
					resource: STUDIES.a1,
					state: GRANT_STATES.accepted,
				},
				{
					category: CATEGORIES.unmarked,
					expiresAt: seededGrant(given, 'b2Bo').expiresAt?.getTime(),
					resource: STUDIES.b2,
					state: GRANT_STATES.pending,
				},
			],
		);
	});

	test('shows what each grant would let the caller do', async () => {
		const given = await world();

		const listing = await listOwnGrants(await given.caller('bo'));

		const stored = await storedCapabilities(given.harness.clients.migration, SUBMITTER_CAPABILITIES);

		const capabilities = ownGrantOn(listing, STUDIES.b2).capabilities ?? [];
		assert.deepEqual(
			capabilities
				.map(({ description, displayName, name }) => ({
					description: description ?? null,
					displayName,
					name,
				}))
				.toSorted((first, second) => String(first.name).localeCompare(String(second.name))),
			stored,
		);
		assert.deepEqual(
			stored.map(({ name }) => name),
			SUBMITTER_CAPABILITIES,
		);
	});

	test('names who shared each grant by name alone', async () => {
		const given = await world();

		const listing = await listOwnGrants(await given.caller('bo'));

		assert.deepEqual(ownGrantOn(listing, STUDIES.b2).grantedBy, {
			name: HAL_NAME,
		});
		assert.deepEqual(ownGrantOn(listing, STUDIES.a1).grantedBy, {
			name: UNNAMED_SHARER,
		});
		[CAST.hal, CAST.quinn, given.realm.subject('hal'), given.realm.subject('quinn')].forEach((sharer) => {
			assert.ok(!listing.text.includes(sharer), 'the listing names a sharer otherwise');
		});
	});

	test('names only the categories the caller holds', async () => {
		const given = await world();

		const listing = await listOwnGrants(await given.caller('bo'));

		assert.ok(listing.text.includes(CATEGORIES.unmarked));
		assert.ok(!listing.text.includes(CATEGORIES.controlled));
	});

	test("shows no other holder of the caller's resources", async () => {
		const given = await world();

		const listing = await listOwnGrants(await given.caller('bo'));

		assert.deepEqual(
			listedGrants(listing)
				.map(({ resource }) => resource)
				.toSorted(),
			[STUDIES.a1, STUDIES.b2],
		);
		CAST_NAMES.filter((name) => name !== 'bo').forEach((name) => {
			assert.ok(!listing.text.includes(given.realm.subject(name)), `the listing names ${name}'s subject`);
			assert.ok(!listing.text.includes(CAST[name]), `the listing names ${name}'s address`);
		});
	});

	test("lists none of the caller's own revoked grants", async () => {
		const given = await world();
		const eve = await given.caller('eve');

		const notAsking = await listOwnGrants(eve);
		const asking = await listOwnGrants(eve, INCLUDING_REVOKED);
		const declined = await listOwnGrants(await given.caller('dee'));

		assert.deepEqual(listedGrants(notAsking), []);
		assertForbidden(asking, 'Eve asking', 'administratorOnly');
		assert.ok(!asking.text.includes(grantIdOf(given, 'a1Eve')));
		assert.deepEqual(
			listedGrants(declined).map(({ resource, state }) => ({
				resource,
				state,
			})),
			[{ resource: STUDIES.a1, state: GRANT_STATES.declined }],
		);
	});

	test('lists the own grants of any signed-in caller, an empty list for one holding nothing', async () => {
		const given = await world();

		const outsider = await listOwnGrants(await given.caller('outsider'));
		const administrator = await listOwnGrants(await given.caller('administrator'));
		const gil = await listOwnGrants(await given.caller('gil'));

		const facts = (response: AdminResponse): readonly unknown[] =>
			listedGrants(response).map(({ category, resource, role }) => ({
				category,
				resource,
				role,
			}));
		assert.deepEqual(facts(outsider), []);
		assert.deepEqual(facts(administrator), [
			{ category: CATEGORIES.controlled, resource: STUDIES.a1, role: 'viewer' },
		]);
		assert.deepEqual(facts(gil), [{ category: CATEGORIES.controlled, resource: STUDIES.a1, role: 'viewer' }]);
	});
});
