import type { JWK } from 'jose';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { EventLog } from '../eventLog/index.js';

/**
 * Why a token was not verified, each a fixed code naming its fault: it could not be read as a signed
 * token, it names an issuer other than the trusted one, or no published key of the trusted issuer
 * verifies its signature under an algorithm the controller accepts.
 */
export type UnverifiedReason =
  'invalidSignature' | 'otherIssuer' | 'unreadableToken';

/** A verified token's claims: its payload, as the identity provider signed it. */
export type TokenClaims = Readonly<Record<string, unknown>>;

/**
 * What verifying a token found: its claims, once its signature verifies under the trusted issuer; why
 * it was not verified; that the trusted issuer's keys could not be fetched to verify it, none being
 * held, or its key being none of those held while the latest fetch of them failed; or that its key is
 * not confirmed yet, being none of those held while the refetch cooldown since a fetch that succeeded
 * forbids fetching them again, with the whole seconds until a fetch may start, at least 1. A key not
 * confirmed yet is no fault of the token's: a key the provider published since that fetch, as by a
 * rotation, is found by the next fetch.
 */
export type TokenVerification =
  | { claims: TokenClaims; kind: 'verified' }
  | { kind: 'keysUnavailable' }
  | { kind: 'signingKeyUnconfirmed'; retryAfterSeconds: number }
  | { kind: 'unverified'; reason: UnverifiedReason };

/** What the verifier is created from: the clock the key set's age is measured on, and the trusted issuer. */
export type TokenVerifierSettings = Pick<
  ControllerConfiguration,
  'clock' | 'identityProviderIssuer'
>;

/** Where the verifier writes a failed fetch of the trusted issuer's key set. */
export type TokenVerifierLog = Pick<EventLog, 'error'>;

/**
 * Why a fetch of the trusted issuer's key set failed, each a fixed cause and never a value the fetch
 * met: the provider gave no answer, as when it cannot be reached or answers too slowly; it answered a
 * status other than 200, a redirect among them; its discovery document is not a JSON object naming
 * the trusted issuer exactly; that document names no key set reachable over https, or over http to a
 * loopback host; or the key set is not a JSON object holding a list of keys.
 */
export type KeySetFetchFailure =
  | 'discoveryIssuer'
  | 'keySetLocation'
  | 'keySetShape'
  | 'status'
  | 'unreachable';

/**
 * The trusted issuer's signing keys as a reading of them gave them, with whether the reading fetched
 * them and whether the latest attempt to fetch them failed, or that none could be had.
 */
export type KeySetReading =
  | {
      /** Whether the keys come from a fetch the reading started or joined, rather than from those already held. */
      fetched: boolean;

      keys: readonly JWK[];
      kind: 'held';
      latestFetchFailed: boolean;
    }
  | { kind: 'unavailable' };

/**
 * The trusted issuer's published signing keys, fetched through its discovery document and kept for a
 * while, every age measured on the configured clock.
 */
export interface SigningKeys {
  /** The keys held, fetched when none are held or they have grown too old, unless a fetch was tried too recently. */
  current(): Promise<KeySetReading>;

  /** The keys fetched anew, for a token whose key is not among those held, unless a fetch was tried too recently. */
  refreshed(): Promise<KeySetReading>;

  /** How long until the refetch cooldown lets a fetch start, in milliseconds of the configured clock: 0 once it does. */
  refetchInMilliseconds(): number;
}
