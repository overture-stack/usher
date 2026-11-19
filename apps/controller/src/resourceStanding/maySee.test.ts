import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { maySee } from './maySee.js';
import type { Onlooker, ResourceStanding } from './types.js';

const standing = (over: Partial<ResourceStanding> = {}): ResourceStanding => ({
	accessLevel: 'grant',
	countedOwner: false,
	externalId: 'STUDY-A1',
	holder: false,
	id: '00000000-0000-4000-8000-000000000001',
	retired: false,
	suppressed: false,
	...over,
});

const SIGNED_IN: Onlooker = { administrator: false, asksForRetired: false };

const ADMINISTRATOR: Onlooker = { administrator: true, asksForRetired: false };

suite('who may see a resource', () => {
	test('shows a resource at the grant tier to a platform administrator and to a holder, an owner among them', () => {
		const atGrantTier = [standing({ holder: true }), standing({ countedOwner: true, holder: true })];

		assert.equal(maySee(standing(), ADMINISTRATOR), true);
		assert.deepEqual(
			atGrantTier.map((held) => maySee(held, SIGNED_IN)),
			[true, true],
		);
	});

	test('shows a resource at the grant tier to nobody else', () => {
		assert.equal(maySee(standing(), SIGNED_IN), false);
	});

	test('shows an open or registered resource to every signed-in principal', () => {
		const tiers = [standing({ accessLevel: 'open' }), standing({ accessLevel: 'registered' })];

		assert.deepEqual(
			tiers.map((tiered) => maySee(tiered, SIGNED_IN)),
			[true, true],
		);
	});

	test('shows a suppressed resource to a platform administrator and its holders alone, whatever its tier', () => {
		const suppressed = standing({ accessLevel: 'open', suppressed: true });

		assert.deepEqual(
			[
				maySee(suppressed, SIGNED_IN),
				maySee({ ...suppressed, holder: true }, SIGNED_IN),
				maySee(suppressed, ADMINISTRATOR),
			],
			[false, true, true],
		);
	});

	test('shows a retired resource only to a platform administrator asking for it', () => {
		const retired = standing({
			accessLevel: 'open',
			countedOwner: true,
			holder: true,
			retired: true,
		});

		assert.deepEqual(
			[
				maySee(retired, SIGNED_IN),
				maySee(retired, { administrator: false, asksForRetired: true }),
				maySee(retired, ADMINISTRATOR),
				maySee(retired, { administrator: true, asksForRetired: true }),
			],
			[false, false, false, true],
		);
	});
});
