import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readStrictJson } from './readStrictJson.js';

suite('reading JSON strictly', () => {
	test('reads JSON whose objects name each member once, at every depth', () => {
		const text = '{"a":{"a":1,"b":[{"a":"x"},{"a":"y"}]},"b":"{\\"a\\":1,\\"a\\":2}"}';

		assert.deepEqual(readStrictJson(text), {
			kind: 'read',
			value: JSON.parse(text),
		});
	});

	test('refuses an object naming a member twice, at any depth, the second written another way included', () => {
		const texts = [
			'{"a":1,"a":2}',
			'{"a":{"b":1,"b":2}}',
			'[{"a":1},{"b":1,"b":2}]',
			'{"a":1,"\\u0061":2}',
			'{"a":{"x":1},"a":2}',
		];

		texts.forEach((text) =>
			assert.deepEqual(
				readStrictJson(text),
				{ kind: 'refused', rule: 'names a member twice in one object' },
				text,
			),
		);
	});

	test('refuses a member named __proto__ at any depth', () => {
		['{"__proto__":{}}', '{"a":[{"__proto__":1}]}', '{"\\u005f_proto__":1}'].forEach((text) =>
			assert.deepEqual(readStrictJson(text), { kind: 'refused', rule: 'holds a member named __proto__' }, text),
		);
	});

	test('refuses text that is not JSON, its rule quoting none of it', () => {
		const reading = readStrictJson('{"displayName": "sent-value"');

		assert.deepEqual(reading, { kind: 'refused', rule: 'is not JSON' });
	});
});
