import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readHolder } from './readHolder.js';

const codeOf = (value: unknown): unknown => {
	const reading = readHolder(value, 'holder');
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.holder;
};

suite('reading a holder', () => {
	test('reads a person named by subject, or by address, as given', () => {
		assert.deepEqual(
			[codeOf({ subject: 'subject-cy' }), codeOf({ email: 'Sub.Bo@Example.ORG' })],
			[
				{ kind: 'subject', subject: 'subject-cy' },
				{ email: 'Sub.Bo@Example.ORG', kind: 'address' },
			],
		);
	});

	test('refuses 400 a holder that is no object, and a subject or an address that is no string', () => {
		const unreadable = [
			'subject-cy',
			['subject-cy'],
			null,
			{ subject: 7 },
			{ email: ['a@example.org', 'b@example.org'] },
			{ email: null },
		];

		assert.deepEqual(
			unreadable.map(codeOf),
			unreadable.map(() => [400, 'unreadableBody']),
		);
	});

	test('refuses 422 a holder naming other than exactly one person, a group or an empty subject among them', () => {
		const departures = [
			{},
			{ group: 'study-a1-team' },
			{ email: 'cy@example.org', subject: 'subject-cy' },
			{ group: 'study-a1-team', subject: 'subject-cy' },
			{ subject: '' },
		];

		assert.deepEqual(
			departures.map(codeOf),
			departures.map(() => [422, 'holderNotOnePerson']),
		);
	});

	test("refuses 422 an address not in an address's form", () => {
		const malformed = [
			'',
			'bo',
			'bo@',
			'@example.org',
			'sub.bo',
			' sub.bo@example.org',
			'sub.bo@example.org ',
			'sub.bo@example.org\n',
			'a@example.org,b@example.org',
			'a@b@example.org',
		];

		assert.deepEqual(
			malformed.map((email) => codeOf({ email })),
			malformed.map(() => [422, 'addressForm']),
		);
	});

	test('reads every address of the form, whether the directory holds it or not', () => {
		const wellFormed = [
			'sub.bo@example.org',
			'sub.bo@example',
			's*@example.org',
			'%@example.org',
			'_ub.bo@example.org',
			'zoë@example.org',
			'bo+ims@example.org',
		];

		assert.deepEqual(
			wellFormed.map((email) => codeOf({ email })),
			wellFormed.map((email) => ({ email, kind: 'address' })),
		);
	});
});
