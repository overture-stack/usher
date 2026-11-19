import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { type SignInTokenMaximumHistory, signInTokenMaximumOf } from '../settings/index.js';
import { currencyOf } from './currencyOf.js';
import { EXCESSIVE_LIFETIME } from './excessiveLifetime.js';

// The maximum's history: 300 seeded, raised to 600 at T1 (1000), and more than 300 seconds later, at T2
// (1310), raised to 3600.
const HISTORY = [
	{ recordedAt: 100, seconds: 300 },
	{ recordedAt: 1000, seconds: 600 },
	{ recordedAt: 1310, seconds: 3600 },
] as unknown as SignInTokenMaximumHistory;

const settingsOver = (history: SignInTokenMaximumHistory) => ({
	signInTokenMaximumFor: (issuedAt: number) => signInTokenMaximumOf(history, issuedAt),
});

// The instant T2 plus 10 seconds, in milliseconds, at which the tokens below are judged.
const JUDGED_AT = (1310 + 10) * 1000;

suite("currencyOf judging a token's lifetime over the maximum's history", () => {
	test('refuses a token issued before the first raise, living 330 seconds, when judged after the second raise', () => {
		const reading = currencyOf({ exp: 990 + 330, iat: 990 }, settingsOver(HISTORY), JUDGED_AT);
		assert.deepEqual(reading, { kind: 'refused', reason: EXCESSIVE_LIFETIME });
	});

	test('accepts a token issued at the first raise, living 320 seconds, when judged after the second raise', () => {
		const reading = currencyOf({ exp: 1000 + 320, iat: 1000 }, settingsOver(HISTORY), JUDGED_AT);
		assert.deepEqual(reading, { expiresAt: 1320, kind: 'current' });
	});
});
