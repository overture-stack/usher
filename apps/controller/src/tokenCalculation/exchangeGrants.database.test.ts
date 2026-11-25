import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { AUDIT_EVENT_TYPES, auditRows, emittedType } from '../../testing/harness/auditEvents.js';
import { PEOPLE } from '../../testing/harness/exchange.js';
import {
	acceptance,
	CATEGORY,
	grantTo,
	heldEntries,
	issuanceFixture,
	LYRIC,
	payloadFor,
	READ,
} from '../../testing/fixtures/issuance.js';
import { suiteHarness } from '../../testing/harness/harness.js';

const MINUTE_MS = 60_000;

const LONG_SIGN_IN = Object.freeze({ lifetimeSeconds: 3600 });

// What a `viewer` grant confers on its category: reading its records, and making sets from them. The
// rules confer reading alone.
const VIEWED = Object.freeze({ artifact: ['create'], record: READ });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

suite('the grants a signed-in exchange reads from the store', () => {
	const now = Date.now();
	const expiring = new Date(now + 200_000);
	const fieldExpiring = new Date(now + 100_000);
	const decidedAt = (minutesAgo: number): Date => new Date(now - minutesAgo * MINUTE_MS);

	// Ana's grants, each kept or not for one reason: held by her directly or through her group, decided
	// on last by an acceptance or a rejection, revoked, held by Bo, on a resource arranger-test does not
	// serve, naming a field category, at a control-plane role, and accepted for less than its role
	// carries.
	const shared = suiteHarness({
		fixture: issuanceFixture({
			decisions: [
				acceptance('direct'),
				{ decision: 'accepted', grant: 'throughGroup', person: 'ana' },
				{ decision: 'accepted', grant: 'heldByBo', person: 'ana' },
				{
					decidedAt: decidedAt(2),
					decision: 'accepted',
					grant: 'rejectedLast',
				},
				{
					decidedAt: decidedAt(1),
					decision: 'declined',
					grant: 'rejectedLast',
				},
				{
					decidedAt: decidedAt(2),
					decision: 'declined',
					grant: 'acceptedLast',
				},
				{
					decidedAt: decidedAt(1),
					decision: 'accepted',
					grant: 'acceptedLast',
				},
				acceptance('revoked'),
				acceptance('unserved'),
				acceptance('fieldNamed'),
				acceptance('expiring'),
				acceptance('anaOwns'),
				{
					capabilities: ['record.view'],
					decision: 'accepted',
					grant: 'acceptedNarrowly',
				},
			],
			grants: {
				acceptedLast: grantTo('ana', 'STUDY-D4', 'controlled'),
				acceptedNarrowly: grantTo('ana', 'STUDY-D4', 'unmarked'),
				anaOwns: {
					category: null,
					holder: { user: 'ana' },
					resource: 'STUDY-A1',
					role: 'owner',
				},
				direct: grantTo('ana', 'STUDY-A1', 'controlled'),
				expiring: {
					...grantTo('ana', 'STUDY-A1', 'community-governed'),
					expiresAt: expiring,
				},
				fieldNamed: {
					...grantTo('ana', 'STUDY-B2', 'community-governed'),
					expiresAt: fieldExpiring,
					fieldCategory: 'controlled',
				},
				heldByBo: grantTo('bo', 'STUDY-C3', 'controlled'),
				rejectedLast: grantTo('ana', 'STUDY-C3', 'community-governed'),
				revoked: {
					...grantTo('ana', 'STUDY-C3', 'controlled'),
					revoked: {},
				},
				throughGroup: {
					category: 'controlled',
					holder: { group: 'G1' },
					resource: 'STUDY-B2',
					role: 'viewer',
				},
				unserved: grantTo('ana', 'STUDY-E5', 'controlled'),
			},
			groups: { G1: { members: ['ana', 'bo'], resource: 'STUDY-B2' } },
		}),
	});

	test('confers what each kept grant reaching her confers and nothing through any other, beside the rules', async () => {
		const harness = await shared();

		const ana = await payloadFor(harness, {
			mint: LONG_SIGN_IN,
			person: PEOPLE.ana,
		});

		assert.deepEqual(heldEntries(ana), {
			'STUDY-A1': {
				[CATEGORY.communityGoverned]: VIEWED,
				[CATEGORY.controlled]: VIEWED,
				[CATEGORY.unmarked]: { record: READ },
			},
			'STUDY-B2': {
				[CATEGORY.controlled]: VIEWED,
				[CATEGORY.unmarked]: { record: READ },
			},
			'STUDY-C3': { [CATEGORY.unmarked]: { record: READ } },
			'STUDY-D4': {
				[CATEGORY.controlled]: VIEWED,
				[CATEGORY.unmarked]: { record: ['view'] },
			},
		});
	});

	test('ends her token with the earliest grant it drew on, not with a grant naming a field category, and counts the grants drawn on in its token.exchange', async () => {
		const harness = await shared();

		const ana = await payloadFor(harness, {
			mint: LONG_SIGN_IN,
			person: PEOPLE.ana,
		});
		const [recorded] = (await auditRows(harness.clients.migration))
			.flatMap(({ data, type }) =>
				type === emittedType(AUDIT_EVENT_TYPES.tokenExchange) &&
				isRecord(data) &&
				data['actorId'] === PEOPLE.ana.subject
					? [data]
					: [],
			)
			.toReversed();

		assert.equal(ana.exp, Math.floor(expiring.getTime() / 1000));
		assert.ok(ana.exp > Math.floor(fieldExpiring.getTime() / 1000));
		assert.equal(recorded?.['grantCount'], 5);
		assert.equal(recorded?.['tokenTtl'], ana.exp - ana.iat);
	});

	test("reaches no other member through a group's grant or a grant held by another, without their own acceptance", async () => {
		const harness = await shared();

		const bo = await payloadFor(harness, { person: PEOPLE.bo });

		assert.deepEqual(heldEntries(bo)['STUDY-B2'], {
			[CATEGORY.unmarked]: { record: READ },
		});
		assert.deepEqual(heldEntries(bo)['STUDY-C3'], {
			[CATEGORY.unmarked]: { record: READ },
		});
	});

	test('confers a grant on a resource through the audience serving it alone', async () => {
		const harness = await shared();

		const throughLyric = await payloadFor(harness, {
			application: LYRIC,
			person: PEOPLE.ana,
		});

		assert.deepEqual(heldEntries(throughLyric)['STUDY-E5'], {
			[CATEGORY.controlled]: VIEWED,
			[CATEGORY.unmarked]: { record: READ },
		});
	});
});
