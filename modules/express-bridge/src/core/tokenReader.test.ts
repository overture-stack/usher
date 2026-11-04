import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
  type NonEmpty,
  type PermissionsPayload,
  validatePayload,
} from '@overture-stack/usher-types';
import { SignJWT } from 'jose';

import { importApplicationKey } from './keys.js';
import { mintUsherToken, TEST_KEY } from './testTokens.js';
import { createTokenReader } from './tokenReader.js';

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../.dev/design/conformance/principals.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { principals: readonly { case: string; payload: unknown }[] };

const payloadFor = (caseNumber: string): PermissionsPayload => {
  const entry = corpus.principals.find(
    (principal) => principal.case === caseNumber,
  );
  const result = validatePayload(entry?.payload);
  assert.ok(result.success, `case ${caseNumber} is a valid payload`);
  return result.payload;
};

const ANA = { ...payloadFor('05'), sub: 'subject-ana' };
const AUDIENCE = ANA.aud;
const ISSUER = ANA.iss;

const readerAt = async (
  wallMs = ANA.iat * 1000,
  payloadVersions: NonEmpty<number> = [1],
) =>
  createTokenReader({
    audience: AUDIENCE,
    issuer: ISSUER,
    payloadVersions,
    tokenKey: (await importApplicationKey(TEST_KEY)).tokenKey,
    wallClock: { now: () => wallMs },
  });

const reasonFor = async (
  token: string,
  reader?: Awaited<ReturnType<typeof readerAt>>,
): Promise<unknown> => {
  const reading = await (reader ?? (await readerAt())).read(token);
  return reading.kind === 'rejected' ? reading.reason : 'accepted';
};

