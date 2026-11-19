import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as channelAssertion from './index.js';

suite("the channel assertion's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(channelAssertion).toSorted(), [
			'CHANNEL_ASSERTION_AUDIENCE',
			'CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS',
			'CHANNEL_ASSERTION_REFUSED',
			'CHANNEL_ASSERTION_TYPE',
			'REFUSED_ASSERTIONS_LIMIT',
			'REFUSED_ASSERTION_WINDOW_MILLISECONDS',
			'REJECTION_TALLY_INTERVAL_MILLISECONDS',
			'REJECTION_UNRECORDED',
			'createAssertionRefusals',
			'createChannelAssertionVerifier',
			'createRefusedAssertions',
			'pendingRecordingLimit',
			'rejectionEvent',
			'rejectionTallyEvent',
		]);
	});
});
