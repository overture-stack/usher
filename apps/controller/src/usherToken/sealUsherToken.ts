import { CompactEncrypt } from 'jose';

import type { TokenSealingKey, VersionOnePayload } from './types.js';

const TOKEN_TYPE = 'usher+jwt';

const PLAINTEXT_ENCODER = new TextEncoder();

/**
 * Seals a version 1 payload as an Usher token: a compact JWE under `dir` and A256GCM, encrypted
 * under the application's token subkey, its protected header exactly `alg`, `enc` and `typ`
 * `usher+jwt`, with no `kid`, `zip` or other member. The payload is sealed as its JSON, whole. The
 * IV is never set, so jose draws a fresh random 12-byte IV for every seal: AES-GCM loses both its
 * confidentiality and its integrity once an IV repeats under one key.
 *
 * @param payload the payload, as version 1 defines it.
 * @param key the application's key answering the exchange, whose token subkey alone is used.
 */
export const sealUsherToken = (
  payload: VersionOnePayload,
  key: TokenSealingKey,
): Promise<string> =>
  new CompactEncrypt(PLAINTEXT_ENCODER.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: TOKEN_TYPE })
    .encrypt(key.token);
