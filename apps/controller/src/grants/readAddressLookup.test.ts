import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readAddressLookup } from './readAddressLookup.js';

const outcomeOf = (body: Readonly<Record<string, unknown>> | undefined): unknown => {
	const reading = readAddressLookup(body);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite('reading an address lookup', () => {
	test('reads an address exactly as given, its letter case, plus-addressing and non-ASCII text kept', () => {
		const addresses = ['Sub.Bo@Example.ORG', 'bo+ims@example.org', 'zoë@example.org'];

		assert.deepEqual(
			addresses.map((email) => outcomeOf({ email })),
			addresses.map((email) => ({ email })),
		);
	});

	test("refuses 422 addressForm an address out of an address's form", () => {
		const malformed = [
			'',
			'bo',
			'bo@',
			'@example.org',
			'a@b@example.org',
			' sub.bo@example.org',
			'sub.bo@example.org ',
			'sub.bo@example.org\n',
			'a@example.org,b@example.org',
		];

		assert.deepEqual(
			malformed.map((email) => outcomeOf({ email })),
			malformed.map(() => [422, 'addressForm']),
		);
	});

	test('refuses 400 no body, a body lacking its address, holding another member, or an address that is no string', () => {
		const unreadable = [
			undefined,
			{},
			{ email: 'sub.bo@example.org', subject: 'subject-bo' },
			{ email: null },
			{ email: ['a@example.org', 'b@example.org'] },
		];

		assert.deepEqual(
			unreadable.map(outcomeOf),
			unreadable.map(() => [400, 'unreadableBody']),
		);
	});
});
