import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type {
  HeldKeyVerification,
  TokenClaims,
  TokenHeader,
  TokenVerification,
} from '../identityProvider/index.js';
import type { EXCESSIVE_LIFETIME } from './excessiveLifetime.js';
import type { MISSING_ISSUED_AT } from './missingIssuedAt.js';

/** The session a sign-in token belongs to, as far as it names one. */
export interface Session {
  /** The token's `iat`, in seconds since the Unix epoch. */
  issuedAt?: number;

  /** The token's `sid`. */
  sid?: string;
}

/** Why the store refuses a principal whose token is otherwise accepted. */
export type StoredRefusal =
  'revokedPlatform' | 'revokedPrincipal' | 'signedOutSession';

/** Whose standing the store is asked about: the trusted issuer, the token's subject, and its session. */
export interface StandingQuestion {
  issuer: string;
  session: Session;
  subject: string;
}

/**
 * Where a principal's standing is read, outside any transaction: one statement at a time, each within
 * the store timeout, so a request is refused rather than held open when the store stops answering.
 */
export interface StoreReader {
  /**
   * Runs one statement on a connection of its own, within the store timeout.
   *
   * @param text the statement, every value bound.
   * @param values the values bound to it.
   */
  query<Row extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

/** What judging a token's times reads of the configuration: the longest lifetime a token may have. */
export type CurrencySettings = Pick<
  ControllerConfiguration,
  'signInTokenMaximumLifetimeSeconds'
>;

/**
 * Why a token's times refuse it: it names no `exp` (`missingExpiry`), its `exp` has passed
 * (`expiredToken`), it names no `iat` ({@link MISSING_ISSUED_AT}), its `exp` falls more than the
 * longest lifetime a token may have after its `iat` ({@link EXCESSIVE_LIFETIME}), or its `nbf` is not
 * reached yet (`notYetValid`).
 */
export type CurrencyRefusal =
  | 'expiredToken'
  | 'missingExpiry'
  | 'notYetValid'
  | typeof EXCESSIVE_LIFETIME
  | typeof MISSING_ISSUED_AT;

/** What a token's times gave: current, with its `exp` in seconds since the Unix epoch, or refused. */
export type TokenCurrency =
  | { expiresAt: number; kind: 'current' }
  | { kind: 'refused'; reason: CurrencyRefusal };

/**
 * A credential's shape, read from its text alone before anything of it is verified: empty; a compact
 * JWS, the one shape verified as a sign-in token; a compact JWE, read as an Usher token presented back;
 * or anything else, an opaque credential, as an API key is.
 */
export type CredentialShape =
  'empty' | 'encryptedToken' | 'opaque' | 'signedToken';

/** A signed token's protected header and claims, as its claims are judged. */
export interface TokenContents {
  claims: TokenClaims;
  header: TokenHeader;
}

/**
 * Why a sign-in token's names refuse it, on every route reading one: no `sub`, or one that is not
 * non-empty text (`missingSubject`); or a `sub`, or a `sid` it carries, that is not text the store can
 * hold (`unrepresentableSubject`).
 */
export type NamesRefusal = 'missingSubject' | 'unrepresentableSubject';

/** What a sign-in token's names gave: the subject it acts for, or a refusal. */
export type NamesReading =
  | { kind: 'named'; subject: string }
  | { kind: 'refused'; reason: NamesRefusal };

/**
 * Why the exchange refuses a signed token for what it carries, each a fixed code naming the fault and
 * never a value from it: a token other than an access token presented, an ID token or a logout token
 * among them (`otherType`); names refused, as {@link NamesRefusal} gives them; times refused, as
 * {@link CurrencyRefusal} gives them; or an `aud` that does not name the calling application
 * (`otherAudience`).
 */
export type SignInClaimsRefusal =
  'otherAudience' | 'otherType' | CurrencyRefusal | NamesRefusal;

/**
 * What a sign-in token's claims gave the exchange: the subject it acts for, with the token's session
 * and its `exp` in seconds since the Unix epoch; or a refusal, naming the token's `sub` in
 * `refusedSubject` where the audit trail names it for that reason.
 */
export type SignInClaimsReading =
  | { expiresAt: number; kind: 'accepted'; session: Session; subject: string }
  | { kind: 'refused'; reason: SignInClaimsRefusal; refusedSubject?: string };

/** Why a signed token is refused by its contents, read before its signature is checked: unreadable as one, or for what it carries. */
export type ContentsRefusal = SignInClaimsRefusal | 'unreadableToken';

/**
 * Why the exchange refuses a credential, each a fixed code naming the fault and never a value from it:
 * empty (`missingCredential`); encrypted, as an Usher token presented back is (`unreadableToken`); opaque
 * with no API key verifier configured (`apiKeyVerifierNotConfigured`); a signed token unreadable as one
 * (`unreadableToken`), naming an issuer other than the trusted one (`otherIssuer`), or verifying under
 * none of its published keys (`invalidSignature`); or a signed token refused for what it carries. The
 * exchange lists these itself, since they are its audit trail's vocabulary: a reason the verifier adds is
 * mapped onto one of them, or added here.
 */
export type SignInRefusal =
  | 'apiKeyVerifierNotConfigured'
  | 'invalidSignature'
  | 'missingCredential'
  | 'otherIssuer'
  | ContentsRefusal;

/**
 * A credential refused, and recorded as a `token.exchange` event of its own, `result` denied: its
 * reason, and the token's `sub` in `refusedSubject` only where the token verified and the audit trail
 * names it for that reason.
 */
export interface RecordedRefusal {
  kind: 'recorded';
  reason: SignInRefusal;
  refusedSubject?: string;
}

/**
 * What judging a credential presented at the exchange found. Accepted: the subject it acts for, the
 * token's session and `exp`, and its verified claims. Refused and recorded, every refusal answered
 * alike. Or not judged, for a token its contents did not refuse: the trusted issuer's keys could not
 * be had (`keysUnavailable`), or its signing key is not confirmed yet (`signingKeyUnconfirmed`), with
 * the whole seconds the caller is told to wait.
 */
export type SignInJudgement =
  | {
      claims: TokenClaims;
      expiresAt: number;
      kind: 'accepted';
      session: Session;
      subject: string;
    }
  | RecordedRefusal
  | { kind: 'keysUnavailable' }
  | { kind: 'signingKeyUnconfirmed'; retryAfterSeconds: number };

/**
 * Where the exchange verifies a signed token: the verifier every route verifying the identity
 * provider's tokens shares, so the signing keys fetched for one are held for all.
 */
export interface SignInTokenVerifier {
  /**
   * Verifies a compact signed token under the trusted issuer's published keys, fetching them if need
   * be, for a token its contents did not refuse: its claims and protected header once it verifies, why
   * it does not, or that the keys could not be had to verify it.
   *
   * @param token the credential, a compact JWS.
   */
  verify(token: string): Promise<TokenVerification>;

  /**
   * Verifies a compact signed token under the keys already held alone, fetching nothing: for a token
   * its contents refused, whose signature decides only whether its subject is named.
   *
   * @param token the credential, a compact JWS.
   */
  verifyHeld(token: string): Promise<HeldKeyVerification>;
}

/**
 * What a credential is judged against: the calling application, the instant, the longest lifetime a
 * sign-in token may have, and the verifier.
 */
export interface SignInJudgementContext {
  /** The calling application's id, which a sign-in token's `aud` must name. */
  audience: string;

  /** The instant, in milliseconds since the Unix epoch. */
  now: number;

  /** The most seconds a sign-in token's `exp` may fall after its `iat`, the configuration's. */
  signInTokenMaximumLifetimeSeconds: number;

  verifier: SignInTokenVerifier;
}
