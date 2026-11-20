import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as directory from './index.js';

suite("the directory's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(directory).toSorted(), [
			'DIRECTORY_BOUNDS',
			'DIRECTORY_UNAVAILABLE',
			'createDirectory',
		]);
	});
});
