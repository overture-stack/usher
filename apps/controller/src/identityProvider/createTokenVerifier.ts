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
  TokenClaims,
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

const unverified = (reason: UnverifiedReason): TokenVerification => ({
  kind: 'unverified',
  reason,
});

const KEYS_UNAVAILABLE: TokenVerification = Object.freeze({
  kind: 'keysUnavailable',
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
  | { claims: TokenClaims | undefined; kind: 'verified' }
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
      ({ payload }): Attempt => ({
        claims: claimsOf(payload),
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
    const { payload } = await compactVerify(
      token,
      createLocalJWKSet({ keys: [...keys] }),
      { algorithms: [...ALGORITHMS] },
    );
    return { claims: claimsOf(payload), kind: 'verified' };
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

const verificationOf = (
  attempt: Attempt,
  issuer: string,
): TokenVerification => {
  if (attempt.kind === 'verified') {
    if (attempt.claims === undefined) {
      return unverified('unreadableToken');
    }
    return attempt.claims['iss'] === issuer
      ? { claims: attempt.claims, kind: 'verified' }
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
 * key is not among those held fetches the key set again, at most once in the refetch cooldown, before
 * it is refused as `invalidSignature`; while the latest fetch has failed, it is answered
 * `keysUnavailable` instead, since a key the provider published during its outage cannot be told from
 * one it never published. A token whose key is held and whose signature fails under it is refused
 * whatever became of the latest fetch. It accepts the asymmetric algorithms RS, PS and ES at 256, 384
 * and 512 bits, each under a key whose own `alg`, where the key names one, is the token's. Each failed
 * fetch of the key set is written to the event log at error, naming its cause.
 *
 * @param settings the clock the key set's age is measured on, and the trusted issuer.
 * @param eventLog where a failed fetch of the key set is written.
 */
export const createTokenVerifier = (
  settings: TokenVerifierSettings,
  eventLog: TokenVerifierLog,
): { verify(token: string): Promise<TokenVerification> } => {
  const signingKeys = createSigningKeys(settings, eventLog);
  return {
    verify: async (token) => {
      const routed = unverifiedIssuer(token);
      if (routed === undefined) {
        return unverified('unreadableToken');
      }
      if (routed.issuer !== settings.identityProviderIssuer) {
        return unverified('otherIssuer');
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
      return retried.kind === 'noMatchingKey' && refreshed.latestFetchFailed
        ? KEYS_UNAVAILABLE
        : verificationOf(retried, settings.identityProviderIssuer);
    },
  };
};
