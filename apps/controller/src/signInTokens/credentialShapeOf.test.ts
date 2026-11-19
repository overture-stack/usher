import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { credentialShapeOf } from './credentialShapeOf.js';

// Arbitrary text in base64url, only to take the compact serializations' form: no segment is a token's
// header, payload, key or signature.
const segment = (text: string): string =>
  Buffer.from(text).toString('base64url');

const compactOf = (...texts: readonly string[]): string =>
  texts.map(segment).join('.');

// Bytes whose base64url uses both characters it holds beyond letters and digits, `-` and `_`.
const URL_SAFE_SEGMENT = Buffer.from([0xfb, 0xef, 0xff]).toString('base64url');

suite("reading a credential's shape", () => {
  test('reads an empty credential as empty', () => {
    assert.equal(credentialShapeOf(''), 'empty');
  });

  test('reads three base64url segments, the first non-empty, as a signed token, whatever they hold', () => {
    const credentials = [
      compactOf('first', 'second', 'third'),
      [URL_SAFE_SEGMENT, URL_SAFE_SEGMENT, URL_SAFE_SEGMENT].join('.'),
    ];

    credentials.forEach((credential) =>
      assert.equal(credentialShapeOf(credential), 'signedToken', credential),
    );
  });

  test('reads five base64url segments, the first non-empty, as an encrypted token, its encrypted key empty as under direct encryption or not', () => {
    const credentials = [
      compactOf('first', '', 'third', 'fourth', 'fifth'),
      compactOf('first', 'second', 'third', 'fourth', 'fifth'),
    ];

    credentials.forEach((credential) =>
      assert.equal(credentialShapeOf(credential), 'encryptedToken', credential),
    );
  });

  test('reads every other credential as opaque', () => {
    const signedShape = compactOf('first', 'second', 'third');
    const credentials = [
      'uak_example',
      `opaque-${'b41e'.repeat(8)}`,
      compactOf('first', 'second'),
      compactOf('first', 'second', 'third', 'fourth'),
      compactOf('first', 'second', 'third', 'fourth', 'fifth', 'sixth'),
      `.${compactOf('second', 'third')}`,
      `.${compactOf('second', 'third', 'fourth', 'fifth')}`,
      `${signedShape}=`,
      `${compactOf('first', 'second')}.a+b/c`,
      ` ${signedShape}`,
      `${signedShape}\n`,
      `${segment('first')}.sec ond.${segment('third')}`,
      '.',
      '..',
      '....',
    ];

    credentials.forEach((credential) =>
      assert.equal(credentialShapeOf(credential), 'opaque', credential),
    );
  });
});
