import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { tokenDigestOf } from './tokenDigestOf.js';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJl';

suite("a token's digest", () => {
  test('is the SHA-256 of the whole token as base64url, the same each time it is taken', () => {
    // FIPS 180-2's first SHA-256 example, the message "abc".
    assert.equal(
      tokenDigestOf('abc'),
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    );
    assert.equal(tokenDigestOf(TOKEN), tokenDigestOf(TOKEN));
  });

  test('differs for a token differing in its signature alone', () => {
    assert.notEqual(tokenDigestOf(TOKEN), tokenDigestOf(`${TOKEN}x`));
  });

  test('holds no segment of the token', () => {
    const digest = tokenDigestOf(TOKEN);

    assert.ok(TOKEN.split('.').every((segment) => !digest.includes(segment)));
  });
});
