import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as revocations from './index.js';

suite('the revocations module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(revocations).toSorted(), [
			'REVOCATION_PROBLEMS',
			'createRevocationRoutes',
			'sqlRevocationStore',
		]);
	});
});
