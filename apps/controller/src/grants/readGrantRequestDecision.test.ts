import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantRequestDecision } from './readGrantRequestDecision.js';

const outcomeOf = (body: Readonly<Record<string, unknown>>): unknown => {
	const reading = readGrantRequestDecision(body);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite("reading a grant request's decision", () => {
	test('reads grant and decline as granted and declined', () => {
		assert.deepEqual([{ decision: 'grant' }, { decision: 'decline' }].map(outcomeOf), [
			{ decision: 'granted' },
			{ decision: 'declined' },
		]);
	});

	test('refuses a body by its shape 400: no decision, one that is no string, or a member not taken', () => {
		assert.deepEqual(
			[{}, { decision: null }, { decision: ['grant'] }, { decision: 'grant', reason: 'looks fine' }].map(
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

	test('refuses any decision but grant and decline, exactly, 422 unknownDecision', () => {
		assert.deepEqual(
			['Grant', 'granted', 'refused', 'grant ', ''].map((decision) => outcomeOf({ decision })),
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
