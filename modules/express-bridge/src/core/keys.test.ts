import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  webcrypto,
} from 'node:crypto';
import { suite, test } from 'node:test';

import {
  credentialDigest,
  importApplicationKey,
  SUBKEY_LABELS,
  subjectTag,
} from './keys.js';

const KEY_BYTES = Buffer.alloc(32, 7);
const KEY = KEY_BYTES.toString('base64url');

/** The subkey a controller derives with node:crypto, which the bridge's WebCrypto derivation must match. */
const controllerSubkey = (label: string): Buffer =>
  Buffer.from(hkdfSync('sha256', KEY_BYTES, new Uint8Array(0), label, 32));

const aesGcmSealed = (
  keyBytes: Buffer,
  plaintext: string,
): { ciphertext: Uint8Array; iv: Uint8Array } => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext: sealed, iv };
};

const decrypted = async (
  key: webcrypto.CryptoKey,
  { ciphertext, iv }: { ciphertext: Uint8Array; iv: Uint8Array },
): Promise<string> =>
  Buffer.from(
    await webcrypto.subtle.decrypt({ iv, name: 'AES-GCM' }, key, ciphertext),
  ).toString('utf8');

suite('importApplicationKey', () => {
  test('imports the token key from the application key itself, decrypting what was sealed under it', async () => {
    const keys = await importApplicationKey(KEY);

    const opened = await decrypted(
      keys.tokenKey,
      aesGcmSealed(KEY_BYTES, 'an Usher token'),
    );

    assert.equal(opened, 'an Usher token');
  });

  test('derives the notice and poll-answer keys as the controller does, from their own labels', async () => {
    const keys = await importApplicationKey(KEY);

    const notice = await decrypted(
      keys.noticeKey,
      aesGcmSealed(controllerSubkey(SUBKEY_LABELS.notice), 'a notice'),
    );
    const pollAnswer = await decrypted(
      keys.pollAnswerKey,
      aesGcmSealed(controllerSubkey(SUBKEY_LABELS.pollAnswer), 'an answer'),
    );

    assert.deepEqual([notice, pollAnswer], ['a notice', 'an answer']);
  });

  test('derives the channel assertion key as the controller does, signing what it verifies', async () => {
    const keys = await importApplicationKey(KEY);

    const signature = Buffer.from(
      await webcrypto.subtle.sign(
        'HMAC',
        keys.channelAssertionKey,
        Buffer.from('header.claims'),
      ),
    ).toString('base64url');

    assert.equal(
      signature,
      createHmac('sha256', controllerSubkey(SUBKEY_LABELS.channelAssertion))
        .update('header.claims')
        .digest('base64url'),
    );
  });

  test('keeps every key non-extractable, and the token key for decryption alone', async () => {
    const keys = await importApplicationKey(KEY);

    const extractable = Object.values(keys).map((key) => key.extractable);

    assert.deepEqual(extractable, [false, false, false, false, false]);
    assert.deepEqual(keys.tokenKey.usages, ['decrypt']);
    await assert.rejects(webcrypto.subtle.exportKey('raw', keys.tokenKey));
  });

  test('refuses a key that is not 43 base64url characters in canonical form', async () => {
    await assert.rejects(importApplicationKey(`${KEY.slice(0, 42)}B`));
  });
});

suite('subjectTag', () => {
  test('tags a subject as the controller does: HMAC-SHA256 under the subject-tag subkey, base64url without padding', async () => {
    const keys = await importApplicationKey(KEY);

    const tag = await subjectTag(keys, '8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b');

    assert.equal(
      tag,
      createHmac('sha256', controllerSubkey('usher/v1/subject-tag'))
        .update('8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b')
        .digest('base64url'),
    );
    assert.equal(tag.includes('='), false);
  });

  test('gives two subjects different tags, and one subject the same tag each time', async () => {
    const keys = await importApplicationKey(KEY);

    const [first, again, other] = await Promise.all([
      subjectTag(keys, 'subject-ana'),
      subjectTag(keys, 'subject-ana'),
      subjectTag(keys, 'subject-ben'),
    ]);

    assert.equal(first, again);
    assert.notEqual(first, other);
  });
});

suite('credentialDigest', () => {
  test('digests the whole credential with SHA-256, as base64url', () => {
    const credential = 'header.claims.signature';

    assert.equal(
      credentialDigest(credential),
      createHash('sha256').update(credential).digest('base64url'),
    );
  });

  test('tells apart two credentials sharing every claim but their signature', () => {
    assert.notEqual(
      credentialDigest('header.claims.signature-a'),
      credentialDigest('header.claims.signature-b'),
    );
  });
});
