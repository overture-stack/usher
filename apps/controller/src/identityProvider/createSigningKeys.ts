import type { JWK } from 'jose';

import { discoveryUrl } from './discoveryUrl.js';
import type {
  KeySetFetchFailure,
  KeySetReading,
  SigningKeys,
  TokenVerifierLog,
  TokenVerifierSettings,
} from './types.js';

/** How long a fetched key set is trusted before it is fetched again, in milliseconds of the configured clock. */
export const KEY_SET_MAXIMUM_AGE_MILLISECONDS = 600_000;

/** The least time between two fetches of the key set, in milliseconds of the configured clock. */
export const KEY_REFETCH_COOLDOWN_MILLISECONDS = 30_000;

/** The line naming a fetch of the trusted issuer's key set that failed, and its cause. */
export const KEY_SET_FETCH_FAILED = 'identityProvider.keySetFetchFailed';

// A fetch the provider never answers ends here, in real time, so one silent provider holds no request
// open for long.
const FETCH_TIMEOUT_MILLISECONDS = 5000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost',
]);

const UNAVAILABLE: KeySetReading = Object.freeze({ kind: 'unavailable' });

// What one step of a fetch gave: its value, or the fixed cause it failed for.
type Step<Value> =
  | { cause: KeySetFetchFailure; kind: 'failed' }
  | { kind: 'obtained'; value: Value };

const failed = (cause: KeySetFetchFailure): Step<never> => ({
  cause,
  kind: 'failed',
});

const obtained = <Value>(value: Value): Step<Value> => ({
  kind: 'obtained',
  value,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The same rule the issuer itself is read under: nothing the controller trusts crosses a network in
// the clear.
const isSecure = (url: URL): boolean =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));

const parsedJson = (
  text: string,
  unreadable: KeySetFetchFailure,
): Step<unknown> => {
  try {
    return obtained(JSON.parse(text));
  } catch {
    return failed(unreadable);
  }
};

// A redirect is taken as answered, never followed, so it fails as a status other than 200.
const fetchedJson = async (
  url: URL,
  unreadable: KeySetFetchFailure,
): Promise<Step<unknown>> => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  });
  if (response.status === 200) {
    return parsedJson(await response.text(), unreadable);
  }
  await response.body?.cancel();
  return failed('status');
};

// A key the provider publishes for verifying signatures: never one published for encryption, and never
// a private key, which no provider publishes on purpose.
const isSigningKey = (key: unknown): key is JWK =>
  isRecord(key) &&
  typeof key['kty'] === 'string' &&
  key['use'] !== 'enc' &&
  !Object.hasOwn(key, 'd');

const keySetUrl = (discovery: unknown, issuer: string): Step<URL> => {
  if (isRecord(discovery) && discovery['issuer'] === issuer) {
    const named = discovery['jwks_uri'];
    const url = typeof named === 'string' ? URL.parse(named) : null;
    return url !== null && isSecure(url)
      ? obtained(url)
      : failed('keySetLocation');
  }
  return failed('discoveryIssuer');
};

const fetchSigningKeys = async (
  issuer: string,
): Promise<Step<readonly JWK[]>> => {
  const discovery = await fetchedJson(discoveryUrl(issuer), 'discoveryIssuer');
  if (discovery.kind === 'failed') {
    return discovery;
  }
  const location = keySetUrl(discovery.value, issuer);
  if (location.kind === 'failed') {
    return location;
  }
  const keySet = await fetchedJson(location.value, 'keySetShape');
  if (keySet.kind === 'failed') {
    return keySet;
  }
  return isRecord(keySet.value) && Array.isArray(keySet.value['keys'])
    ? obtained(keySet.value['keys'].filter(isSigningKey))
    : failed('keySetShape');
};

interface KeyCache {
  attemptedAt: number | undefined;
  fetchedAt: number | undefined;
  inFlight: Promise<KeySetReading> | undefined;
  keys: readonly JWK[] | undefined;
  latestFetchFailed: boolean;
}

/**
 * Creates the trusted issuer's signing keys, fetching nothing until they are first asked for. A key set
 * is fetched through the issuer's discovery document, which must name the issuer exactly and a key set
 * reachable over https, or over http to a loopback host; keys published for encryption are left out.
 * A key set is trusted for {@link KEY_SET_MAXIMUM_AGE_MILLISECONDS}, and fetched at most once in
 * {@link KEY_REFETCH_COOLDOWN_MILLISECONDS}, both measured on the configured clock; concurrent askers
 * share one fetch. A failed fetch keeps what is held, and keys grown too old are never given. Each
 * failed fetch writes {@link KEY_SET_FETCH_FAILED} at error naming its fixed cause alone, never a URL
 * or anything the provider answered, so the cooldown bounds the lines as it bounds the fetches. A
 * reading of the keys says whether it fetched them, by a fetch it started or joined, and whether the
 * latest fetch failed; the time left in the cooldown is read apart, for an answer telling a caller
 * when a key absent from those held can be looked for again.
 *
 * @param settings the clock, and the trusted issuer.
 * @param eventLog where a failed fetch is written.
 */
export const createSigningKeys = (
  { clock, identityProviderIssuer }: TokenVerifierSettings,
  eventLog: TokenVerifierLog,
): SigningKeys => {
  const cache: KeyCache = {
    attemptedAt: undefined,
    fetchedAt: undefined,
    inFlight: undefined,
    keys: undefined,
    latestFetchFailed: false,
  };
  const held = (fetched: boolean): KeySetReading =>
    cache.keys !== undefined &&
    cache.fetchedAt !== undefined &&
    clock.now() - cache.fetchedAt < KEY_SET_MAXIMUM_AGE_MILLISECONDS
      ? {
          fetched,
          keys: cache.keys,
          kind: 'held',
          latestFetchFailed: cache.latestFetchFailed,
        }
      : UNAVAILABLE;
  const refetchInMilliseconds = (): number =>
    cache.attemptedAt === undefined
      ? 0
      : Math.max(
          0,
          cache.attemptedAt + KEY_REFETCH_COOLDOWN_MILLISECONDS - clock.now(),
        );
  const coolingDown = (): boolean => refetchInMilliseconds() > 0;
  const fetchOnce = async (): Promise<KeySetReading> => {
    cache.attemptedAt = clock.now();
    // The fetch leaves flight however it ends, so no later asker joins one that rejected.
    try {
      // What a fetch throws, it throws for want of an answer: a connection refused or cut, or no
      // answer within the timeout.
      const outcome = await fetchSigningKeys(identityProviderIssuer).catch(
        (): Step<never> => failed('unreachable'),
      );
      cache.latestFetchFailed = outcome.kind === 'failed';
      if (outcome.kind === 'obtained') {
        cache.keys = outcome.value;
        cache.fetchedAt = clock.now();
      } else {
        eventLog.error(KEY_SET_FETCH_FAILED, { cause: outcome.cause });
      }
    } finally {
      cache.inFlight = undefined;
    }
    return held(true);
  };
  const fetched = (): Promise<KeySetReading> => {
    cache.inFlight ??= fetchOnce();
    return cache.inFlight;
  };
  // A fetch in flight is joined whatever the cooldown says, since it was started within it.
  const mayFetch = (): boolean =>
    cache.inFlight !== undefined || !coolingDown();
  return {
    current: async () => {
      const reading = held(false);
      if (reading.kind === 'held') {
        return reading;
      }
      return mayFetch() ? fetched() : UNAVAILABLE;
    },
    held: () => held(false),
    refetchInMilliseconds,
    refreshed: async () => (mayFetch() ? fetched() : held(false)),
  };
};