suite('createTokenReader', () => {
  test('reads a token the controller minted to the validated payload, sub included', async () => {
    const reader = await readerAt();

    const reading = await reader.read(await mintUsherToken(ANA));

    assert.deepEqual(reading, { kind: 'payload', payload: ANA });
  });

  test('reads an anonymous token, keeping its null subject', async () => {
    const reader = await readerAt();
    const anonymous = payloadFor('02');

    const reading = await reader.read(await mintUsherToken(anonymous));

    assert.deepEqual(reading, { kind: 'payload', payload: anonymous });
  });

  test('accepts a token 1 ms before its exp, and rejects it at that instant, with no tolerance', async () => {
    const token = await mintUsherToken(ANA);

    const before = await reasonFor(token, await readerAt(ANA.exp * 1000 - 1));
    const at = await reasonFor(token, await readerAt(ANA.exp * 1000));

    assert.deepEqual([before, at], ['accepted', 'expired']);
  });

  test('gives two mints of one payload different IV segments', async () => {
    const [first, second] = await Promise.all([
      mintUsherToken(ANA),
      mintUsherToken(ANA),
    ]);

    assert.notEqual(first.split('.')[2], second.split('.')[2]);
  });

  suite('the header, before decryption', () => {
    for (const [description, header] of [
      ['a typ of JWT', { typ: 'JWT' }],
      ['a typ differing only in case', { typ: 'USHER+JWT' }],
      ['a typ with the media-type prefix', { typ: 'application/usher+jwt' }],
    ] as const) {
      test(`rejects ${description} as headerType`, async () => {
        assert.equal(
          await reasonFor(await mintUsherToken(ANA, { header })),
          'headerType',
        );
      });
    }

    for (const [description, header] of [
      ['a cty', { cty: 'JWT' }],
      ['a kid, which joins only with rotation', { kid: 'k1' }],
    ] as const) {
      test(`rejects a header carrying ${description} as headerMember`, async () => {
        assert.equal(
          await reasonFor(await mintUsherToken(ANA, { header })),
          'headerMember',
        );
      });
    }

    test('rejects text that is no token as headerUnreadable', async () => {
      assert.equal(await reasonFor('not.a.token'), 'headerUnreadable');
    });
  });

  suite('the algorithms and the key', () => {
    test('rejects a key-wrapping algorithm, even under the application key, as algorithmNotAllowed', async () => {
      const token = await mintUsherToken(ANA, { header: { alg: 'A256KW' } });

      assert.equal(await reasonFor(token), 'algorithmNotAllowed');
    });

    test('rejects another content encryption as algorithmNotAllowed', async () => {
      const token = await mintUsherToken(ANA, {
        header: { enc: 'A128GCM' },
        key: new Uint8Array(16).fill(7),
      });

      assert.equal(await reasonFor(token), 'algorithmNotAllowed');
    });

    test('rejects a token under another application key as decryptionFailed', async () => {
      const token = await mintUsherToken(ANA, {
        key: new Uint8Array(32).fill(9),
      });

      assert.equal(await reasonFor(token), 'decryptionFailed');
    });

    test('rejects altered ciphertext as decryptionFailed', async () => {
      const parts = (await mintUsherToken(ANA)).split('.');
      const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
      ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
      parts[3] = ciphertext.toString('base64url');

      assert.equal(await reasonFor(parts.join('.')), 'decryptionFailed');
    });

    test('rejects a signed three-part token carrying the right typ as tokenMalformed', async () => {
      const token = await new SignJWT({ ...ANA, sub: 'subject-ana' })
        .setProtectedHeader({ alg: 'HS256', typ: 'usher+jwt' })
        .sign(new Uint8Array(32).fill(7));

      assert.equal(await reasonFor(token), 'tokenMalformed');
    });
  });

  suite('the claims and the payload', () => {
    for (const [description, payload, reason] of [
      [
        'another audience',
        { ...ANA, aud: 'another-application' },
        'audienceRejected',
      ],
      [
        'an audience given as a list not containing it',
        { ...ANA, aud: ['another-application'] },
        'audienceRejected',
      ],
      ['no audience', (({ aud: _, ...rest }) => rest)(ANA), 'claimRejected'],
      [
        'another issuer',
        { ...ANA, iss: 'https://elsewhere.example.org' },
        'claimRejected',
      ],
      [
        'no globalCategories',
        (({ globalCategories: _, ...rest }) => rest)(ANA),
        'claimRejected',
      ],
      [
        'no resourceCategories',
        (({ resourceCategories: _, ...rest }) => rest)(ANA),
        'claimRejected',
      ],
      [
        'no servedResources',
        (({ servedResources: _, ...rest }) => rest)(ANA),
        'claimRejected',
      ],
      [
        'offeredCategories in place of both category members',
        (({
          globalCategories: _global,
          resourceCategories: _own,
          ...rest
        }) => ({
          ...rest,
          offeredCategories: {
            HEART_STUDY: ['global.controlled', 'global.unmarked'],
            LUNG_COHORT: ['global.unmarked'],
            REEF_ARCHIVE: ['global.unmarked'],
          },
        }))(ANA),
        'claimRejected',
      ],
      [
        'a null globalCategories',
        { ...ANA, globalCategories: null },
        'payloadMalformed',
      ],
      [
        'a null resourceCategories',
        { ...ANA, resourceCategories: null },
        'payloadMalformed',
      ],
      [
        'a null servedResources',
        { ...ANA, servedResources: null },
        'payloadMalformed',
      ],
      [
        'servedResources leaving out a resource permissions names',
        {
          ...ANA,
          servedResources: ANA.servedResources.filter(
            (resource) => resource !== 'HEART_STUDY',
          ),
        },
        'payloadMalformed',
      ],
      [
        'an audience given as a list containing it',
        { ...ANA, aud: [AUDIENCE, 'other'] },
        'payloadMalformed',
      ],
      [
        'an unlisted payload version',
        { ...ANA, payloadVersion: 2 },
        'payloadVersionUnlisted',
      ],
      [
        'a bare category name',
        {
          ...ANA,
          permissions: { HEART_STUDY: { open: { record: ['view'] } } },
        },
        'payloadMalformed',
      ],
    ] as const) {
      test(`rejects a payload with ${description} as ${reason}`, async () => {
        assert.equal(await reasonFor(await mintUsherToken(payload)), reason);
      });
    }

    test('rejects a version the payload type knows when the bridge did not list it', async () => {
      const reader = await readerAt(ANA.iat * 1000, [2]);

      assert.equal(
        await reasonFor(await mintUsherToken(ANA), reader),
        'payloadVersionUnlisted',
      );
    });
  });

  test('returns a reading for a rejected token, carrying only its kind and reason', async () => {
    const reader = await readerAt();
    const token = await mintUsherToken({ ...ANA, aud: 'another-application' });

    const reading = await reader.read(token);

    assert.deepEqual(Object.keys(reading).toSorted(), ['kind', 'reason']);
    assert.equal(JSON.stringify(reading).includes('subject-ana'), false);
  });
});
