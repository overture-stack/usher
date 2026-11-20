import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	assertForbidden,
	assertNotFound,
	assertRuleBroken,
	assertSucceeded,
	assertUnreadable,
	comparableRefusal,
	comparableSuccess,
	GRANT_STATES,
	holderOf,
	INCLUDING_RETIRED,
	instantOf,
	LISTING_QUERY,
	listedExternalIds,
	listedGrants,
	listedResource,
	listedResources,
	listOwnGrants,
	listResourceGrants,
	listResources,
	nextCursor,
	pageMembersBeside,
	readResource,
	resourcePages,
} from '../../../testing/harness/admin.js';
import {
	CAST,
	type CastName,
	castNameOf,
	daysBefore,
	fileRealm,
	type ListingWorld,
	listingPolicy,
	MISSING_STUDY,
	OTHER_STUDIES,
	othersPolicy,
	ownerStatesPolicy,
	PAGING_STUDIES,
	pagingPolicy,
	RETIRED_STUDY,
	retiredPolicy,
	startListingWorld,
	STUDIES,
	suiteWorld,
	untilInThePast,
	wholeSecondNow,
} from '../../../testing/fixtures/listings.js';
import { retireInStore, seededId, seedPolicy } from '../../../testing/harness/policy.js';
import { cleanupFor } from '../../../testing/harness/waiting.js';

const realm = fileRealm();

const subjectsOf = (world: ListingWorld, names: readonly CastName[]): readonly string[] =>
	names.map((name) => world.realm.subject(name)).toSorted();

const bySubject = <Entry extends { subject: unknown }>(entries: readonly Entry[]): readonly Entry[] =>
	entries.toSorted((first, second) => String(first.subject).localeCompare(String(second.subject)));

