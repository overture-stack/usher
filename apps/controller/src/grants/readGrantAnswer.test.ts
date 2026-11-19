import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantAnswer } from './readGrantAnswer.js';

const SHOWN = ['record.count', 'record.export', 'record.view'];

const outcomeOf = (body: Readonly<Record<string, unknown>>): unknown => {
	const reading = readGrantAnswer(body);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite("reading a holder's answer to a grant", () => {
	test('reads an acceptance and a decline, with the capabilities shown as sent', () => {
		assert.deepEqual(
			[
				outcomeOf({ capabilities: SHOWN, decision: 'accepted' }),
				outcomeOf({ capabilities: [], decision: 'rejected' }),
			],
			[
				{ capabilities: SHOWN, decision: 'accepted' },
				{ capabilities: [], decision: 'rejected' },
			],
		);
	});

	test('refuses 400 an answer lacking either member, holding another, or holding one of another type', () => {
		const unreadable = [
			{ capabilities: SHOWN },
			{ decision: 'accepted' },
			{ capabilities: SHOWN, decision: true },
			{ capabilities: 'record.view', decision: 'accepted' },
			{ capabilities: [7], decision: 'accepted' },
			{ capabilities: SHOWN, decision: 'accepted', grantId: 'g' },
		];

		assert.deepEqual(
			unreadable.map(outcomeOf),
			unreadable.map(() => [400, 'unreadableBody']),
		);
	});

	test('refuses 422 any decision but accepted and rejected, in their letter case', () => {
		const words = ['accept', 'ACCEPTED', 'pending', 'revoked', 'expired', ''];

		assert.deepEqual(
			words.map((decision) => outcomeOf({ capabilities: SHOWN, decision })),
			words.map(() => [422, 'unknownDecision']),
		);
	});
});
