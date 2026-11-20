import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as applications from './index.js';

suite('the applications module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(applications).toSorted(), [
			'createApplicationKeyCipher',
			'createApplicationRoutes',
			'findApplication',
			'insertApplication',
			'insertKey',
		]);
	});
});
