import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as resourceStanding from './index.js';

suite('the resource standing module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(resourceStanding).toSorted(), [
			'STANDING_PROBLEMS',
			'countedOwnerCondition',
			'isLive',
			'latestDecisionOf',
			'liveGrantCondition',
			'maySee',
			'readResourceStanding',
			'standingColumns',
		]);
	});
});
