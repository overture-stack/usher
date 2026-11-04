import { createHash, webcrypto } from 'node:crypto';

/** A Web Crypto key: the form of each subkey derived from the application key. */
export type CryptoKey = webcrypto.CryptoKey;

/** The HKDF label of each subkey derived from the application key. */
export const SUBKEY_LABELS: Readonly<{
  channelAssertion: string;
  notice: string;
  pollAnswer: string;
  subjectTag: string;
}> = Object.freeze({
  channelAssertion: 'usher/v1/channel-assertion',
  notice: 'usher/v1/notice-encryption',
  pollAnswer: 'usher/v1/poll-answer',
  subjectTag: 'usher/v1/subject-tag',
});

/** The application key and its subkeys as non-extractable keys, holding no raw bytes. */
export interface ApplicationKeys {
  /** Signs the channel assertion: HMAC-SHA256. */
  channelAssertionKey: CryptoKey;

  /** Decrypts pushed notices: AES-GCM. */
  noticeKey: CryptoKey;

  /** Decrypts poll answers: AES-GCM. */
  pollAnswerKey: CryptoKey;

  /** Tags a subject as named in principal notices: HMAC-SHA256. */
  subjectTagKey: CryptoKey;

  /** Decrypts the Usher token: the application key itself, as AES-GCM for decryption alone. */
  tokenKey: CryptoKey;
}

const CANONICAL_KEY = /^[A-Za-z0-9_-]{43}$/u;

const EMPTY_SALT = new Uint8Array(0);

const keyBytes = (key: string): Buffer => {
  const bytes = Buffer.from(key, 'base64url');
  if (CANONICAL_KEY.test(key) && bytes.toString('base64url') === key) {
    return bytes;
  }
  // A near miss, such as the key with `=` padding, decodes to the real key's bytes.
  bytes.fill(0);
  throw new RangeError(
    'the application key is 43 base64url characters in canonical form',
  );
};

const hkdf = (label: string): webcrypto.HkdfParams => ({
  hash: 'SHA-256',
  info: new TextEncoder().encode(label),
  name: 'HKDF',
  salt: EMPTY_SALT,
});

const AES_GCM: webcrypto.AesKeyGenParams = { length: 256, name: 'AES-GCM' };

const HMAC_SHA256: webcrypto.HmacImportParams = {
  hash: 'SHA-256',
  length: 256,
  name: 'HMAC',
};

/**
 * Imports the application key as non-extractable keys, each limited to one usage:
 *
 * - `tokenKey`, the application key itself as AES-GCM, for decryption only;
 * - one HKDF-SHA256 subkey for each label in {@link SUBKEY_LABELS}, either HMAC-SHA256 for signing
 *   only or AES-GCM for decryption only.
 *
 * The bytes decoded from `key` are zero-filled before the returned promise settles, whether it
 * resolves or rejects.
 *
 * @param key 43 base64url characters in canonical form.
 * @throws {RangeError} when `key` is any other value, by rejecting the returned promise.
 */
export const importApplicationKey = async (
  key: string,
): Promise<ApplicationKeys> => {
  const bytes = keyBytes(key);
  try {
    // Imported twice: as the token key, and as the HKDF base for every other subkey, each derived
    // as the controller derives it.
    const [tokenKey, base] = await Promise.all([
      webcrypto.subtle.importKey('raw', bytes, AES_GCM, false, ['decrypt']),
      webcrypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']),
    ]);
    const derive = (
      label: string,
      algorithm: webcrypto.AesKeyGenParams | webcrypto.HmacImportParams,
      usage: webcrypto.KeyUsage,
    ): Promise<CryptoKey> =>
      webcrypto.subtle.deriveKey(hkdf(label), base, algorithm, false, [usage]);
    const [channelAssertionKey, noticeKey, pollAnswerKey, subjectTagKey] =
      await Promise.all([
        derive(SUBKEY_LABELS.channelAssertion, HMAC_SHA256, 'sign'),
        derive(SUBKEY_LABELS.notice, AES_GCM, 'decrypt'),
        derive(SUBKEY_LABELS.pollAnswer, AES_GCM, 'decrypt'),
        derive(SUBKEY_LABELS.subjectTag, HMAC_SHA256, 'sign'),
      ]);

    return {
      channelAssertionKey,
      noticeKey,
      pollAnswerKey,
      subjectTagKey,
      tokenKey,
    };
  } finally {
    // WebCrypto keeps copies of its own, so the decoded bytes are never needed again.
    bytes.fill(0);
  }
};

/**
 * The per-audience tag of `subject`, as named in principal notices: HMAC-SHA256 of the subject
 * under `keys.subjectTagKey`, encoded base64url without padding. Rejects only when that key is not
 * an HMAC signing key, which {@link importApplicationKey} never gives.
 */
export const subjectTag = async (
  keys: ApplicationKeys,
  subject: string,
): Promise<string> =>
  Buffer.from(
    await webcrypto.subtle.sign(
      'HMAC',
      keys.subjectTagKey,
      new TextEncoder().encode(subject),
    ),
  ).toString('base64url');

/**
 * SHA-256 of the whole credential, encoded base64url without padding. No claim inside the
 * credential is read.
 */
export const credentialDigest = (credential: string): string =>
  createHash('sha256').update(credential).digest('base64url');
