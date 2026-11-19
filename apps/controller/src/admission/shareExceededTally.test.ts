import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	SHARE_EXCEEDED_RETRY_AFTER_SECONDS,
	SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS,
	shareExceededTallyEvent,
} from './shareExceededTally.js';

suite('exchanges refused over their share, as recorded', () => {
	test('records a count as admission.shareExceededTally naming its application and the count alone, at warning', () => {
		const applicationId = randomUUID();

		const event = shareExceededTallyEvent(applicationId, 7);

		assert.deepEqual(event, {
			data: { applicationId, count: 7 },
			severity: 'warning',
			type: 'admission.shareExceededTally',
		});
	});

	test('counts over 60 s intervals and tells a refused exchange to wait 1 s', () => {
		assert.equal(SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS, 60_000);
		assert.equal(SHARE_EXCEEDED_RETRY_AFTER_SECONDS, 1);
	});
});
