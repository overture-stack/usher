import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	assertForbidden,
	assertNotFound,
	assertSucceeded,
	carriesGrantSummary,
	comparableRefusal,
	GRANT_STATES,
	INCLUDING_REVOKED,
	instantOf,
	listedGrants,
	listResourceGrants,
	readResource,
	resourceView,
	rolesHeld,
} from '../../../testing/harness/admin.js';
import {
	ANA_NAME,
	BO_SHOWN_CAPABILITIES,
	byId,
	CAST,
	type CastName,
	fileRealm,
	grantFacts,
	grantIdOf,
	granterSubjectOf,
	INVITEE_ADDRESS,
	invitedPolicy,
	isNamed,
	latestDecisionOf,
	listedGrant,
	listingPolicy,
	MISSING_STUDY,
	seededGrant,
	seededGrantFacts,
	startListingWorld,
	STUDIES,
	suiteWorld,
	UNNAMED_SHARER,
	wholeSecondNow,
} from '../../../testing/fixtures/listings.js';
import { cleanupFor } from '../../../testing/harness/waiting.js';

const realm = fileRealm();

const UNREVOKED_ON_A1: readonly (readonly [string, string])[] = Object.freeze([
	['a1Bo', GRANT_STATES.accepted],
	['a1Cy', GRANT_STATES.pending],
	['a1Dee', GRANT_STATES.declined],
	['a1Fay', GRANT_STATES.expired],
	['a1Gil', GRANT_STATES.accepted],
	['a1Owner', GRANT_STATES.accepted],
	['a1Self', GRANT_STATES.accepted],
]);

