import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as admission from './index.js';

suite('the admission module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(admission).toSorted(), [
			'SHARE_EXCEEDED_RETRY_AFTER_SECONDS',
			'SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS',
			'SHARE_FLOOR',
			'admissionShare',
			'createAdmission',
			'shareExceededTallyEvent',
		]);
	});
});
