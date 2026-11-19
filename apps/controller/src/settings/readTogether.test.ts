import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { LARGEST_RETENTION_FLOOR_SECONDS, readTogether } from './readTogether.js';

const durations = (
	tokenLifetimeSeconds: number,
	retentionGraceSeconds: number,
	retentionMarginSeconds: number,
): Parameters<typeof readTogether>[0] => ({ retentionGraceSeconds, retentionMarginSeconds, tokenLifetimeSeconds });

suite('settings read together', () => {
	test('allows a retention floor of exactly the largest the column holds', () => {
		assert.equal(LARGEST_RETENTION_FLOOR_SECONDS, 2147483647);
		assert.deepEqual(readTogether(durations(2147483647, 0, 0)), []);
	});

	test('refuses a retention floor past the largest, naming each of the three durations it is made of', () => {
		const problems = readTogether(durations(2147483647, 1, 0));

		assert.deepEqual(problems.map(({ setting }) => setting).toSorted(), [
			'retentionGraceSeconds',
			'retentionMarginSeconds',
			'tokenLifetimeSeconds',
		]);
		problems.forEach(({ rule }) => assert.match(rule, /2147483647/u));
	});

	test('reads the durations of the defaults as allowed', () => {
		assert.deepEqual(readTogether(durations(300, 60, 30)), []);
	});
});
