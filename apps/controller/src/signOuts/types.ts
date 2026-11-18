import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail, EventLog } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type {
  TokenClaims,
  TokenHeader,
  TokenVerification,
} from '../identityProvider/index.js';
import type { WindowedRefusals } from '../windowedRefusals/index.js';

/** What the back-channel logout route reads of the configuration. */
export type SignOutSettings = Pick<
  ControllerConfiguration,
  | 'backChannelLogoutAudiences'
  | 'clock'
  | 'databaseSchema'
  | 'identityProviderIssuer'
  | 'signInTokenMaximumLifetimeSeconds'
>;

/** What judging a logout token reads of the configuration. */
export type LogoutTokenSettings = Pick<
  ControllerConfiguration,
  'backChannelLogoutAudiences' | 'signInTokenMaximumLifetimeSeconds'
>;

/** What the back-channel logout route verifies a token through: the trusted identity provider's verifier. */
export interface LogoutTokenVerifier {
  /**
   * Verifies a compact signed token under the trusted issuer's published keys, giving its claims and
   * protected header once it verifies, or why it does not, or that the keys cannot be had.
   */
  verify(token: string): Promise<TokenVerification>;
}

/**
 * Why a logout token that did not verify is refused, each the `reason` of its `logoutToken.refusal`
 * and of the `logoutToken.refusalTally` closing its window: it could not be read as a signed token
 * (`unreadableToken`), names an issuer other than the trusted one (`otherIssuer`), or verifies under
 * none of the trusted issuer's published keys (`invalidSignature`). The back-channel logout lists
 * these itself, since they are its audit trail's vocabulary: a reason the verifier adds is mapped
 * onto one of them, or added here, by a decision made in this module.
 */
export type UnverifiedLogoutReason =
  'invalidSignature' | 'otherIssuer' | 'unreadableToken';

/** What the back-channel logout route is built from. */
export interface SignOutRouteSettings {
  /** Where a failure of the store, or one the route did not expect, is written. */
  eventLog: Pick<EventLog, 'error'>;

  /** Where each refused logout token is counted, the refusal opening a window recorded. */
  refusals: Pick<WindowedRefusals, 'refuse'>;

  settings: SignOutSettings;

  /**
   * The verifier of the trusted identity provider's tokens, the one every route verifying such a token
   * shares, so the signing keys fetched for one are held for all.
   */
  tokenVerifier: LogoutTokenVerifier;

  /**
   * Where each sign-out commits, with its notice and its event, before it is answered, and where a
   * verified token refused anyway is recorded.
   */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction' | 'recordEvent'>;
}

/** A back-channel logout request as it is read: its URL as sent, its content type, and its body. */
export interface LogoutRequest {
  /** The body's bytes; absent for a request sending none. */
  body: Uint8Array | undefined;

  /** The `content-type` header's value; absent for a request sending none. */
  contentType: string | undefined;

  /** The request's target as sent, its query included. */
  url: string;
}

/** What reading a back-channel logout request gave: the logout token it carries, or its refusal. */
export type LogoutRequestReading =
  { kind: 'read'; token: string } | { kind: 'refused'; problem: Problem };

/** A token whose signature verified under the trusted identity provider: its claims and its protected header. */
export interface VerifiedLogoutToken {
  claims: TokenClaims;
  header: TokenHeader;
}

/**
 * Why a verified token is refused as a logout token, each a fixed code. Not a logout token: its
 * `events` hold no back-channel logout member as a JSON object (`notLogoutEvent`), it carries a
 * `nonce` (`carriesNonce`), or its header names another type (`otherType`). For another audience:
 * its `aud` names no configured back-channel logout client, or names one beside an audience outside
 * them (`otherAudience`). Not current: it names no
 * `iat` (`missingIssuedAt`) or no `exp` (`missingExpiry`), was issued longer ago than the longest
 * sign-in token lifetime (`issuedLongAgo`), has expired (`expiredToken`), or is not valid yet, its
 * `iat` or its `nbf` ahead by the clock tolerance or more (`notYetValid`). Naming no one: neither `sub` nor `sid`
 * (`namesNoOne`), one that is not non-empty text (`unreadableName`), or one the store cannot hold
 * (`unrepresentableName`).
 */
export type LogoutTokenRefusal =
  | 'carriesNonce'
  | 'expiredToken'
  | 'issuedLongAgo'
  | 'missingExpiry'
  | 'missingIssuedAt'
  | 'namesNoOne'
  | 'notLogoutEvent'
  | 'notYetValid'
  | 'otherAudience'
  | 'otherType'
  | 'unreadableName'
  | 'unrepresentableName';

/**
 * A sign-out a logout token relays: of a session, named by its `sid`, with the subject when the token
 * names one too; or of a subject alone, for a token naming no session. Either carries the token's
 * `iat`, when the identity provider signed the person out, in seconds since the Unix epoch.
 */
export type SignOut =
  | {
      issuedAt: number;
      kind: 'session';
      sessionId: string;
      subject: string | undefined;
    }
  | { issuedAt: number; kind: 'subject'; subject: string };

/**
 * What judging a verified logout token gave: the sign-out it relays; or why it is refused, with the
 * subject its `sub` names where that is non-empty text the store can hold, of at most 255 characters,
 * and `undefined` otherwise.
 */
export type LogoutTokenReading =
  | { kind: 'accepted'; signOut: SignOut }
  | {
      kind: 'refused';
      reason: LogoutTokenRefusal;
      subject: string | undefined;
    };

/**
 * What recording a sign-out needs beyond the sign-out: the store's schema, the issuer, how long the
 * record is kept, and the request relaying it.
 */
export interface SignOutRecordContext {
  /** The trusted identity provider's issuer, which every sign-out it relays is recorded under. */
  issuer: string;

  /** How long a sign-out is kept after it, in seconds: the longest a sign-in token it concerns may live. */
  retentionSeconds: number;

  schema: string;

  /** The address of the request relaying the sign-out, as its event names it. */
  sourceIp: string;
}

/**
 * What recording a sign-out found: that it was recorded, with the subject its principal notice names
 * where one is known; or that the store holds it already, so nothing was written.
 */
export type SignOutRecording =
  { kind: 'held' } | { kind: 'recorded'; subject: string | undefined };
