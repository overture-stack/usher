import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { suite, test } from 'node:test';

import { decodeProtectedHeader, jwtVerify } from 'jose';

import { createChannelAssertion } from './channelAssertion.js';
import { importApplicationKey, SUBKEY_LABELS } from './keys.js';
import { TEST_KEY, TEST_KEY_BYTES } from './testTokens.js';

const AUDIENCE = 'arranger-search';
const NOW_MS = 1_767_225_600_500;

/** The assertion key as the controller derives it, from the application named by `iss`. */
const controllerKey = new Uint8Array(
  hkdfSync(
    'sha256',
    TEST_KEY_BYTES,
    new Uint8Array(0),
    SUBKEY_LABELS.channelAssertion,
    32,
  ),
);

const assertionAt = async (nowMs = NOW_MS) =>
  createChannelAssertion({
    application: AUDIENCE,
    assertionKey: (await importApplicationKey(TEST_KEY)).channelAssertionKey,
    wallClock: { now: () => nowMs },
  });

suite('createChannelAssertion', () => {
  test('signs an assertion the controller verifies under the key it derives for the application', async () => {
    const sign = await assertionAt();

    const { payload, protectedHeader } = await jwtVerify(
      await sign(),
      controllerKey,
      {
        algorithms: ['HS256'],
        audience: 'usher:controller',
        currentDate: new Date(NOW_MS),
        issuer: AUDIENCE,
        typ: 'usher-channel+jwt',
      },
    );

    assert.deepEqual(protectedHeader, {
      alg: 'HS256',
      typ: 'usher-channel+jwt',
    });
    assert.equal(payload.iat, Math.floor(NOW_MS / 1000));
    assert.equal(payload.exp, Math.floor(NOW_MS / 1000) + 60);
    assert.equal(typeof payload.jti, 'string');
  });

  test('gives every assertion its own jti', async () => {
    const sign = await assertionAt();

    const tokens = await Promise.all([sign(), sign(), sign()]);
    const identifiers = await Promise.all(
      tokens.map(async (token) => {
        const { payload } = await jwtVerify(token, controllerKey, {
          currentDate: new Date(NOW_MS),
        });
        return payload.jti;
      }),
    );

    assert.equal(new Set(identifiers).size, 3);
  });

  test('carries no kid, which arrives only with key rotation', async () => {
    const sign = await assertionAt();

    const header = decodeProtectedHeader(await sign());

    assert.equal(Object.hasOwn(header, 'kid'), false);
  });

  test('fails verification under the raw application key, which signs nothing itself', async () => {
    const sign = await assertionAt();

    await assert.rejects(
      jwtVerify(await sign(), TEST_KEY_BYTES, {
        currentDate: new Date(NOW_MS),
      }),
    );
  });

  test('expires 60 s after it is issued', async () => {
    const sign = await assertionAt();
    const token = await sign();

    await assert.rejects(
      jwtVerify(token, controllerKey, {
        currentDate: new Date(NOW_MS - 500 + 60_000),
      }),
      { code: 'ERR_JWT_EXPIRED' },
    );
  });
});
