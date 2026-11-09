import type { KeyObject } from 'node:crypto';

/**
 * Why an assertion the controller could not verify was refused. One costs nothing to send, so it is
 * counted, as `channelAssertion.rejectionTally`, rather than recorded one by one.
 */
export type UnverifiedRejectionReason =
  | 'invalidSignature'
  | 'missingAssertion'
  | 'noLiveKey'
  | 'unknownApplication'
  | 'unreadableAssertion';

/**
 * Why an assertion that verifies under its application's key was refused anyway, each recorded as a
 * `channelAssertion.rejection`: `reusedAssertion` for one presented a second time, which only a copy of
 * it can be, and each other for its claims.
 */
export type VerifiedRejectionReason =
  | 'excessiveLifetime'
  | 'expiredAssertion'
  | 'notYetValid'
  | 'otherAudience'
  | 'reusedAssertion';

/** A live key as the verifier reads it: its application, and the subkey assertions are signed under. */
export interface AssertionKey {
  applicationId: string;

  /** Verifies the channel assertion: HMAC-SHA256. */
  channelAssertion: KeyObject;
}

/** Where the verifier finds an application's live keys, in memory. */
export interface LiveKeys<Key extends AssertionKey> {
  /**
   * An application's live keys: `undefined` when no application is registered under the id, and none
   * for one holding no live key.
   */
  liveKeysOf(applicationId: string): readonly Key[] | undefined;
}

/** A channel assertion the controller accepted. */
export interface VerifiedAssertion<Key> {
  /** The last instant it is accepted at, in milliseconds since the Unix epoch: its `exp` and the clock tolerance. */
  acceptedUntil: number;

  /** Its `jti`, unique to it. */
  id: string;

  /** The live key it verified under, which names its application and answers it. */
  key: Key;
}

/** What checking a request's channel assertion gave. */
export type ChannelAssertionCheck<Key> =
  | {
      /** The application the assertion names, while one is registered under its `iss`. */
      applicationId?: string;

      kind: 'unverified';
      reason: UnverifiedRejectionReason;
    }
  | {
      /** The application whose key the assertion verified under. */
      applicationId: string;

      kind: 'refused';
      reason: Exclude<VerifiedRejectionReason, 'reusedAssertion'>;
    }
  | { assertion: VerifiedAssertion<Key>; kind: 'verified' };

/** Checks the channel assertion a request carries. */
export interface ChannelAssertionVerifier<Key> {
  /**
   * Checks a request's channel assertion, reading the application's keys from memory alone.
   *
   * @param rawHeaders the request's header names and values, alternating, as Node gives them.
   */
  verify(rawHeaders: readonly string[]): Promise<ChannelAssertionCheck<Key>>;
}