suite('listing resources for an administrator', () => {
	const world = suiteWorld(realm, (started) => ({
		policy: listingPolicy(started, wholeSecondNow()),
	}));

	test('lists every resource with its details, access level and holders', async () => {
		const given = await world();
		const stored = given.harness.seeded.resourceTimes;
		await untilInThePast(stored, 2_000);

		const listing = await listResources(await given.caller('administrator'));

		assert.deepEqual(listedExternalIds(listing), [STUDIES.a1, STUDIES.b2, STUDIES.c3]);
		assert.deepEqual(
			listedResources(listing).map(
				({
					accessLevel,
					description,
					displayName,
					externalId,
					registeredAt,
					registrantSubject,
					updatedAt,
				}) => ({
					accessLevel,
					description,
					displayName,
					externalId,
					registeredAt: instantOf(registeredAt),
					registrantSubject,
					updatedAt: instantOf(updatedAt),
				}),
			),
			[STUDIES.a1, STUDIES.b2, STUDIES.c3].map((externalId) => {
				const seeded = given.policy.resources?.[externalId];
				const times = stored[externalId];
				return {
					accessLevel: seeded?.baseTier,
					description: seeded?.description,
					displayName: seeded?.name,
					externalId,
					registeredAt: times?.registeredAt.getTime(),
					registrantSubject: given.realm.subject(castNameOf(seeded?.registeredBy ?? '')),
					updatedAt: times?.updatedAt.getTime(),
				};
			}),
		);
		assert.deepEqual(
			[STUDIES.a1, STUDIES.b2, STUDIES.c3].map((externalId) =>
				(listedResource(listing, externalId).grants ?? []).map(({ holder }) => holder?.subject).toSorted(),
			),
			[
				subjectsOf(given, ['administrator', 'ana', 'bo', 'cy', 'dee', 'fay', 'gil']),
				subjectsOf(given, ['bo', 'hal']),
				[],
			],
		);
	});

	test("includes each study's submitters as the study screens show them", async () => {
		const given = await world();

		const listing = await listResources(await given.caller('administrator'));

		const submitters = (listedResource(listing, STUDIES.a1).grants ?? [])
			.filter(({ role }) => role === 'submitter')
			.map((grant) => ({ ...holderOf(grant), state: grant.state }));
		assert.deepEqual(
			bySubject(submitters),
			bySubject([
				{
					email: CAST.bo,
					noAccount: false,
					state: GRANT_STATES.accepted,
					subject: given.realm.subject('bo'),
				},
				{
					email: CAST.cy,
					noAccount: false,
					state: GRANT_STATES.pending,
					subject: given.realm.subject('cy'),
				},
				{
					email: CAST.dee,
					noAccount: false,
					state: GRANT_STATES.rejected,
					subject: given.realm.subject('dee'),
				},
				{
					email: undefined,
					noAccount: true,
					state: GRANT_STATES.expired,
					subject: given.realm.subject('fay'),
				},
			]),
		);
	});

	test('lists a resource with no grants as holding none', async () => {
		const given = await world();

		const listing = await listResources(await given.caller('administrator'));

		assert.deepEqual(listedResource(listing, STUDIES.c3).grants, []);
		assert.ok((listedResource(listing, STUDIES.a1).grants ?? []).length > 0);
	});

	test('lists a holder whose account was deleted by subject alone', async () => {
		const given = await world();

		const listing = await listResources(await given.caller('administrator'));

		const holders = (listedResource(listing, STUDIES.a1).grants ?? []).map(holderOf);
		assert.deepEqual(
			holders.filter(({ subject }) => subject === given.realm.subject('fay')),
			[
				{
					email: undefined,
					noAccount: true,
					subject: given.realm.subject('fay'),
				},
			],
		);
		assert.deepEqual(
			holders.filter(({ subject }) => subject === given.realm.subject('bo')),
			[
				{
					email: CAST.bo,
					noAccount: false,
					subject: given.realm.subject('bo'),
				},
			],
		);
		assert.ok(!listing.text.includes(CAST.fay));
	});

	test('answers in a stable order, page by page', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const paging = await startListingWorld(scope, started, {
			policy: pagingPolicy(started),
		});
		const administrator = await paging.caller('administrator');

		const first = await resourcePages(administrator, { limit: 3 });
		const second = await resourcePages(administrator, { limit: 3 });

		assert.deepEqual(first.flatMap(listedExternalIds), PAGING_STUDIES.toSorted());
		assert.deepEqual(
			first.map((page) => listedExternalIds(page).length),
			[3, 3, 1],
		);
		assert.deepEqual(
			first.map((page) => nextCursor(page) !== undefined),
			[true, true, false],
		);
		assert.deepEqual(second.flatMap(listedExternalIds), first.flatMap(listedExternalIds));
		assert.deepEqual(
			first.map((page) => pageMembersBeside(page, 'resources')),
			[[], [], []],
		);
	});

	test('refuses a listing parameter it does not know or cannot read, and a page size out of range', async () => {
		const given = await world();
		const administrator = await given.caller('administrator');
		const asking = (query: Readonly<Record<string, string>>): Promise<AdminResponse> =>
			listResources(administrator, { query });

		const readable = await asking({ [LISTING_QUERY.limit]: '3' });
		const unreadable = await Promise.all([
			asking({ offset: '3' }),
			asking({ [LISTING_QUERY.limit]: 'three' }),
			asking({ [LISTING_QUERY.limit]: '1.5' }),
			asking({ [LISTING_QUERY.cursor]: 'not-a-cursor' }),
		]);
		const outOfRange = await Promise.all([
			asking({ [LISTING_QUERY.limit]: '0' }),
			asking({ [LISTING_QUERY.limit]: '-1' }),
		]);

		assertSucceeded(readable, 'a page size of 3');
		unreadable.forEach((answer, index) => {
			assertUnreadable(answer, `unreadable parameter ${index + 1}`);
		});
		outOfRange.forEach((answer, index) => {
			assertRuleBroken(answer, `page size out of range ${index + 1}`);
		});
	});

	test('lists a retired resource, marked retired, only to an administrator asking for retired resources', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const base = wholeSecondNow();
		const retired = await startListingWorld(scope, started, {
			policy: retiredPolicy(started, base),
		});
		const endedOwnerGrants = await retireInStore(retired.harness.clients.migration, {
			at: daysBefore(base, 4),
			by: seededId(retired.harness.seeded.users, 'administrator'),
			externalId: RETIRED_STUDY,
		});
		const administrator = await retired.caller('administrator');
		const hal = await retired.caller('hal');
		const gil = await retired.caller('gil');

		const unasked = await listResources(administrator);
		const asked = await listResources(administrator, INCLUDING_RETIRED);
		const formerOwner = {
			asked: await listResources(hal, INCLUDING_RETIRED),
			unasked: await listResources(hal),
		};
		const formerHolder = {
			asked: await listResources(gil, INCLUDING_RETIRED),
			ownGrants: await listOwnGrants(gil),
			unasked: await listResources(gil),
		};
		const retiredReads = await Promise.all(
			[hal, gil]
				.flatMap((caller) => [
					{
						missing: readResource(caller, MISSING_STUDY),
						retired: readResource(caller, RETIRED_STUDY),
					},
					{
						missing: listResourceGrants(caller, MISSING_STUDY),
						retired: listResourceGrants(caller, RETIRED_STUDY),
					},
				])
				.map(async ({ missing, retired: read }) => ({
					missing: await missing,
					retired: await read,
				})),
		);
		const visible = await readResource(hal, STUDIES.b2);

		assert.deepEqual(endedOwnerGrants, []);
		assert.deepEqual(listedExternalIds(unasked), [STUDIES.a1, STUDIES.b2, STUDIES.c3]);
		assert.equal(listedResource(asked, RETIRED_STUDY).retired, true);
		assert.deepEqual(
			listedResources(asked)
				.filter(({ externalId }) => externalId !== RETIRED_STUDY)
				.filter(({ retired: marked }) => marked === true),
			[],
		);
		assert.deepEqual(listedExternalIds(formerOwner.unasked), [STUDIES.b2]);
		assert.deepEqual(listedExternalIds(formerHolder.unasked), []);
		assertForbidden(formerOwner.asked, 'Hal asking', 'administratorOnly');
		assertForbidden(formerHolder.asked, 'Gil asking', 'administratorOnly');
		[formerOwner.asked, formerHolder.asked].forEach((answer) => {
			assert.ok(!answer.text.includes(RETIRED_STUDY));
		});
		assert.deepEqual(
			listedGrants(formerHolder.ownGrants).map(({ resource }) => resource),
			[STUDIES.a1],
		);
		assertSucceeded(visible, "Hal's read of the study he owns");
		retiredReads.forEach(({ missing, retired: read }, index) => {
			assertNotFound(read, `retired read ${index + 1}`, 'resourceNotFound');
			assert.deepEqual(comparableRefusal(read), comparableRefusal(missing));
		});
	});
});

