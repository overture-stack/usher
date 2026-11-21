import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readNominationDecision } from './readNominationDecision.js';

suite("reading a nominee's decision", () => {
	test('reads accept as the decision accepted, and decline as declined', () => {
		assert.deepEqual(readNominationDecision({ decision: 'accept' }), {
			input: { decision: 'accepted' },
			kind: 'read',
		});
		assert.deepEqual(readNominationDecision({ decision: 'decline' }), {
			input: { decision: 'declined' },
			kind: 'read',
		});
	});

	test('refuses any other word 422 unknownDecision, its detail naming the two words', () => {
		const reading = readNominationDecision({ decision: 'Accept' });

		assert.equal(reading.kind, 'refused');
		assert.equal(reading.kind === 'refused' ? reading.problem.code : undefined, 'unknownDecision');
		assert.equal(reading.kind === 'refused' ? reading.problem.status : undefined, 422);
		assert.equal(reading.kind === 'refused' ? reading.problem.detail : undefined, 'decision is accept or decline.');
	});

	test('refuses a body holding another member, lacking the decision, or holding one that is no string, 400', () => {
		const readings = [
			readNominationDecision({ decision: 'accept', reason: 'yes' }),
			readNominationDecision({}),
			readNominationDecision({ decision: ['accept'] }),
		];

		assert.deepEqual(
			readings.map((reading) => (reading.kind === 'refused' ? reading.problem.status : reading.kind)),
			[400, 400, 400],
		);
	});
});
