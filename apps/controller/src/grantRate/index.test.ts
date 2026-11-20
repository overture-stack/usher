import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as grantRate from './index.js';

suite('the grant rate module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(grantRate).toSorted(), ['createGrantRate']);
	});
});
