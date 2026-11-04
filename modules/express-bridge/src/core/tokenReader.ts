import {
  type NonEmpty,
  PAYLOAD_MEMBER_NAMES,
  PAYLOAD_VERSION,
  validatePayload,
} from '@overture-stack/usher-types';
import { decodeProtectedHeader, jwtDecrypt } from 'jose';

import type { Clock } from './clocks.js';
import type { TokenReader, TokenReading } from './core.js';
import type { BridgeEventData } from './events.js';
import type { CryptoKey } from './keys.js';

type TokenRejectionReason = BridgeEventData['token.rejection']['reason'];

const USHER_TOKEN_TYPE = 'usher+jwt';

/** The only protected header members allowed in an Usher token. */
const HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'enc', 'typ']);

/** jose's error codes, each mapped to a fixed reason code so no part of the error is passed on. */
const REASONS_BY_CODE: ReadonlyMap<unknown, TokenRejectionReason> = new Map([
  ['ERR_JOSE_ALG_NOT_ALLOWED', 'algorithmNotAllowed'],
  ['ERR_JOSE_NOT_SUPPORTED', 'headerUnsupported'],
  ['ERR_JWE_DECRYPTION_FAILED', 'decryptionFailed'],
  ['ERR_JWE_INVALID', 'tokenMalformed'],
  ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'claimRejected'],
  ['ERR_JWT_EXPIRED', 'expired'],
  ['ERR_JWT_INVALID', 'claimsNotObject'],
] as const);

/**
 * The validator for each readable payload version; a `Map`, so a `payloadVersion` named like an
 * `Object.prototype` member finds none.
 */
const READERS: ReadonlyMap<unknown, typeof validatePayload> = new Map([
  [PAYLOAD_VERSION, validatePayload],
]);

/** Whether the default token reader holds a validator for payload version `version`. */
export const isReadablePayloadVersion = (version: number): boolean =>
  READERS.has(version);

const rejected = (reason: TokenRejectionReason): TokenReading => ({
  kind: 'rejected',
  reason,
});

const protectedHeaderOf = (
  token: string,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    return decodeProtectedHeader(token);
  } catch {
    return undefined;
  }
};

/** Why a protected header is refused before jose reads the token, or `undefined` when it is not. */
const headerRefusal = (
  header: Readonly<Record<string, unknown>> | undefined,
): TokenRejectionReason | undefined => {
  if (header === undefined) {
    return 'headerUnreadable';
  }
  if (header['typ'] !== USHER_TOKEN_TYPE) {
    return 'headerType';
  }
  return Object.keys(header).every((member) => HEADER_MEMBERS.has(member))
    ? undefined
    : 'headerMember';
};

const ownValue = (error: unknown, member: string): unknown =>
  typeof error === 'object' && error !== null
    ? Object.getOwnPropertyDescriptor(error, member)?.value
    : undefined;

/**
 * Whether jose refused the `aud` value, read from the claim named by its claim-validation error. A
 * missing `aud` fails jose's presence check instead, as any missing member does, and stays
 * `claimRejected`.
 */
const isAudienceRefusal = (error: unknown): boolean =>
  ownValue(error, 'code') === 'ERR_JWT_CLAIM_VALIDATION_FAILED' &&
  ownValue(error, 'claim') === 'aud' &&
  ownValue(error, 'reason') === 'check_failed';

const reasonOf = (error: unknown): TokenRejectionReason =>
  isAudienceRefusal(error)
    ? 'audienceRejected'
    : (REASONS_BY_CODE.get(ownValue(error, 'code')) ?? 'unexpected');

/** What the default token reader needs. */
export interface TokenReaderOptions {
  audience: string;
  issuer: string;

  /** The payload versions accepted; a token of any other version is rejected. */
  payloadVersions: NonEmpty<number>;

  /** The application key, imported for decryption alone. */
  tokenKey: CryptoKey;

  /** The clock for checking a token's time claims. */
  wallClock: Clock;
}

const readPayload = (
  payload: Readonly<Record<string, unknown>>,
  payloadVersions: readonly number[],
): TokenReading => {
  const version = payload['payloadVersion'];
  const reader = payloadVersions.some((listed) => listed === version)
    ? READERS.get(version)
    : undefined;
  if (reader === undefined) {
    return rejected('payloadVersionUnlisted');
  }
  const result = reader(payload);
  return result.success
    ? { kind: 'payload', payload: result.payload }
    : rejected('payloadMalformed');
};

/**
 * Creates the default token reader. Its `read` decrypts an Usher token with `tokenKey` and returns
 * the validated payload, or a rejection carrying a fixed reason code and nothing else: no error,
 * message or payload content. `read` never throws. A token is rejected with:
 *
 * - `headerUnreadable` when its protected header cannot be read;
 * - `headerType` when its `typ` is not exactly `usher+jwt`;
 * - `headerMember` when its protected header carries a member other than `alg`, `enc` and `typ`;
 * - `algorithmNotAllowed` when it is not `dir` with A256GCM;
 * - `headerUnsupported` when it uses a feature unsupported by jose;
 * - `tokenMalformed` when it is not a well-formed compact JWE;
 * - `decryptionFailed` when it does not decrypt under `tokenKey`;
 * - `claimsNotObject` when its plaintext is not a JSON object;
 * - `audienceRejected` when its `aud` is not `audience`;
 * - `expired` when its `exp` is at or before the wall clock's reading, with no tolerance;
 * - `claimRejected` for any other claim failure, such as an `iss` other than `issuer`, an `nbf` in
 *   the future or a missing payload member;
 * - `payloadVersionUnlisted` when its `payloadVersion` is not in `payloadVersions`, or has no
 *   validator;
 * - `payloadMalformed` when its payload fails validation;
 * - `unexpected` for any other failure.
 */
export const createTokenReader = ({
  audience,
  issuer,
  payloadVersions,
  tokenKey,
  wallClock,
}: TokenReaderOptions): TokenReader => {
  const decrypted = async (token: string): Promise<TokenReading> => {
    try {
      // Every check is stated rather than left to a jose default; `maxDecompressedLength: 0`
      // refuses a compressed token.
      const { payload } = await jwtDecrypt(token, tokenKey, {
        audience,
        clockTolerance: 0,
        contentEncryptionAlgorithms: ['A256GCM'],
        currentDate: new Date(wallClock.now()),
        issuer,
        keyManagementAlgorithms: ['dir'],
        maxDecompressedLength: 0,
        requiredClaims: [...PAYLOAD_MEMBER_NAMES],
        typ: USHER_TOKEN_TYPE,
      });
      return readPayload(payload, payloadVersions);
    } catch (error) {
      return rejected(reasonOf(error));
    }
  };

  return {
    read: async (token) => {
      const refusal = headerRefusal(protectedHeaderOf(token));
      return refusal === undefined ? decrypted(token) : rejected(refusal);
    },
  };
};
