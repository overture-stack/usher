import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { PEOPLE } from '../../testing/harness/exchange.js';
import {
	acceptance,
	actionsHeld,
	CATEGORY,
	grantTo,
	issuanceFixture,
	payloadFor,
} from '../../testing/fixtures/issuance.js';
import { suiteHarness } from '../../testing/harness/harness.js';

const LONG_SIGN_IN = Object.freeze({ lifetimeSeconds: 3600 });

// Ana holds each data-plane seeded role on `controlled` in a resource of its own, so each entry is
// what one role confers.
const HELD = Object.freeze({
	curator: 'STUDY-C3',
	editor: 'STUDY-B2',
	submitter: 'STUDY-D4',
	viewer: 'STUDY-A1',
});

suite('the sets a seeded role lets its holder make', () => {
	const shared = suiteHarness({
		fixture: issuanceFixture({
			decisions: Object.keys(HELD).map(acceptance),
			grants: Object.fromEntries(
				Object.entries(HELD).map(([role, resource]) => [role, grantTo('ana', resource, 'controlled', role)]),
			),
		}),
	});

	test('lets whoever reads a category through viewer, editor or curator make sets from it, in that category alone', async () => {
		const harness = await shared();

		const ana = await payloadFor(harness, { mint: LONG_SIGN_IN, person: PEOPLE.ana });

		assert.deepEqual(
			(['viewer', 'editor', 'curator'] as const).map((role) => ({
				controlled: actionsHeld(ana, HELD[role], CATEGORY.controlled, 'artifact'),
				role,
				unmarked: actionsHeld(ana, HELD[role], CATEGORY.unmarked, 'artifact'),
			})),
			(['viewer', 'editor', 'curator'] as const).map((role) => ({
				controlled: ['create'],
				role,
				unmarked: undefined,
			})),
		);
	});

	test("makes no set from a submitter's grant, which reads nothing", async () => {
		const harness = await shared();

		const ana = await payloadFor(harness, { mint: LONG_SIGN_IN, person: PEOPLE.ana });

		assert.deepEqual(actionsHeld(ana, HELD.submitter, CATEGORY.controlled, 'record'), ['create', 'update']);
		assert.equal(actionsHeld(ana, HELD.submitter, CATEGORY.controlled, 'artifact'), undefined);
	});
});
