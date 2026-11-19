import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readExchangeRequest } from './readExchangeRequest.js';

const JSON_TYPE = 'application/json';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const reading = (body: string | Uint8Array | undefined, contentType: string | undefined = JSON_TYPE) =>
	readExchangeRequest({
		body: typeof body === 'string' ? bytesOf(body) : body,
		contentType,
	});

const refusalOf = (
	body: string | Uint8Array | undefined,
	contentType?: string,
): { code: string; detail: string; status: number } => {
	const read = reading(body, contentType);
	return read.kind === 'refused'
		? {
				code: read.problem.code,
				detail: read.problem.detail,
				status: read.problem.status,
			}
		: assert.fail('the request was read');
};

interface RefusedCase {
	body: string | Uint8Array | undefined;
	contentType?: string;
	name: string;
}

suite('reading an exchange request', () => {
	test('reads a body listing payload version 1 and carrying no credential as the anonymous exchange', () => {
		assert.deepEqual(reading('{"payloadVersions":[1]}'), { kind: 'read' });
	});

	test('reads a credential as given, an empty one included, whatever it holds', () => {
		const credentials = ['', 'uak_example', 'a.b.c', ' spaced   '];

		assert.deepEqual(
			credentials.map((credential) => reading(JSON.stringify({ credential, payloadVersions: [1] }))),
			credentials.map((credential) => ({ credential, kind: 'read' })),
		);
	});

	test('reads a body listing version 1 among others, in any order and more than once', () => {
		const listed = [
			[1, 2],
			[2, 1],
			[1, 1],
			[3, 2, 1],
		];

		assert.deepEqual(
			listed.map((payloadVersions) => reading(JSON.stringify({ payloadVersions }))),
			listed.map(() => ({ kind: 'read' })),
		);
	});

	test('ignores every member other than credential and payloadVersions', () => {
		assert.deepEqual(
			reading(
				JSON.stringify({
					aud: 'another-application',
					audience: 'another-application',
					credential: 'uak_example',
					payloadVersions: [1],
					sub: null,
				}),
			),
			{ credential: 'uak_example', kind: 'read' },
		);
	});

	test('reads JSON whatever the letter case of its media type, with or without a UTF-8 charset', () => {
		const types = ['Application/JSON', 'application/json; charset=utf-8', 'application/json;charset="UTF-8"'];

		assert.deepEqual(
			types.map((contentType) => reading('{"payloadVersions":[1]}', contentType)),
			types.map(() => ({ kind: 'read' })),
		);
	});

	test('refuses with 406 a body whose payloadVersions lists no version served', () => {
		const listed = [[2], [2, 3]];

		assert.deepEqual(
			listed.map((payloadVersions) => refusalOf(JSON.stringify({ payloadVersions }))),
			listed.map(() => ({
				code: 'payloadVersionUnserved',
				detail: 'List payload version 1 in payloadVersions.',
				status: 406,
			})),
		);
	});

	test('refuses with 400 a body unreadable by its shape, naming the rule it broke', () => {
		const cases: readonly RefusedCase[] = [
			{ body: undefined, name: 'no body' },
			{ body: '', name: 'an empty body' },
			{
				body: '{"payloadVersions":[1]}',
				contentType: 'text/plain',
				name: 'another media type',
			},
			{
				body: '{"payloadVersions":[1]}',
				contentType: 'application/json; charset=iso-8859-1',
				name: 'another charset',
			},
			{ body: new Uint8Array([0x7b, 0xff, 0x7d]), name: 'bytes not UTF-8' },
			{ body: '{"credential":', name: 'text that is not JSON' },
			{ body: '[1]', name: 'a JSON array' },
			{ body: '"payloadVersions"', name: 'a JSON string' },
			{ body: 'null', name: 'JSON null' },
			{
				body: '{"payloadVersions":[1],"payloadVersions":[2]}',
				name: 'a member named twice',
			},
			{
				body: '{"__proto__":{},"payloadVersions":[1]}',
				name: 'a __proto__ member',
			},
			{ body: '{"credential":"uak_example"}', name: 'payloadVersions absent' },
			{ body: '{"payloadVersions":[]}', name: 'payloadVersions []' },
			{ body: '{"payloadVersions":["1"]}', name: 'payloadVersions ["1"]' },
			{ body: '{"payloadVersions":[1.5]}', name: 'payloadVersions [1.5]' },
			{ body: '{"payloadVersions":[0]}', name: 'payloadVersions [0]' },
			{ body: '{"payloadVersions":[-1]}', name: 'payloadVersions [-1]' },
			{
				body: '{"payloadVersions":[1,null]}',
				name: 'payloadVersions [1, null]',
			},
			{ body: '{"payloadVersions":1}', name: 'payloadVersions 1' },
			{
				body: '{"payloadVersions":{"0":1}}',
				name: 'payloadVersions an object',
			},
			{
				body: '{"credential":42,"payloadVersions":[1]}',
				name: 'credential as a number',
			},
			{
				body: '{"credential":null,"payloadVersions":[1]}',
				name: 'credential as null',
			},
			{
				body: '{"credential":{"token":"t"},"payloadVersions":[1]}',
				name: 'credential as an object',
			},
			{
				body: '{"credential":42,"payloadVersions":[2]}',
				name: 'credential as a number beside a version unserved',
			},
		];

		const refusals = cases.map(({ body, contentType }) => refusalOf(body, contentType));

		cases.forEach(({ name }, index) => {
			assert.equal(refusals[index]?.status, 400, name);
			assert.equal(refusals[index]?.code, 'unreadableBody', name);
		});
		assert.deepEqual([...new Set(refusals.map(({ detail }) => detail))].toSorted(), [
			'The body holds a member named __proto__.',
			'The body holds credential as something other than a string.',
			'The body holds payloadVersions as something other than a non-empty list of whole numbers of at least 1.',
			'The body is not JSON.',
			'The body is not UTF-8.',
			'The body is not application/json in UTF-8.',
			'The body is not one JSON object.',
			'The body lacks the member payloadVersions.',
			'The body names a member twice in one object.',
		]);
	});

	test('never quotes in a refusal what the body held', () => {
		const marker = 'f00d-credential-marker';

		const refusals = [
			`{"credential":{"value":"${marker}"},"payloadVersions":[1]}`,
			`{"credential":"${marker}","payloadVersions":["${marker}"]}`,
			`{"${marker}":1,"${marker}":2}`,
			`{"credential":"${marker}"`,
		].map((body) => refusalOf(body));

		refusals.forEach(({ detail }) => assert.equal(detail.includes(marker), false, detail));
	});
});
