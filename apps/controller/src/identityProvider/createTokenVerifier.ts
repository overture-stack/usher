import {
  compactVerify,
  createLocalJWKSet,
  type CryptoKey,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  type JWK,
} from 'jose';

import { createSigningKeys } from './createSigningKeys.js';
import type {
  HeldKeyVerification,
  TokenClaims,
  TokenHeader,
  TokenVerification,
  TokenVerifierLog,
  TokenVerifierSettings,
  UnverifiedReason,
} from './types.js';

// The asymmetric algorithms an identity provider signs access tokens with. A symmetric algorithm is
// never accepted, so a token signed with a published key used as a shared secret verifies under none.
const ALGORITHMS: readonly string[] = Object.freeze([
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'RS256',
  'RS384',
  'RS512',
]);

// What checking a token's signature can find without regard to which keys could be had.
type Checked = Extract<TokenVerification, { kind: 'unverified' | 'verified' }>;

const unverified = (reason: UnverifiedReason): Checked => ({
  kind: 'unverified',
  reason,
});

const KEYS_UNAVAILABLE: TokenVerification = Object.freeze({
  kind: 'keysUnavailable',
});

const KEY_NOT_HELD: HeldKeyVerification = Object.freeze({
  kind: 'keyNotHeld',
});

// A key not confirmed yet, answered with the cooldown's time left in whole seconds, rounded up and
// never 0, as `Retry-After` takes it: a caller retrying after it finds a fetch allowed.
const signingKeyUnconfirmed = (
  refetchInMilliseconds: number,
): TokenVerification => ({
  kind: 'signingKeyUnconfirmed',
  retryAfterSeconds: Math.max(1, Math.ceil(refetchInMilliseconds / 1000)),
});

const isRecord = (value: unknown): value is TokenClaims =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The issuer a token names, read without verifying it, only to route it; undefined for a token that
// cannot be read as a compact signed token at all, an encrypted one among them.
const unverifiedIssuer = (token: string): { issuer: unknown } | undefined => {
  try {
    decodeProtectedHeader(token);
    return { issuer: decodeJwt(token).iss };
  } catch {
    return undefined;
  }
};

const claimsOf = (payload: Uint8Array): TokenClaims | undefined => {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payload),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

type Attempt =
  | { claims: TokenClaims | undefined; header: TokenHeader; kind: 'verified' }
  | { kind: 'noMatchingKey' }
  | { kind: 'refused' };

// One key at a time, for the keys a token's header matches more than one of.
const verifiedByAny = async (
  token: string,
  candidates: AsyncIterable<CryptoKey>,
): Promise<Attempt> => {
  for await (const key of candidates) {
    const attempt = await compactVerify(token, key, {
      algorithms: [...ALGORITHMS],
    }).then(
      ({ payload, protectedHeader }): Attempt => ({
        claims: claimsOf(payload),
        header: protectedHeader,
        kind: 'verified',
      }),
      (): Attempt => ({ kind: 'refused' }),
    );
    if (attempt.kind === 'verified') {
      return attempt;
    }
  }
  return { kind: 'refused' };
};

const verifiedUnder = async (
  token: string,
  keys: readonly JWK[],
): Promise<Attempt> => {
  try {
    const { payload, protectedHeader } = await compactVerify(
      token,
      createLocalJWKSet({ keys: [...keys] }),
      { algorithms: [...ALGORITHMS] },
    );
    return {
      claims: claimsOf(payload),
      header: protectedHeader,
      kind: 'verified',
    };
  } catch (error) {
    if (error instanceof errors.JWKSNoMatchingKey) {
      return { kind: 'noMatchingKey' };
    }
    if (error instanceof errors.JWKSMultipleMatchingKeys) {
      return verifiedByAny(token, error);
    }
    return { kind: 'refused' };
  }
};

const verificationOf = (attempt: Attempt, issuer: string): Checked => {
  if (attempt.kind === 'verified') {
    if (attempt.claims === undefined) {
      return unverified('unreadableToken');
    }
    return attempt.claims['iss'] === issuer
      ? { claims: attempt.claims, header: attempt.header, kind: 'verified' }
      : unverified('otherIssuer');
  }
  return unverified('invalidSignature');
};

