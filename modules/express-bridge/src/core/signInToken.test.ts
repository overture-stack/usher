import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { isLocallyExpired, readSignedToken } from './signInToken.js';

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const signedToken = (claims: unknown): string =>
  `${segment({ alg: 'RS256' })}.${segment(claims)}.c2lnbmF0dXJl`;

suite('readSignedToken', () => {
  test('reads exp and sub from a three-part signed token', () => {
    const claims = readSignedToken(
      signedToken({ exp: 1_767_225_900, sub: 'subject-ana' }),
    );

    assert.deepEqual(claims, { exp: 1_767_225_900, subject: 'subject-ana' });
  });

  test('reads no claim it cannot use: a non-numeric exp or a non-string sub', () => {
    const claims = readSignedToken(signedToken({ exp: '1767225900', sub: 7 }));

    assert.deepEqual(claims, { exp: undefined, subject: undefined });
  });

  for (const [description, credential] of [
    ['an opaque API key', 'uak_3f9d2c7b1e8a4f6d'],
    [
      'a five-part token whose second segment holds claims',
      `${segment({ alg: 'dir' })}.${segment({ exp: 1 })}.aXY.Y2lwaGVy.dGFn`,
    ],
    ['a payload that is not JSON', `${segment({})}.bm90IGpzb24.c2ln`],
    ['a payload that is a list', signedToken([{ exp: 1 }])],
    ['a payload that is null', signedToken(null)],
    [
      'a segment outside base64url',
      `${segment({})}.${segment({ exp: 1 })}+.c2ln`,
    ],
  ] as const) {
    test(`reads ${description} as opaque`, () => {
      assert.equal(readSignedToken(credential), undefined);
    });
  }
});

suite('isLocallyExpired', () => {
  const claims = { exp: 1_000, subject: 'subject-ana' };

  test('refuses a token from exactly its exp plus the tolerance', () => {
    assert.equal(isLocallyExpired(claims, 1_000_000 + 60_000, 60_000), true);
  });

  test('passes a token 1 ms before its exp plus the tolerance on to the exchange', () => {
    assert.equal(isLocallyExpired(claims, 1_000_000 + 59_999, 60_000), false);
  });

  test('treats a token carrying no exp as unexpired', () => {
    assert.equal(
      isLocallyExpired({ exp: undefined, subject: undefined }, 9e15, 0),
      false,
    );
  });
});
