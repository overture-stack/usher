import { compactVerify, decodeJwt, decodeProtectedHeader } from 'jose';

import type { Clock } from '../configuration/index.js';
import { CLOCK_TOLERANCE_MILLISECONDS } from '../managementApi/index.js';
import type {
  AssertionKey,
  ChannelAssertionCheck,
  ChannelAssertionVerifier,
  LiveKeys,
  UnverifiedRejectionReason,
} from './types.js';

/** The `typ` every channel assertion carries, matched exactly. */
export const CHANNEL_ASSERTION_TYPE = 'usher-channel+jwt';

/** The `aud` every channel assertion names: the controller, for its exchange, push and poll. */
export const CHANNEL_ASSERTION_AUDIENCE = 'usher:controller';

/** The longest a channel assertion may live, from its `iat` to its `exp`, in seconds. */
export const CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS = 60;

// RFC 6750's credential: a scheme, Bearer in any letter case, then one token68.
const SCHEME_AND_TOKEN =
  /^(?<scheme>[A-Za-z]+) +(?<token>[A-Za-z0-9._~+/-]+=*)$/u;

type Claims = Readonly<Record<string, unknown>>;

// The claims an assertion is judged by, once read as the numbers and the id they must be.
interface JudgedClaims {
  aud: unknown;
  exp: number;
  iat: number;
  jti: string;
}

const unverified = <Key>(
  reason: UnverifiedRejectionReason,
  applicationId?: string,
): ChannelAssertionCheck<Key> =>
  applicationId === undefined
    ? { kind: 'unverified', reason }
    : { applicationId, kind: 'unverified', reason };

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// The assertion a request carries: one Authorization header holding a Bearer credential, or why none
// is read. A request holding another scheme, or the scheme alone, presents no assertion.
const assertionOf = (
  rawHeaders: readonly string[],
): { assertion: string } | { reason: UnverifiedRejectionReason } => {
  const values = rawHeaders.flatMap((name, index) =>
    index % 2 === 0 && name.toLowerCase() === 'authorization'
      ? [rawHeaders[index + 1] ?? '']
      : [],
  );
  if (values.length > 1) {
    return { reason: 'unreadableAssertion' };
  }
  const { scheme, token } =
    SCHEME_AND_TOKEN.exec(values[0]?.trim() ?? '')?.groups ?? {};
  return scheme?.toLowerCase() === 'bearer' && token !== undefined
    ? { assertion: token }
    : { reason: 'missingAssertion' };
};

// What an assertion claims, read before it is verified, so its keys can be found and its shape judged
// at no cost. A JWS of another `typ`, or naming no `iss`, reads as none. The signature verified later
// covers exactly the bytes read here, so once it verifies these claims are the assertion's own.
const claimsOf = (
  assertion: string,
): { application: string; claims: Claims } | undefined => {
  try {
    if (decodeProtectedHeader(assertion).typ !== CHANNEL_ASSERTION_TYPE) {
      return undefined;
    }
    const claims = decodeJwt(assertion);
    const { iss } = claims;
    return typeof iss === 'string' && iss !== ''
      ? { application: iss, claims }
      : undefined;
  } catch {
    return undefined;
  }
};

// The times and the id an assertion is judged by, or `undefined` when it holds no numeric `iat` and
// `exp` with the `exp` after the `iat`, or no `jti`.
const judgedOf = ({ aud, exp, iat, jti }: Claims): JudgedClaims | undefined =>
  isTime(iat) &&
  isTime(exp) &&
  exp > iat &&
  typeof jti === 'string' &&
  jti !== ''
    ? { aud, exp, iat, jti }
    : undefined;

// The first key the assertion verifies under, HS256 alone; no error leaves it, since jose's can quote
// what it read.
const verifyingKey = async <Key extends AssertionKey>(
  assertion: string,
  keys: readonly Key[],
): Promise<Key | undefined> => {
  const outcomes = await Promise.all(
    keys.map(async (key) => {
      try {
        await compactVerify(assertion, key.channelAssertion, {
          algorithms: ['HS256'],
        });
        return key;
      } catch {
        return undefined;
      }
    }),
  );
  return outcomes.find((outcome) => outcome !== undefined);
};

/**
 * Creates the verifier of channel assertions, refusing each at its cheapest failing check and reading
 * nothing from the store. Checks that need no key come first, and their refusals are `unverified`:
 *
 * - the assertion is read from the one `Authorization` header holding a Bearer credential: none, the
 *   scheme alone or another scheme is `missingAssertion`, and two headers are `unreadableAssertion`;
 * - a credential that is no JWS of `typ` `usher-channel+jwt` naming its application in `iss` is
 *   `unreadableAssertion`;
 * - the application's live keys are found in memory: none registered under the id is
 *   `unknownApplication`, and one holding no live key `noLiveKey`;
 * - claims holding no numeric `iat` and `exp` with the `exp` after the `iat`, or no `jti`, are
 *   `unreadableAssertion`;
 * - the assertion must verify under one of the live keys, HS256 alone, else `invalidSignature`.
 *
 * The key it verifies under answers it. Its verified claims are judged last, each refusal `refused`:
 * an `aud` other than `usher:controller` is `otherAudience`; an `exp` more than 60 s after `iat` is
 * `excessiveLifetime`; an `exp` passed by the clock tolerance or more is `expiredAssertion`; and an
 * `iat` ahead by the tolerance or more is `notYetValid`. Every refusal past the application's lookup
 * names the application.
 *
 * @param settings the clock times are judged on, and where the live keys are found.
 */
export const createChannelAssertionVerifier = <Key extends AssertionKey>({
  clock,
  keyRing,
}: {
  clock: Clock;
  keyRing: LiveKeys<Key>;
}): ChannelAssertionVerifier<Key> => ({
  verify: async (rawHeaders) => {
    const presented = assertionOf(rawHeaders);
    if ('reason' in presented) {
      return unverified(presented.reason);
    }
    const { assertion } = presented;
    const read = claimsOf(assertion);
    if (read === undefined) {
      return unverified('unreadableAssertion');
    }
    const { application: applicationId } = read;
    const keys = keyRing.liveKeysOf(applicationId);
    if (keys === undefined) {
      return unverified('unknownApplication');
    }
    if (keys.length === 0) {
      return unverified('noLiveKey', applicationId);
    }
    const judged = judgedOf(read.claims);
    if (judged === undefined) {
      return unverified('unreadableAssertion', applicationId);
    }
    const key = await verifyingKey(assertion, keys);
    if (key === undefined) {
      return unverified('invalidSignature', applicationId);
    }
    const { aud, exp, iat, jti } = judged;
    if (aud !== CHANNEL_ASSERTION_AUDIENCE) {
      return { applicationId, kind: 'refused', reason: 'otherAudience' };
    }
    if (exp - iat > CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS) {
      return { applicationId, kind: 'refused', reason: 'excessiveLifetime' };
    }
    const now = clock.now();
    const acceptedUntil = exp * 1000 + CLOCK_TOLERANCE_MILLISECONDS;
    if (now >= acceptedUntil) {
      return { applicationId, kind: 'refused', reason: 'expiredAssertion' };
    }
    if (iat * 1000 >= now + CLOCK_TOLERANCE_MILLISECONDS) {
      return { applicationId, kind: 'refused', reason: 'notYetValid' };
    }
    return { assertion: { acceptedUntil, id: jti, key }, kind: 'verified' };
  },
});
