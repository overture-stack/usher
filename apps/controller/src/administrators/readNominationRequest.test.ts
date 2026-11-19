import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readNominationRequest } from './readNominationRequest.js';

const codeAndDetail = (body: Readonly<Record<string, unknown>>): readonly unknown[] => {
	const reading = readNominationRequest(body);
	return reading.kind === 'refused'
		? [reading.problem.status, reading.problem.code, reading.problem.detail]
		: [reading.kind];
};

suite("reading a nomination's body", () => {
	test("reads the nominee's subject exactly as given, any text included", () => {
		assert.deepEqual(
			['subject-bo', ' Bo ', ''].map((subject) => readNominationRequest({ nominee: { subject } })),
			['subject-bo', ' Bo ', ''].map((subject) => ({
				input: { nomineeSubject: subject },
				kind: 'read',
			})),
		);
	});

	test('refuses 400 a body holding a member other than nominee, or lacking it, naming what it takes', () => {
		assert.deepEqual(codeAndDetail({ nominee: { subject: 'subject-bo' }, role: 'admin' }), [
			400,
			'unreadableBody',
			'The body holds a member this operation does not take: it takes nominee alone.',
		]);
		assert.deepEqual(codeAndDetail({}), [400, 'unreadableBody', 'The body lacks the member nominee.']);
	});

	test('refuses 400 a nominee that is no object, a list or null among them', () => {
		[['subject-bo'], null, 'subject-bo', 7].forEach((nominee) =>
			assert.deepEqual(codeAndDetail({ nominee }), [
				400,
				'unreadableBody',
				'The body holds nominee as something other than an object.',
			]),
		);
	});

	test('refuses 400 a nominee naming anything beside its subject, lacking it, or holding it as no string', () => {
		assert.deepEqual(
			[
				{ email: 'bo@example.org', subject: 'subject-bo' },
				{ email: 'bo@example.org' },
				{},
				{ subject: 7 },
				{ subject: null },
			].map((nominee) => codeAndDetail({ nominee })),
			[
				[400, 'unreadableBody', 'The body holds a member of nominee other than subject.'],
				[400, 'unreadableBody', 'The body holds a member of nominee other than subject.'],
				[400, 'unreadableBody', "The body lacks nominee's subject."],
				[400, 'unreadableBody', "The body holds nominee's subject as something other than a string."],
				[400, 'unreadableBody', "The body holds nominee's subject as something other than a string."],
			],
		);
	});
});
