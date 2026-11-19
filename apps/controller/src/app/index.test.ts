import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as app from './index.js';

suite("the app's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(app).toSorted(), ['createController']);
	});
});
