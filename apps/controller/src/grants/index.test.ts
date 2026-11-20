import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as grants from './index.js';

suite('the grants module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(grants).toSorted(), [
			'GRANT_PROBLEMS',
			'createGrantRoutes',
			'grantsOnResources',
			'readHolder',
			'sqlGrantStore',
			'unresolvedByDirectory',
			'writeGrant',
		]);
	});
});
