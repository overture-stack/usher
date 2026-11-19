import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { canonicalJson } from './canonicalJson.js';

suite('the canonical form of a JSON value', () => {
	test('sorts every object key, at any depth, and keeps the order of arrays', () => {
		assert.equal(
			canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 'x'], c: null } }),
			'{"a":{"c":null,"d":[{"y":2,"z":1},"x"]},"b":1}',
		);
	});

	test('reads the same value whatever order its object keys were written in, and the same whitespace', () => {
		const written = JSON.parse('{"issuer":"https://usher.example.org","eventSource":"e"}') as unknown;
		const reordered = JSON.parse('{\n\t"eventSource": "e",\n\t"issuer": "https://usher.example.org"\n}') as unknown;

		assert.equal(canonicalJson(written), canonicalJson(reordered));
	});

	test('writes strings, numbers, booleans and null as JSON writes them', () => {
		assert.equal(canonicalJson('a"b '), JSON.stringify('a"b '));
		assert.equal(canonicalJson([0, -0.5, 1e21, 1.25, true, false, null]), '[0,-0.5,1e+21,1.25,true,false,null]');
	});

	test('throws on a value JSON cannot hold, at any depth: a non-finite number, undefined, a function, or an object that is not plain', () => {
		const refused: readonly unknown[] = [
			Number.NaN,
			{ a: Number.POSITIVE_INFINITY },
			[Number.NEGATIVE_INFINITY],
			undefined,
			{ a: undefined },
			() => undefined,
			new Date(0),
			new Map(),
			new (class Holder {})(),
		];

		refused.forEach((value) => {
			assert.throws(() => canonicalJson(value), TypeError);
		});
	});
});