/**
 * Creates the verifier of tokens from the trusted identity provider, the configured issuer, whose keys
 * it fetches through the issuer's discovery document no sooner than a token needs them. It verifies a
 * compact signed token: its issuer, read unverified only to route it, is checked against the trusted
 * one before any key is fetched; its signature, against the trusted issuer's published keys alone; and
 * its issuer again once verified. No claim but `iss` is judged here. A token whose
 * key is not among those held fetches the key set again, and is refused as `invalidSignature` if the
 * key is still absent; while the latest fetch has failed, it is answered `keysUnavailable` instead,
 * since a key the provider published during its outage cannot be told from one it never published.
 * The key set is fetched at most once in the refetch cooldown, so a flood of made-up key ids fetches
 * it no more often: a token whose key is absent while the cooldown since a fetch that succeeded
 * forbids another is answered `signingKeyUnconfirmed`, with the whole seconds until a fetch may start,
 * since its key may be one published since that fetch, as by a rotation. A key absent from keys
 * fetched for the token itself, none being held or those held having grown too old, is refused as
 * `invalidSignature`. A token whose key is held and whose signature fails under it is refused
 * whatever became of the latest fetch. It accepts the asymmetric algorithms RS, PS and ES at 256, 384
 * and 512 bits, each under a key whose own `alg`, where the key names one, is the token's. Each failed
 * fetch of the key set is written to the event log at error, naming its cause. A token can also be
 * verified under the keys already held alone, for a caller that may not wait on the provider: that
 * fetches nothing, neither the discovery document nor the key set, whatever the cooldown, and answers
 * `keyNotHeld` for a token whose key is not among keys held and not grown too old.
 *
 * @param settings the clock the key set's age is measured on, and the trusted issuer.
 * @param eventLog where a failed fetch of the key set is written.
 */
export const createTokenVerifier = (
  settings: TokenVerifierSettings,
  eventLog: TokenVerifierLog,
): {
  verify(token: string): Promise<TokenVerification>;
  verifyHeld(token: string): Promise<HeldKeyVerification>;
} => {
  const signingKeys = createSigningKeys(settings, eventLog);
  // The issuer is judged before any key is looked for, among those held or by a fetch.
  const routingRefusal = (token: string): Checked | undefined => {
    const routed = unverifiedIssuer(token);
    if (routed === undefined) {
      return unverified('unreadableToken');
    }
    return routed.issuer === settings.identityProviderIssuer
      ? undefined
      : unverified('otherIssuer');
  };
  return {
    verify: async (token) => {
      const refusal = routingRefusal(token);
      if (refusal !== undefined) {
        return refusal;
      }
      const held = await signingKeys.current();
      if (held.kind === 'unavailable') {
        return KEYS_UNAVAILABLE;
      }
      const attempt = await verifiedUnder(token, held.keys);
      if (attempt.kind !== 'noMatchingKey') {
        return verificationOf(attempt, settings.identityProviderIssuer);
      }
      const refreshed = await signingKeys.refreshed();
      if (refreshed.kind === 'unavailable') {
        return KEYS_UNAVAILABLE;
      }
      const retried = await verifiedUnder(token, refreshed.keys);
      if (retried.kind !== 'noMatchingKey') {
        return verificationOf(retried, settings.identityProviderIssuer);
      }
      if (refreshed.latestFetchFailed) {
        return KEYS_UNAVAILABLE;
      }
      // A key absent from keys fetched for this token is refused. One the cooldown kept this token
      // from looking for is not confirmed yet, since the provider may have published it since.
      return held.fetched || refreshed.fetched
        ? unverified('invalidSignature')
        : signingKeyUnconfirmed(signingKeys.refetchInMilliseconds());
    },
    verifyHeld: async (token) => {
      const refusal = routingRefusal(token);
      if (refusal !== undefined) {
        return refusal;
      }
      const held = signingKeys.held();
      if (held.kind === 'unavailable') {
        return KEY_NOT_HELD;
      }
      const attempt = await verifiedUnder(token, held.keys);
      return attempt.kind === 'noMatchingKey'
        ? KEY_NOT_HELD
        : verificationOf(attempt, settings.identityProviderIssuer);
    },
  };
};
