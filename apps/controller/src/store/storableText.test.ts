import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { holdsUnstorableText, isStorableText } from './storableText.js';

suite('text that can be stored', () => {
	test('takes text beyond the Basic Multilingual Plane, its surrogates paired', () => {
		assert.equal(isStorableText('Étude 🧬 pulmonaire'), true);
	});

	test('refuses a NUL character, and an unpaired surrogate of either half', () => {
		['a\u0000b', 'a\uD83Eb', 'a\uDDECb', '\uDDEC\uD83E'].forEach((text) =>
			assert.equal(isStorableText(text), false, JSON.stringify(text)),
		);
	});

	test('finds unstorable text in a value at any depth, a member name included', () => {
		assert.equal(holdsUnstorableText({ a: [{ b: 'ok' }], c: 1 }), false);
		assert.equal(holdsUnstorableText({ a: [{ b: 'x\u0000' }] }), true);
		assert.equal(holdsUnstorableText({ 'x\uD800': 'ok' }), true);
		assert.equal(holdsUnstorableText(['\uDC00']), true);
	});
});
