import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readPollQuery } from './readPollQuery.js';

const NONCE = 'AbCdEfGhIjKlMnOp_-12';

const CURSOR = 'Zm9vYmFyLWN1cnNvcg';

suite("a poll's query", () => {
  test('reads a head poll and a poll after a cursor, each with its nonce', () => {
    assert.deepEqual(readPollQuery(`/notices?head=true&nonce=${NONCE}`), {
      nonce: NONCE,
      start: { kind: 'head' },
    });
    assert.deepEqual(readPollQuery(`/notices?after=${CURSOR}&nonce=${NONCE}`), {
      nonce: NONCE,
      start: { cursor: CURSOR, kind: 'after' },
    });
  });

  test('reads every value percent-decoded, in any order', () => {
    const encoded = [...CURSOR]
      .map((character) => `%${character.charCodeAt(0).toString(16)}`)
      .join('');

    assert.deepEqual(
      readPollQuery(`/notices?nonce=${NONCE}&after=${encoded}`),
      { nonce: NONCE, start: { cursor: CURSOR, kind: 'after' } },
    );
  });

  test('reads nonces of 16 and of 128 base64url characters', () => {
    ['a'.repeat(16), 'Z_-9'.repeat(32)].forEach((nonce) => {
      assert.equal(
        readPollQuery(`/notices?head=true&nonce=${nonce}`)?.nonce,
        nonce,
      );
    });
  });

  test('reads no query naming no starting point or both, a head other than true, or an empty after', () => {
    [
      `/notices?nonce=${NONCE}`,
      `/notices?after=${CURSOR}&head=true&nonce=${NONCE}`,
      `/notices?head=false&nonce=${NONCE}`,
      `/notices?head=TRUE&nonce=${NONCE}`,
      `/notices?head=&nonce=${NONCE}`,
      `/notices?after=&nonce=${NONCE}`,
      '/notices',
    ].forEach((url) => {
      assert.equal(readPollQuery(url), undefined, url);
    });
  });

  test('reads no query without a nonce of 16 to 128 base64url characters', () => {
    [
      '/notices?head=true',
      '/notices?head=true&nonce=',
      `/notices?head=true&nonce=${'a'.repeat(15)}`,
      `/notices?head=true&nonce=${'a'.repeat(129)}`,
      `/notices?head=true&nonce=${encodeURIComponent('abcdefghijklmno+')}`,
      `/notices?head=true&nonce=${encodeURIComponent('abcdefghijklmno/')}`,
      `/notices?head=true&nonce=${encodeURIComponent('abcdefghijklmn==')}`,
      '/notices?head=true&nonce=abcdefghijklmno+',
    ].forEach((url) => {
      assert.equal(readPollQuery(url), undefined, url);
    });
  });

  test('reads no query repeating a parameter or naming one the poll does not take', () => {
    [
      `/notices?after=${CURSOR}&after=${CURSOR}&nonce=${NONCE}`,
      `/notices?head=true&nonce=${NONCE}&nonce=${NONCE}`,
      `/notices?head=true&head=true&nonce=${NONCE}`,
      `/notices?head=true&nonce=${NONCE}&limit=5`,
      `/notices?head=true&nonce=${NONCE}&After=${CURSOR}`,
    ].forEach((url) => {
      assert.equal(readPollQuery(url), undefined, url);
    });
  });
});
