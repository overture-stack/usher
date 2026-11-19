import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as retention from './index.js';

suite('the retention module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(retention).toSorted(), [
			'RETENTION_SWEEP_FAILED',
			'RETENTION_SWEEP_INTERVAL_MILLISECONDS',
			'createRetentionSweep',
		]);
	});
});
