import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import { applicationSubkeys, SUBKEY_LABELS } from './applicationSubkeys.js';

const KEY_BYTES = randomBytes(32);

// A subkey's bytes as the bridge derives them from the application key's bytes.
const bridgeSubkey = (label: string): Buffer =>
  Buffer.from(hkdfSync('sha256', KEY_BYTES, Buffer.alloc(0), label, 32));

suite('the subkeys of an application key', () => {
  test("are labelled as the bridge labels them, one label for each use, the Usher token's included", () => {
    assert.deepEqual(SUBKEY_LABELS, {
      channelAssertion: 'usher/v1/channel-assertion',
      notice: 'usher/v1/notice-encryption',
      pollAnswer: 'usher/v1/poll-answer',
      subjectTag: 'usher/v1/subject-tag',
      token: 'usher/v1/token-encryption',
    });
    assert.equal(Object.isFrozen(SUBKEY_LABELS), true);
  });

  test('are each derived as the bridge derives it: HKDF-SHA256 over the key, with an empty salt and its own label', () => {
    const subkeys = applicationSubkeys(KEY_BYTES);

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(subkeys).map(([use, subkey]) => [use, subkey.export()]),
      ),
      Object.fromEntries(
        Object.entries(SUBKEY_LABELS).map(([use, label]) => [
          use,
          bridgeSubkey(label),
        ]),
      ),
    );
  });

  test('keep the token subkey a 32-byte secret key, apart from the application key and from every other subkey', () => {
    const subkeys = applicationSubkeys(KEY_BYTES);

    const held = [
      KEY_BYTES,
      ...Object.values(subkeys).map((subkey) => subkey.export()),
    ].map((bytes) => bytes.toString('base64url'));

    assert.equal(subkeys.token.type, 'secret');
    assert.equal(subkeys.token.symmetricKeySize, 32);
    assert.equal(held.length, 6);
    assert.equal(new Set(held).size, held.length);
  });
});
