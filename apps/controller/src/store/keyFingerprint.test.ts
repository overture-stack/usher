import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import { keyFingerprint } from './keyFingerprint.js';

const freshKey = (): string => randomBytes(32).toString('base64url');

// The bytes 0 to 31, and their HKDF-SHA256 subkey under the label
// `usher/v1/key-encryption-key-fingerprint` with no salt, computed apart from the Controller's code.
const KNOWN_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KNOWN_FINGERPRINT = 'e8cf12da9a0429b8797e951e948ebc2d3db43f09db6d890867f92355819f6f42';

suite("the key-encryption key's fingerprint", () => {
	test('derives 32 bytes, the same from the same key and others from another key', () => {
		const key = freshKey();

		const first = keyFingerprint(key);
		const again = keyFingerprint(key);
		const other = keyFingerprint(freshKey());

		assert.equal(first.length, 32);
		assert.deepEqual(again, first);
		assert.notDeepEqual(other, first);
	});

	test('derives the HKDF-SHA256 subkey of the key under the label usher/v1/key-encryption-key-fingerprint, with no salt, so every release derives the fingerprint recorded by a store', () => {
		assert.equal(keyFingerprint(KNOWN_KEY).toString('hex'), KNOWN_FINGERPRINT);
	});

	test('shows nothing of the key, in its bytes or in any encoding of them', () => {
		const key = freshKey();
		const bytes = Buffer.from(key, 'base64url');

		const fingerprint = keyFingerprint(key);
		const shown = [
			fingerprint.toString('hex'),
			fingerprint.toString('base64'),
			fingerprint.toString('base64url'),
		].join('\n');

		assert.notDeepEqual(fingerprint, bytes);
		[key, bytes.toString('hex'), bytes.toString('base64')].forEach((form) =>
			assert.equal(shown.includes(form), false),
		);
	});
});
