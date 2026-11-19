import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as tokenCalculation from './index.js';

suite("the token calculation's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(tokenCalculation).toSorted(), [
			'anonymousCalculation',
			'readAudiencePolicy',
			'readPrincipalPolicy',
			'signedInCalculation',
		]);
	});
});
