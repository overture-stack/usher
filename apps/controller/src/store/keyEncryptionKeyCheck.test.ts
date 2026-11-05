import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import { keyEncryptionKeyCheckValue } from './keyEncryptionKeyCheck.js';

const freshKey = (): string => randomBytes(32).toString('base64url');

suite("the key-encryption key's check value", () => {
  test('derives 32 bytes, the same from the same key and others from another key', () => {
    const key = freshKey();

    const first = keyEncryptionKeyCheckValue(key);
    const again = keyEncryptionKeyCheckValue(key);
    const other = keyEncryptionKeyCheckValue(freshKey());

    assert.equal(first.length, 32);
    assert.deepEqual(again, first);
    assert.notDeepEqual(other, first);
  });

  test('shows nothing of the key, in its bytes or in any encoding of them', () => {
    const key = freshKey();
    const bytes = Buffer.from(key, 'base64url');

    const checkValue = keyEncryptionKeyCheckValue(key);
    const shown = [
      checkValue.toString('hex'),
      checkValue.toString('base64'),
      checkValue.toString('base64url'),
    ].join('\n');

    assert.notDeepEqual(checkValue, bytes);
    [key, bytes.toString('hex'), bytes.toString('base64')].forEach((form) =>
      assert.equal(shown.includes(form), false),
    );
  });
});
