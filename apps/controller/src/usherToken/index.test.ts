import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as usherToken from './index.js';

suite("the Usher token's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(usherToken).toSorted(), ['sealUsherToken']);
	});
});
