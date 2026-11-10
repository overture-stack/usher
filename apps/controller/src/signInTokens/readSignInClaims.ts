import { REFUSED_SUBJECT_MAXIMUM_LENGTH } from '../eventLog/index.js';
import { BACK_CHANNEL_LOGOUT_EVENT } from '../signOuts/index.js';
import { currencyOf } from './currencyOf.js';
import { namesAudience } from './namesAudience.js';
import { readNames } from './readNames.js';
import { sessionOf } from './sessionOf.js';
import type {
  SignInClaimsReading,
  SignInClaimsRefusal,
  SignInRefusal,
  TokenContents,
} from './types.js';

/**
 * The refusals of a token's contents the audit trail names its verified subject for, in
 * `refusedSubject`: those for its times and its audience. No other refusal of its contents names it,
 * so for no other is its signature worth checking. The standing refusals, decided once a token is
 * accepted, name it too.
 */
export const SUBJECT_NAMING_REFUSALS: ReadonlySet<SignInRefusal> = new Set([
  'expiredToken',
  'missingExpiry',
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
// declares: the back-channel logout among its `events`, whatever that member holds, or its type.
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
 * Judges a sign-in token's claims for the exchange at an instant, in this order. It must not be a
 * logout token: one whose `events` hold the back-channel logout member, or whose header's `typ` is
 * `logout+jwt` in any letter case, with or without the `application/` prefix, is refused as
 * `otherType` whatever else it carries. Its names must be readable, as {@link readNames} reads them on
 * every route. Its `exp` is required and must not have passed, and any `nbf` must be reached, each
 * within the clock tolerance. And its `aud`, one string or a list, must name the calling application.
 * A refusal in {@link SUBJECT_NAMING_REFUSALS} names the token's `sub` in `refusedSubject` when that is
 * at most {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters, and no other refusal names it. Its issuer
 * and signature are the verifier's to judge, and are not judged here.
 *
 * @param token the token's claims and protected header.
 * @param audience the calling application's id.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const readSignInClaims = (
  token: TokenContents,
  audience: string,
  now: number,
): SignInClaimsReading => {
  if (isLogoutToken(token)) {
    return refused('otherType');
  }
  const { claims } = token;
  const names = readNames(claims);
  if (names.kind === 'refused') {
    return refused(names.reason);
  }
  const { subject } = names;
  const currency = currencyOf(claims, now);
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
