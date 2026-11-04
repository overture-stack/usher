import { hkdfSync } from 'node:crypto';

import {
  CompactEncrypt,
  EncryptJWT,
  type JWEHeaderParameters,
  type JWTPayload,
} from 'jose';

import { SUBKEY_LABELS } from './keys.js';

/** The application key shared by the tests and their controller mock, as bytes. */
export const TEST_KEY_BYTES: Uint8Array = new Uint8Array(32).fill(7);

/** {@link TEST_KEY_BYTES} as configured: 43 base64url characters. */
export const TEST_KEY: string =
  Buffer.from(TEST_KEY_BYTES).toString('base64url');

/** A test's changes to a mint: a header to merge over the minted one, and a key to use instead. */
export interface MintOptions {
  header?: Partial<JWEHeaderParameters>;
  key?: Uint8Array;
}

/**
 * Mints an Usher token: the whole payload, `sub: null` included, under `dir` and A256GCM with `typ`
 * `usher+jwt`, with a fresh IV on every mint. `options.header` is merged over that header when
 * given, and `options.key` replaces the shared test key when given. Rejects when jose refuses the
 * merged header or the key.
 */
export const mintUsherToken = (
  payload: object,
  options: MintOptions = {},
): Promise<string> =>
  // jose's `JWTPayload` admits no `sub: null`, the payload contract's anonymous subject.
  new EncryptJWT(payload as JWTPayload)
    .setProtectedHeader({
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'usher+jwt',
      ...options.header,
    })
    .encrypt(options.key ?? TEST_KEY_BYTES);

/**
 * The bytes of a subkey: HKDF-SHA256 over the application key with an empty salt and `label` as
 * info, 32 bytes long.
 *
 * @param keyBytes the application key; the shared test key when omitted.
 */
export const subkeyBytes = (
  label: string,
  keyBytes: Uint8Array = TEST_KEY_BYTES,
): Uint8Array =>
  new Uint8Array(hkdfSync('sha256', keyBytes, new Uint8Array(0), label, 32));

const mintChannelJwe = (
  plaintext: object | Uint8Array,
  typ: string,
  label: string,
  { header, key }: MintOptions,
): Promise<string> =>
  new CompactEncrypt(
    plaintext instanceof Uint8Array
      ? plaintext
      : new TextEncoder().encode(JSON.stringify(plaintext)),
  )
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ, ...header })
    .encrypt(key ?? subkeyBytes(label));

/**
 * Mints a pushed notice: a compact JWE under `dir` and A256GCM with `typ` `usher-notice+jwt`, under
 * the notice subkey. A notice given as bytes is encrypted as it is, so the plaintext need not be
 * JSON; any other notice is encrypted as its JSON. `options.header` is merged over that header when
 * given, and `options.key` replaces the notice subkey when given. Rejects when jose refuses the
 * merged header or the key.
 */
export const mintNotice = (
  notice: object | Uint8Array,
  options: MintOptions = {},
): Promise<string> =>
  mintChannelJwe(notice, 'usher-notice+jwt', SUBKEY_LABELS.notice, options);

/**
 * Mints a poll answer: a compact JWE under `dir` and A256GCM with `typ` `usher-poll+jwt`, under the
 * poll-answer subkey. An answer given as bytes is encrypted as it is; any other answer is encrypted
 * as its JSON. `options.header` is merged over that header when given, and `options.key` replaces
 * the poll-answer subkey when given. Rejects when jose refuses the merged header or the key.
 */
export const mintPollAnswer = (
  answer: object | Uint8Array,
  options: MintOptions = {},
): Promise<string> =>
  mintChannelJwe(answer, 'usher-poll+jwt', SUBKEY_LABELS.pollAnswer, options);
