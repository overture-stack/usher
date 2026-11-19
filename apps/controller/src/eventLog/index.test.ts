import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as eventLog from './index.js';

suite("the event log's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(eventLog).toSorted(), [
			'REFUSED_SUBJECT_MAXIMUM_LENGTH',
			'createAuditTrail',
			'createEventLog',
			'eventInstant',
		]);
	});
});
