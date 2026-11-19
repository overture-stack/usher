import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { queryNamesOf, queryParametersOf, readCredential } from './credential.js';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJl';

suite("reading a request's credential", () => {
	test('reads one Bearer credential, the scheme in any letter case', () => {
		const read = ['Bearer', 'bearer', 'BEARER'].map((scheme) =>
			readCredential(['Authorization', `${scheme} ${TOKEN}`], []),
		);

		read.forEach((credential) => assert.deepEqual(credential, { kind: 'bearer', token: TOKEN }));
	});

	test('reads no credential from a request with no Authorization header', () => {
		assert.deepEqual(readCredential(['Accept', 'application/json'], []), {
			kind: 'absent',
		});
	});

	test('refuses two Authorization headers, whatever each holds', () => {
		assert.deepEqual(readCredential(['authorization', `Bearer ${TOKEN}`, 'Authorization', `Bearer ${TOKEN}`], []), {
			kind: 'malformed',
		});
	});

	test('refuses another scheme, a scheme with no credential, and a credential holding a space', () => {
		const values = [`Basic ${TOKEN}`, 'Bearer', 'Bearer ', `Bearer ${TOKEN} x`];

		values.forEach((value) =>
			assert.deepEqual(readCredential(['Authorization', value], []), { kind: 'malformed' }, value),
		);
	});

	test('refuses a credential sent in the query, with or without a header beside it', () => {
		assert.deepEqual(readCredential([], ['access_token']), {
			kind: 'malformed',
		});
		assert.deepEqual(readCredential(['Authorization', `Bearer ${TOKEN}`], ['access_token']), { kind: 'malformed' });
	});
});

suite("reading a request's query parameter names", () => {
	test('names each parameter as often as it is sent, and none for a target without a query', () => {
		assert.deepEqual(queryNamesOf('/admin/applications?a=1&b=2&a=3'), ['a', 'b', 'a']);
		assert.deepEqual(queryNamesOf('/admin/applications'), []);
		assert.deepEqual(queryNamesOf('/admin/applications?'), []);
	});

	test("reads a query's parameters decoded, in the order sent, one sent twice listed twice", () => {
		assert.deepEqual(queryParametersOf('/admin/resources?limit=2&cursor=a%2Bb+c&limit=&flag'), [
			['limit', '2'],
			['cursor', 'a+b c'],
			['limit', ''],
			['flag', ''],
		]);
		assert.deepEqual(queryParametersOf('/admin/resources'), []);
	});
});
