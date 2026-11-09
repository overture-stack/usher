import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import { isStorableText } from '../managementApi/index.js';
import type {
  LogoutTokenReading,
  LogoutTokenRefusal,
  LogoutTokenSettings,
  VerifiedLogoutToken,
} from './types.js';

/** The member of a logout token's `events` claim declaring it a logout token. */
export const BACK_CHANNEL_LOGOUT_EVENT =
  'http://schemas.openid.net/event/backchannel-logout';

/** The longest subject a refusal names: OpenID Connect's longest; a longer one is left out, never cut short. */
export const REFUSED_SUBJECT_MAXIMUM_LENGTH = 255;

// The header types a logout token may carry beside none: the explicit type Back-Channel Logout 1.0
// recommends, and the generic one, each compared as RFC 7515 compares a media type, in any letter
// case and with `application/` taken as given where it is left out.
const LOGOUT_TOKEN_TYPES: ReadonlySet<string> = new Set(['jwt', 'logout+jwt']);

const APPLICATION_PREFIX = /^application\//u;

type Name =
  | { kind: 'absent' }
  | { kind: 'named'; value: string }
  | { kind: 'refused'; reason: LogoutTokenRefusal };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const audiencesOf = (aud: unknown): readonly unknown[] =>
  Array.isArray(aud) ? aud : [aud];

const nameOf = (claims: TokenClaims, member: 'sid' | 'sub'): Name => {
  if (!Object.hasOwn(claims, member)) {
    return { kind: 'absent' };
  }
  const value = claims[member];
  if (typeof value !== 'string' || value === '') {
    return { kind: 'refused', reason: 'unreadableName' };
  }
  return isStorableText(value)
    ? { kind: 'named', value }
    : { kind: 'refused', reason: 'unrepresentableName' };
};

const isLogoutTokenType = (typ: unknown): boolean =>
  typ === undefined ||
  (typeof typ === 'string' &&
    LOGOUT_TOKEN_TYPES.has(typ.toLowerCase().replace(APPLICATION_PREFIX, '')));

// What makes a token a logout token rather than an ID or access token signed by the same provider
// is its claims, judged whatever its header's type, since a provider may leave the type out:
// `events` declaring the back-channel logout, and no `nonce`. The type refuses only a token typed
// as another kind.
const kindRefusal = ({
  claims,
  header,
}: VerifiedLogoutToken): LogoutTokenRefusal | undefined => {
  const { events } = claims;
  const declared = isRecord(events)
    ? events[BACK_CHANNEL_LOGOUT_EVENT]
    : undefined;
  if (!isRecord(declared)) {
    return 'notLogoutEvent';
  }
  if (Object.hasOwn(claims, 'nonce')) {
    return 'carriesNonce';
  }
  return isLogoutTokenType(header['typ']) ? undefined : 'otherType';
};

type Currency =
  | { issuedAt: number; kind: 'current' }
  | { kind: 'refused'; reason: LogoutTokenRefusal };

const notCurrent = (reason: LogoutTokenRefusal): Currency => ({
  kind: 'refused',
  reason,
});

// The token's times, each judged within the clock tolerance but the age of its issue. A token
// issued longer ago than the longest sign-in token lifetime is refused, so any token accepted names
// a time whose sign-out, if recorded already, is still held, and a repeat is told apart by what the
// store holds.
const currencyOf = (
  { exp, iat, nbf }: TokenClaims,
  { signInTokenMaximumLifetimeSeconds }: LogoutTokenSettings,
  now: number,
): Currency => {
  if (!isTime(iat)) {
    return notCurrent('missingIssuedAt');
  }
  if (iat * 1000 >= now + CLOCK_TOLERANCE_MILLISECONDS) {
    return notCurrent('notYetValid');
  }
  if (iat * 1000 < now - signInTokenMaximumLifetimeSeconds * 1000) {
    return notCurrent('issuedLongAgo');
  }
  if (!isTime(exp)) {
    return notCurrent('missingExpiry');
  }
  if (now >= exp * 1000 + CLOCK_TOLERANCE_MILLISECONDS) {
    return notCurrent('expiredToken');
  }
  return nbf === undefined ||
    (isTime(nbf) && nbf * 1000 <= now + CLOCK_TOLERANCE_MILLISECONDS)
    ? { issuedAt: iat, kind: 'current' }
    : notCurrent('notYetValid');
};

/**
 * Judges a token verified under the trusted identity provider as a logout token, as OpenID Connect
 * Back-Channel Logout 1.0 has it validated, at an instant. It must be a logout token: its `events`
 * hold the back-channel logout member as a JSON object and it carries no `nonce`, both judged
 * whatever its header's `typ`, which must be absent, or `logout+jwt` or `JWT` in any letter case,
 * with or without the `application/` prefix. It must be issued for this deployment alone: its
 * `aud`, one string or a list, names at least one configured back-channel logout client and nothing
 * else, as OpenID Connect Core 1.0 §3.1.3.7 has an ID token's audience judged. It must be current:
 * `iat` neither ahead by the clock tolerance or more nor older than the longest sign-in token
 * lifetime, `exp` not passed and any `nbf` reached, each within the tolerance. And it must name a
 * session in `sid`, a subject in `sub`, or both, each non-empty text the store can hold. A refusal
 * names the token's `sub` when that is non-empty storable text of at most
 * {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters. Its issuer and signature are the verifier's to
 * judge, and are not judged again here.
 *
 * @param token the verified token's claims and protected header.
 * @param settings the configured back-channel logout clients and the longest sign-in token lifetime.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const readLogoutToken = (
  token: VerifiedLogoutToken,
  settings: LogoutTokenSettings,
  now: number,
): LogoutTokenReading => {
  const { claims } = token;
  const subject = nameOf(claims, 'sub');
  const refused = (reason: LogoutTokenRefusal): LogoutTokenReading => ({
    kind: 'refused',
    reason,
    subject:
      subject.kind === 'named' &&
      subject.value.length <= REFUSED_SUBJECT_MAXIMUM_LENGTH
        ? subject.value
        : undefined,
  });
  const kind = kindRefusal(token);
  if (kind !== undefined) {
    return refused(kind);
  }
  const audiences = audiencesOf(claims['aud']);
  const isConfigured = (audience: unknown): boolean =>
    typeof audience === 'string' &&
    settings.backChannelLogoutAudiences.includes(audience);
  if (audiences.length === 0 || !audiences.every(isConfigured)) {
    return refused('otherAudience');
  }
  const currency = currencyOf(claims, settings, now);
  if (currency.kind === 'refused') {
    return refused(currency.reason);
  }
  const { issuedAt } = currency;
  const session = nameOf(claims, 'sid');
  if (session.kind === 'refused') {
    return refused(session.reason);
  }
  if (subject.kind === 'refused') {
    return refused(subject.reason);
  }
  if (session.kind === 'named') {
    return {
      kind: 'accepted',
      signOut: {
        issuedAt,
        kind: 'session',
        sessionId: session.value,
        subject: subject.kind === 'named' ? subject.value : undefined,
      },
    };
  }
  return subject.kind === 'named'
    ? {
        kind: 'accepted',
        signOut: { issuedAt, kind: 'subject', subject: subject.value },
      }
    : refused('namesNoOne');
};
