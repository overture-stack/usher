import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { signInTokenMaximumOf, type SignInTokenMaximumHistory } from './signInTokenMaximum.js';

// A history of the maximum's changes, oldest first, with each instant in seconds since the Unix epoch.
const historyOf = (...records: readonly [recordedAt: number, seconds: number][]): SignInTokenMaximumHistory =>
	records.map(([recordedAt, seconds]) => ({ recordedAt, seconds })) as unknown as SignInTokenMaximumHistory;

suite('the sign-in token maximum judged over its history', () => {
	test('gives the one value the history holds, for a token issued before or after it was recorded', () => {
		const history = historyOf([100, 300]);
		assert.equal(signInTokenMaximumOf(history, 50), 300);
		assert.equal(signInTokenMaximumOf(history, 500), 300);
	});

	test('judges a token issued before a lowering by the lower value', () => {
		const history = historyOf([100, 300], [1000, 60]);
		assert.equal(signInTokenMaximumOf(history, 500), 60);
		assert.equal(signInTokenMaximumOf(history, 1500), 60);
	});

	test('judges a token issued before a raise by the lower value, and one issued after it by the higher', () => {
		const history = historyOf([100, 300], [1000, 600]);
		assert.equal(signInTokenMaximumOf(history, 500), 300);
		assert.equal(signInTokenMaximumOf(history, 1500), 600);
	});

	test('judges a token issued before the first raise of two by 300, the smallest since its issue, and one issued between the raises by 600', () => {
		// At T1 (1000) the maximum rises from 300 to 600; at T2 (1310), more than 300 seconds later, from 600 to 3600.
		const history = historyOf([100, 300], [1000, 600], [1310, 3600]);
		assert.equal(signInTokenMaximumOf(history, 990), 300);
		assert.equal(signInTokenMaximumOf(history, 1000), 600);
		assert.equal(signInTokenMaximumOf(history, 1200), 600);
	});

	test('takes a record recorded exactly at the issue instant as in force at it', () => {
		const history = historyOf([100, 300], [1000, 600]);
		assert.equal(signInTokenMaximumOf(history, 1000), 600);
	});
});