suite('listing resources for an owner', () => {
	const world = suiteWorld(realm, (started) => ({
		policy: listingPolicy(started, wholeSecondNow()),
	}));

	test('lists only the resources the caller owns', async () => {
		const given = await world();

		const ana = await listResources(await given.caller('ana'));
		const hal = await listResources(await given.caller('hal'));

		assert.deepEqual(listedExternalIds(ana), [STUDIES.a1]);
		assert.deepEqual(listedExternalIds(hal), [STUDIES.b2]);
	});

	test('discloses nothing about resources the caller does not own', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const base = wholeSecondNow();
		const given = await startListingWorld(scope, started, {
			policy: listingPolicy(started, base),
		});

		const withThree = await listResources(await given.caller('ana'));
		await seedPolicy(given.harness.clients.migration, othersPolicy(started, base));
		const withEight = await listResources(await given.caller('ana'));

		assert.deepEqual(listedExternalIds(withThree), [STUDIES.a1]);
		assert.equal(nextCursor(withThree), undefined);
		assert.deepEqual(
			{ body: withEight.body, status: withEight.status },
			{ body: withThree.body, status: withThree.status },
		);
		[STUDIES.b2, STUDIES.c3, ...OTHER_STUDIES].forEach((externalId) => {
			assert.ok(!withEight.text.includes(externalId), `the listing names ${externalId}`);
		});
	});

	test('answers a caller who owns nothing with an empty list', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const given = await startListingWorld(scope, started, {
			policy: ownerStatesPolicy(started, wholeSecondNow()),
		});
		const ownNothing: readonly CastName[] = ['outsider', 'ana', 'hal', 'cy', 'bo'];

		const answers = await Promise.all(ownNothing.map(async (name) => listResources(await given.caller(name))));
		const owner = await listResources(await given.caller('dee'));

		answers.forEach((answer, index) => {
			assert.deepEqual(listedExternalIds(answer), [], `${ownNothing[index] ?? 'a caller'} is listed a resource`);
		});
		const [first, ...rest] = answers.map((answer) => comparableSuccess(answer));
		rest.forEach((answer) => {
			assert.deepEqual(answer, first);
		});
		assert.deepEqual(listedExternalIds(owner), [STUDIES.c3]);
	});
});
