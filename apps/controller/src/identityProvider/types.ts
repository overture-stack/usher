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

/** A verified token's protected header, as the identity provider signed it, by which its type is judged. */
export type TokenHeader = Readonly<Record<string, unknown>>;

/**
 * What verifying a token found: its claims and its protected header, once its signature verifies under
 * the trusted issuer; why it was not verified; that the trusted issuer's keys could not be fetched to
 * verify it, none being held, or its key being none of those held while the latest fetch of them
 * failed; or that its key is not confirmed yet, being none of those held while the refetch cooldown
 * since a fetch that succeeded forbids fetching them again, with the whole seconds until a fetch may
 * start, at least 1. A key not confirmed yet is no fault of the token's: a key the provider published
 * since that fetch, as by a rotation, is found by the next fetch.
 */
export type TokenVerification =
  | { claims: TokenClaims; header: TokenHeader; kind: 'verified' }
  | { kind: 'keysUnavailable' }
  | { kind: 'signingKeyUnconfirmed'; retryAfterSeconds: number }
  | { kind: 'unverified'; reason: UnverifiedReason };

/**
 * What verifying a token under the keys already held found, nothing fetched: its claims and protected
 * header, or why it was not verified, as {@link TokenVerification} gives them; or that its key is not
 * held, none being held, those held having grown too old, or none of them being its key.
 */
export type HeldKeyVerification =
  | Extract<TokenVerification, { kind: 'unverified' | 'verified' }>
  | { kind: 'keyNotHeld' };

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

/** What the issuer's sign-in endpoints are read with: the clock the cooldown is measured on, and the trusted issuer. */
export type IssuerEndpointsSettings = Pick<
  ControllerConfiguration,
  'clock' | 'identityProviderIssuer'
>;

/** Where a failed read of the issuer's sign-in endpoints is written. */
export type IssuerEndpointsLog = Pick<EventLog, 'error'>;

/**
 * Why a read of the trusted issuer's sign-in endpoints failed, each a fixed cause and never a value the
 * read met: the provider gave no answer, as when it cannot be reached or answers too slowly; it
 * answered a status other than 200, a redirect among them; its discovery document is not a JSON
 * object naming the trusted issuer exactly; that document names an authorization or token endpoint
 * that is missing, not a string, not a URL, or reachable neither over https nor over http to a
 * loopback host; or it names one at an origin other than the issuer's.
 */
export type IssuerEndpointsFailure =
  | 'discoveryIssuer'
  | 'endpointLocation'
  | 'endpointOrigin'
  | 'status'
  | 'unreachable';

/** The trusted issuer's authorization and token endpoints, each at the issuer's origin, as URLs. */
export interface SignInEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/**
 * What asking for the issuer's sign-in endpoints found: the endpoints; or that they cannot be read
 * now, with the milliseconds of the configured clock until a read may start again, at most the
 * cooldown.
 */
export type IssuerEndpointsReading =
  | { endpoints: SignInEndpoints; kind: 'read' }
  | { kind: 'unavailable'; retryInMilliseconds: number };

/**
 * The trusted issuer's sign-in endpoints, read from its discovery document when first asked for and
 * held from then on.
 */
export interface IssuerEndpoints {
  /**
   * The endpoints: those held; else those of a read in flight, joined; else, unless a read failed
   * within the cooldown, those of a read it starts.
   */
  current(): Promise<IssuerEndpointsReading>;
}

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

  /** The keys held, never fetched: unavailable when none are held or they have grown too old. */
  held(): KeySetReading;

  /** The keys fetched anew, for a token whose key is not among those held, unless a fetch was tried too recently. */
  refreshed(): Promise<KeySetReading>;

  /** How long until the refetch cooldown lets a fetch start, in milliseconds of the configured clock: 0 once it does. */
  refetchInMilliseconds(): number;
}
