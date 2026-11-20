import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantRequestDecision } from './readGrantRequestDecision.js';

const outcomeOf = (body: Readonly<Record<string, unknown>>): unknown => {
	const reading = readGrantRequestDecision(body);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite("reading a grant request's decision", () => {
	test('reads granted and refused', () => {
		assert.deepEqual([{ decision: 'granted' }, { decision: 'refused' }].map(outcomeOf), [
			{ decision: 'granted' },
			{ decision: 'refused' },
		]);
	});

	test('refuses a body by its shape 400: no decision, one that is no string, or a member not taken', () => {
		assert.deepEqual(
			[{}, { decision: null }, { decision: ['granted'] }, { decision: 'granted', reason: 'looks fine' }].map(
				outcomeOf,
			),
			[
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
			],
		);
	});

	test('refuses any decision but granted and refused, exactly, 422 unknownDecision', () => {
		assert.deepEqual(
			['Granted', 'accepted', 'rejected', 'granted ', ''].map((decision) => outcomeOf({ decision })),
			[
				[422, 'unknownDecision'],
				[422, 'unknownDecision'],
				[422, 'unknownDecision'],
				[422, 'unknownDecision'],
				[422, 'unknownDecision'],
			],
		);
	});
});
