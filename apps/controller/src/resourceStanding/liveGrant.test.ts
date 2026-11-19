import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { isLive } from './liveGrant.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const at = (offsetMilliseconds: number): Date => new Date(NOW + offsetMilliseconds);

const OPEN_ENDED = { endedAt: null, expiresAt: null, revokedAt: null };

suite('whether a grant is live', () => {
	test('holds a grant neither revoked nor ended live, whether it never expires or expires later', () => {
		assert.deepEqual([isLive(OPEN_ENDED, NOW), isLive({ ...OPEN_ENDED, expiresAt: at(1) }, NOW)], [true, true]);
	});

	test('holds a grant expiring at the configured instant or before it ended', () => {
		assert.deepEqual(
			[isLive({ ...OPEN_ENDED, expiresAt: at(0) }, NOW), isLive({ ...OPEN_ENDED, expiresAt: at(-1) }, NOW)],
			[false, false],
		);
	});

	test('holds a revoked grant ended, whatever its expiry', () => {
		assert.equal(isLive({ ...OPEN_ENDED, expiresAt: at(60_000), revokedAt: at(-1) }, NOW), false);
	});

	test('holds a grant replaced after its expiry ended, even read on a clock before that expiry', () => {
		assert.equal(isLive({ endedAt: at(-1000), expiresAt: at(1000), revokedAt: null }, NOW), false);
	});
});
