import { REFUSED_SUBJECT_MAXIMUM_LENGTH } from '../eventLog/index.js';
import { BACK_CHANNEL_LOGOUT_EVENT } from '../signOuts/index.js';
import { currencyOf } from './currencyOf.js';
import { EXCESSIVE_LIFETIME } from './excessiveLifetime.js';
import { isKeycloakAccessToken } from './isKeycloakAccessToken.js';
import { MISSING_ISSUED_AT } from './missingIssuedAt.js';
import { namesAudience } from './namesAudience.js';
import { readNames } from './readNames.js';
import { sessionOf } from './sessionOf.js';
import type {
  SignInClaimsReading,
  SignInClaimsRefusal,
  SignInJudgementContext,
  SignInRefusal,
  TokenContents,
} from './types.js';

/**
 * The refusals of a token's contents that name its verified subject, in `refusedSubject`: those for
 * its times and its audience. No other refusal of its contents names it.
 */
export const SUBJECT_NAMING_REFUSALS: ReadonlySet<SignInRefusal> = new Set([
  EXCESSIVE_LIFETIME,
  'expiredToken',
  'missingExpiry',
  MISSING_ISSUED_AT,
  'notYetValid',
  'otherAudience',
]);

// The header type Back-Channel Logout 1.0 gives a logout token, compared as RFC 7515 compares a media
// type: in any letter case, with `application/` taken as given where it is left out.
const LOGOUT_TOKEN_TYPE = 'logout+jwt';

const APPLICATION_PREFIX = /^application\//u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The same provider signs logout tokens and sign-in tokens, so a logout token is told apart by what it
// declares: the back-channel logout among its `events`, whatever that member holds, or its type. Read
// alongside the access-token recognition, so a logout token is refused whatever its payload's `typ`.
const isLogoutToken = ({ claims, header }: TokenContents): boolean => {
  const { events } = claims;
  const { typ } = header;
  return (
    (isRecord(events) && Object.hasOwn(events, BACK_CHANNEL_LOGOUT_EVENT)) ||
    (typeof typ === 'string' &&
      typ.toLowerCase().replace(APPLICATION_PREFIX, '') === LOGOUT_TOKEN_TYPE)
  );
};

const refused = (
  reason: SignInClaimsRefusal,
  subject?: string,
): SignInClaimsReading => ({
  kind: 'refused',
  reason,
  ...(subject !== undefined &&
  SUBJECT_NAMING_REFUSALS.has(reason) &&
  subject.length <= REFUSED_SUBJECT_MAXIMUM_LENGTH
    ? { refusedSubject: subject }
    : {}),
});

/**
 * Judges a sign-in token's claims for the exchange at an instant, in this order. It must be an access
 * token, as its identity provider's connector recognizes one: Keycloak's, by
 * {@link isKeycloakAccessToken}. And it must not be a logout token: one whose `events` hold the
 * back-channel logout member, or whose header's `typ` is `logout+jwt` in any letter case, with or
 * without the `application/` prefix. A token failing either is refused as `otherType` whatever else it
 * carries. Its names must be ones {@link readNames} reads. Its `exp` is required and must not have
 * passed, within the clock tolerance; its `iat` is required, and its `exp` must fall at most the
 * longest lifetime a sign-in token may have after it, with no tolerance; and any `nbf` must be
 * reached, within the tolerance. And its `aud`, one string or a list, must name the calling
 * application. A refusal in {@link SUBJECT_NAMING_REFUSALS} names the token's `sub` in
 * `refusedSubject` when that is at most {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters, and no
 * other refusal names it. Its issuer and signature are not judged.
 *
 * @param token the token's claims and protected header.
 * @param context the calling application's id, the instant, and the longest lifetime a sign-in token
 *   may have.
 */
export const readSignInClaims = (
  token: TokenContents,
  {
    audience,
    now,
    signInTokenMaximumLifetimeSeconds,
  }: Omit<SignInJudgementContext, 'verifier'>,
): SignInClaimsReading => {
  if (isLogoutToken(token) || !isKeycloakAccessToken(token)) {
    return refused('otherType');
  }
  const { claims } = token;
  const names = readNames(claims);
  if (names.kind === 'refused') {
    return refused(names.reason);
  }
  const { subject } = names;
  const currency = currencyOf(
    claims,
    { signInTokenMaximumLifetimeSeconds },
    now,
  );
  if (currency.kind === 'refused') {
    return refused(currency.reason, subject);
  }
  return namesAudience(claims, audience)
    ? {
        expiresAt: currency.expiresAt,
        kind: 'accepted',
        session: sessionOf(claims),
        subject,
      }
    : refused('otherAudience', subject);
};
