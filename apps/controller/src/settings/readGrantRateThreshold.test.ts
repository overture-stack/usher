import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantRateThreshold } from './readGrantRateThreshold.js';

const OBJECT_RULE = 'is not an object holding operationCount and windowSeconds alone';

const refusedRuleOf = (value: unknown): string => {
	const reading = readGrantRateThreshold(value);
	assert.equal(reading.kind, 'refused', `${JSON.stringify(value)} is refused`);
	return reading.kind === 'refused' ? reading.rule : '';
};

suite('reading the grant rate threshold', () => {
	test('reads an object holding a whole operationCount and windowSeconds, in either order', () => {
		assert.deepEqual(readGrantRateThreshold(JSON.parse('{ "windowSeconds": 5, "operationCount": 1 }')), {
			kind: 'read',
			value: { operationCount: 1, windowSeconds: 5 },
		});
		assert.deepEqual(readGrantRateThreshold(JSON.parse('{"operationCount":250,"windowSeconds":2147483647}')), {
			kind: 'read',
			value: { operationCount: 250, windowSeconds: 2_147_483_647 },
		});
	});

	test('refuses anything but an object holding operationCount and windowSeconds alone', () => {
		[
			'10',
			'text',
			'null',
			'[10,60]',
			{ operationCount: 10 },
			{ windowSeconds: 60 },
			{ operationCount: 10, perActor: true, windowSeconds: 60 },
			JSON.parse('{"operationCount":10,"windowSeconds":60,"__proto__":{}}'),
		].forEach((value) => {
			assert.equal(refusedRuleOf(value), OBJECT_RULE, JSON.stringify(value));
		});
	});

	test('refuses an operationCount that is not a whole number of at least 1', () => {
		['0', '-1', '1.5', '"10"', 'true', 'null', '9007199254740993'].forEach((count) => {
			assert.equal(
				refusedRuleOf(JSON.parse(`{"operationCount":${count},"windowSeconds":60}`)),
				'has an operationCount that is not a whole number of at least 1',
				count,
			);
		});
	});

	test('refuses a windowSeconds that is not a whole number from 1 to 2147483647', () => {
		['0', '-60', '0.5', '"60"', '2147483648', '1e300', '[]'].forEach((window) => {
			assert.equal(
				refusedRuleOf(JSON.parse(`{"operationCount":10,"windowSeconds":${window}}`)),
				'has a windowSeconds that is not a whole number from 1 to 2147483647',
				window,
			);
		});
	});
});