suite('listing the grants on a resource', () => {
	const world = suiteWorld(realm, (started) => ({
		policy: listingPolicy(started, wholeSecondNow()),
	}));

	test('lists every grant on a resource with holder, category, role, expiry and state', async () => {
		const given = await world();

		const listing = await listResourceGrants(await given.caller('administrator'), STUDIES.a1);

		assert.deepEqual(
			byId(listedGrants(listing).map(grantFacts)),
			byId(UNREVOKED_ON_A1.map(([name, state]) => seededGrantFacts(given, name, state))),
		);
	});

	test("states each grant's acceptance from its latest decision", async () => {
		const given = await world();

		const grants = listedGrants(await listResourceGrants(await given.caller('administrator'), STUDIES.a1));

		const bo = listedGrant(grants, given, 'a1Bo');
		const cy = listedGrant(grants, given, 'a1Cy');
		const dee = listedGrant(grants, given, 'a1Dee');
		assert.deepEqual(
			{
				capabilities: bo.decision?.capabilities,
				decidedAt: instantOf(bo.decision?.decidedAt),
				decision: bo.decision?.decision,
				state: bo.state,
			},
			{
				capabilities: BO_SHOWN_CAPABILITIES,
				decidedAt: latestDecisionOf(given, 'a1Bo').decidedAt?.getTime(),
				decision: GRANT_STATES.accepted,
				state: GRANT_STATES.accepted,
			},
		);
		assert.deepEqual(
			{ decision: cy.decision, state: cy.state },
			{ decision: undefined, state: GRANT_STATES.pending },
		);
		assert.deepEqual(
			{
				decidedAt: instantOf(dee.decision?.decidedAt),
				decision: dee.decision?.decision,
				state: dee.state,
			},
			{
				decidedAt: latestDecisionOf(given, 'a1Dee').decidedAt?.getTime(),
				decision: GRANT_STATES.declined,
				state: GRANT_STATES.declined,
			},
		);
	});

	test('states expiry and revocation from the grant', async () => {
		const given = await world();

		const grants = listedGrants(
			await listResourceGrants(await given.caller('administrator'), STUDIES.a1, INCLUDING_REVOKED),
		);

		const fay = listedGrant(grants, given, 'a1Fay');
		const eve = listedGrant(grants, given, 'a1Eve');
		assert.deepEqual(
			{ expiresAt: instantOf(fay.expiresAt), state: fay.state },
			{
				expiresAt: seededGrant(given, 'a1Fay').expiresAt?.getTime(),
				state: GRANT_STATES.expired,
			},
		);
		assert.deepEqual(
			{ revokedAt: instantOf(eve.revokedAt), state: eve.state },
			{
				revokedAt: seededGrant(given, 'a1Eve').revoked?.at?.getTime(),
				state: GRANT_STATES.revoked,
			},
		);
	});

	test('shows revoked grants only to an administrator who asks for them', async () => {
		const given = await world();
		const administrator = await given.caller('administrator');
		const owner = await given.caller('ana');
		const eve = grantIdOf(given, 'a1Eve');

		const administratorAsking = await listResourceGrants(administrator, STUDIES.a1, INCLUDING_REVOKED);
		const administratorNotAsking = await listResourceGrants(administrator, STUDIES.a1);
		const ownerAsking = await listResourceGrants(owner, STUDIES.a1, INCLUDING_REVOKED);
		const ownerNotAsking = await listResourceGrants(owner, STUDIES.a1);

		const ids = (answer: AdminResponse): readonly unknown[] => listedGrants(answer).map(({ id }) => id);
		assert.ok(ids(administratorAsking).includes(eve));
		assert.ok(!ids(administratorNotAsking).includes(eve));
		assert.ok(!ids(ownerNotAsking).includes(eve));
		assert.ok(ids(ownerNotAsking).includes(grantIdOf(given, 'a1Bo')));
		assertForbidden(ownerAsking, 'the owner asking', 'administratorOnly');
		assert.ok(!ownerAsking.text.includes(eve));
	});

	test('marks a self-grant with its expiry', async () => {
		const given = await world();

		const grants = listedGrants(await listResourceGrants(await given.caller('administrator'), STUDIES.a1));

		const selfGrant = listedGrant(grants, given, 'a1Self');
		assert.deepEqual(
			{
				expiresAt: instantOf(selfGrant.expiresAt),
				selfGrant: selfGrant.selfGrant,
			},
			{
				expiresAt: seededGrant(given, 'a1Self').expiresAt?.getTime(),
				selfGrant: true,
			},
		);
		assert.deepEqual(
			grants.filter(({ id }) => id !== selfGrant.id).filter(({ selfGrant: marked }) => marked === true),
			[],
		);
	});

	test('shows the granter of each grant to an administrator', async () => {
		const given = await world();

		const grants = listedGrants(await listResourceGrants(await given.caller('administrator'), STUDIES.a1));

		assert.deepEqual(
			UNREVOKED_ON_A1.map(([name]) => {
				const grant = listedGrant(grants, given, name);
				return {
					grantedAt: instantOf(grant.grantedAt),
					granter: grant.granterSubject,
					name,
				};
			}),
			UNREVOKED_ON_A1.map(([name]) => ({
				grantedAt: seededGrant(given, name).grantedAt?.getTime(),
				granter: granterSubjectOf(given, name),
				name,
			})),
		);
	});

	test('lists the grants on a resource to its owner', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const given = await startListingWorld(scope, started, {
			policy: invitedPolicy(started, wholeSecondNow()),
		});

		const listing = await listResourceGrants(await given.caller('ana'), STUDIES.a1);

		const grants = listedGrants(listing);
		assert.deepEqual(
			grants.map(({ id }) => id).toSorted(),
			UNREVOKED_ON_A1.map(([name]) => grantIdOf(given, name)).toSorted(),
		);
		UNREVOKED_ON_A1.forEach(([name]) => {
			const grant = listedGrant(grants, given, name);
			assert.equal(
				instantOf(grant.grantedAt),
				seededGrant(given, name).grantedAt?.getTime(),
				`${name} is listed with another grant time`,
			);
			assert.ok(isNamed(grant.granterName), `${name} names no granter`);
			assert.ok(!String(grant.granterName).includes('@'), `${name} names its granter by an address`);
		});
		assert.equal(listedGrant(grants, given, 'a1Gil').granterName, ANA_NAME);
		assert.equal(listedGrant(grants, given, 'a1Bo').granterName, UNNAMED_SHARER);
		assert.ok(!listing.text.includes(INVITEE_ADDRESS));
		assert.ok(!listing.text.includes(CAST.quinn));
	});

	test("answers a caller who may not see a resource's grants exactly as for a resource that does not exist", async () => {
		const given = await world();
		const mayNotSee: readonly CastName[] = ['hal', 'eve', 'dee', 'outsider'];

		const owner = await listResourceGrants(await given.caller('ana'), STUDIES.a1);
		const answers = await Promise.all(
			mayNotSee.map(async (name) => {
				const caller = await given.caller(name);
				return {
					existing: await listResourceGrants(caller, STUDIES.a1),
					missing: await listResourceGrants(caller, MISSING_STUDY),
					name,
				};
			}),
		);

		assertSucceeded(owner, "the owner's listing");
		answers.forEach(({ existing, missing, name }) => {
			assertNotFound(existing, name, 'resourceNotFound');
			assert.deepEqual(comparableRefusal(existing), comparableRefusal(missing), `${name} is answered apart`);
		});
	});

	test('refuses a caller who may see a resource and holds no authority on its grants', async () => {
		const given = await world();
		const maySee: readonly (readonly [CastName, string])[] = [
			['bo', STUDIES.a1],
			['cy', STUDIES.a1],
			['outsider', STUDIES.b2],
			['hal', STUDIES.c3],
		];

		const owner = await listResourceGrants(await given.caller('ana'), STUDIES.a1);
		const answers = await Promise.all(
			maySee.map(async ([name, externalId]) => {
				const caller = await given.caller(name);
				return {
					grants: await listResourceGrants(caller, externalId),
					name,
					read: await readResource(caller, externalId),
				};
			}),
		);

		assertSucceeded(owner, "the owner's listing");
		answers.forEach(({ grants, name, read }) => {
			assertSucceeded(read, `${name}'s read of the resource`);
			assertForbidden(grants, name, 'noAuthorityOnResource');
		});
	});

	test("finds a resource's grants by its externalId exactly", async () => {
		const given = await world();
		const administrator = await given.caller('administrator');

		const exact = await listResourceGrants(administrator, STUDIES.a1);
		const lowerCase = await listResourceGrants(administrator, STUDIES.a1.toLowerCase());
		const missing = await listResourceGrants(administrator, MISSING_STUDY);

		assertSucceeded(exact, 'the exact listing');
		assertNotFound(lowerCase, 'another letter case', 'resourceNotFound');
		assert.deepEqual(comparableRefusal(lowerCase), comparableRefusal(missing));
	});

	test("summarizes a resource's grants in its single read", async () => {
		const given = await world();
		const administrator = await given.caller('administrator');

		const asAdministrator = await readResource(administrator, STUDIES.a1);
		const asOwner = await readResource(await given.caller('ana'), STUDIES.a1);
		const asHolder = await readResource(await given.caller('bo'), STUDIES.a1);
		const unheld = await readResource(administrator, STUDIES.c3);

		[asAdministrator, asOwner, asHolder, unheld].forEach((answer) => {
			assertSucceeded(answer, 'the single read');
		});
		[asAdministrator, asOwner].forEach((answer) => {
			assert.deepEqual(rolesHeld(resourceView(answer.body).grantSummary), {
				owner: 1,
				submitter: 1,
				viewer: 2,
			});
		});
		assert.equal(carriesGrantSummary(asHolder.body), false);
		assert.notEqual(resourceView(unheld.body).grantSummary, undefined);
		assert.deepEqual(rolesHeld(resourceView(unheld.body).grantSummary), {});
	});
});
