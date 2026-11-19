import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as readiness from './index.js';

suite('the readiness module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(readiness).toSorted(), [
			'READINESS_LOST',
			'READINESS_RESTORED',
			'STORE_PROBE_INTERVAL_MILLISECONDS',
			'createReadiness',
		]);
	});
});
