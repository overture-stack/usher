import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { createApplicationKeyCipher } from './createApplicationKeyCipher.js';

const freshKey = (): string => randomBytes(32).toString('base64url');

const identity = () => ({ applicationId: randomUUID(), keyId: randomUUID() });

suite("sealing an application's key for the store", () => {
	test('opens a sealed key again under the same key-encryption key and identity', () => {
		const cipher = createApplicationKeyCipher(freshKey());
		const bound = identity();
		const key = randomBytes(32);

		const opened = cipher.open(bound, cipher.seal(bound, key));

		assert.deepEqual(opened, key);
	});

	test("holds none of the key's bytes in what it seals, and seals one key differently each time", () => {
		const cipher = createApplicationKeyCipher(freshKey());
		const bound = identity();
		const key = randomBytes(32);

		const first = cipher.seal(bound, key);
		const second = cipher.seal(bound, key);

		assert.equal(first.includes(key), false);
		assert.equal(first.includes(key.subarray(0, 8)), false);
		assert.notDeepEqual(first, second);
	});

	test('refuses to open a sealed key bound to another application or another key, as one copied onto another row is', () => {
		const cipher = createApplicationKeyCipher(freshKey());
		const bound = identity();
		const sealed = cipher.seal(bound, randomBytes(32));

		assert.equal(cipher.open({ ...bound, applicationId: randomUUID() }, sealed), undefined);
		assert.equal(cipher.open({ ...bound, keyId: randomUUID() }, sealed), undefined);
	});

	test('refuses to open a sealed key altered in any one bit, cut short, or lengthened', () => {
		const cipher = createApplicationKeyCipher(freshKey());
		const bound = identity();
		const sealed = cipher.seal(bound, randomBytes(32));
		const flipped = (index: number): Buffer => {
			const copy = Buffer.from(sealed);
			copy[index] = (copy[index] ?? 0) ^ 1;
			return copy;
		};

		const altered = [
			...Array.from({ length: sealed.length }, (_, index) => flipped(index)),
			sealed.subarray(0, -1),
			Buffer.concat([sealed, Buffer.of(0)]),
		];

		altered.forEach((candidate, index) =>
			assert.equal(cipher.open(bound, candidate), undefined, `alteration ${index}`),
		);
	});

	test('refuses to open under another key-encryption key', () => {
		const bound = identity();
		const sealed = createApplicationKeyCipher(freshKey()).seal(bound, randomBytes(32));

		assert.equal(createApplicationKeyCipher(freshKey()).open(bound, sealed), undefined);
	});

	test('refuses to seal a key of any length but 32 bytes', () => {
		const cipher = createApplicationKeyCipher(freshKey());

		[0, 16, 31, 33].forEach((length) =>
			assert.throws(() => cipher.seal(identity(), randomBytes(length)), RangeError),
		);
	});
});
