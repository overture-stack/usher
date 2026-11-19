import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CONFIGURATION_DEFAULTS } from '@overture-stack/usher-express-bridge';

import { EXCHANGE_PROBLEMS, TOKEN_LIMIT_BYTES } from './exchangeProblems.js';

suite("the exchange's limits and refusals", () => {
	test("limits a token to the bridge's default response cap, 1 MiB", () => {
		assert.equal(TOKEN_LIMIT_BYTES, CONFIGURATION_DEFAULTS.responseCapBytes);
		assert.equal(TOKEN_LIMIT_BYTES, 1_048_576);
	});

	test('refuses a token past the limit as 503 tokenOverResponseCap, naming the limit and no value', () => {
		const { code, detail, status } = EXCHANGE_PROBLEMS.tokenOverResponseCap;

		assert.deepEqual({ code, status }, { code: 'tokenOverResponseCap', status: 503 });
		assert.ok(detail.includes(String(TOKEN_LIMIT_BYTES)));
	});
});
