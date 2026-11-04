import type { NonEmpty, ValidationProblem } from '@overture-stack/usher-types';

import type { Clock, Clocks } from './clocks.js';
import type { BridgeLogger, START_REFUSAL_REASONS } from './events.js';

/** The rule named by a refusal to start. */
export type StartRefusalReason = (typeof START_REFUSAL_REASONS)[number];

/** The bounds on the bridge's stores, and how long the failure store holds an entry. */
export interface StoreBounds {
  /** How long a rejected token or a failed exchange is held, from 1 s to 60 s; 10 s by default. */
  failureHoldMs: number;

  /** The most rejected tokens and failed exchanges held at once; 1000 by default. */
  failureMax: number;

  /** The most accepted credentials held at once, each with its resolved access; 10000 by default. */
  positiveMax: number;

  /** The most credentials refused by the controller held at once; 10000 by default. */
  refusalMax: number;
}

/**
 * What a host passes to the bridge. The bridge reads nothing from the environment; the host supplies
 * every value. Each optional member left out takes its value from {@link CONFIGURATION_DEFAULTS}.
 */
export interface BridgeConfiguration {
  /**
   * The audience named by this application's Usher tokens, which also identifies the application in
   * every channel assertion. One bridge serves an audience in a process.
   */
  audience: string;

  /** The controller's base URL: https, or plain http only to loopback. */
  controllerUrl: string | URL;

  /**
   * This deployment's event source: a non-empty URI reference identifying the deployment rather than
   * one replica, logged as the `source` of every event.
   */
  eventSource: string;

  /** How long an exchange with the controller may run before it is abandoned as a timeout; 5 s by default. */
  exchangeTimeoutMs?: number;

  /**
   * The most clauses a record key's filter may hold, counted as OpenSearch counts them once it has
   * rewritten the query; 1024 by default. A principal whose grants render past it is denied that key
   * with `filter-limit`. The bridge does not compare it with the search engine's own clause limit:
   * above that limit, a filter passed by the bridge can still be refused by the engine.
   */
  filterClauseLimit?: number;

  /**
   * How long after the latest recorded check's start the mode stays normal; 60 s by default. Past it,
   * the mode is uncertain while an anonymous payload is held, and cold once none is.
   */
  graceMs?: number;

  /**
   * The most new exchanges in flight at once; 64 by default. A request needing one beyond it is
   * answered as unavailable and counted as overloaded.
   */
  inFlightMax?: number;

  /** The issuer required in every accepted Usher token. */
  issuer: string;

  /** The application key: 43 base64url characters in canonical form; whitespace around it is ignored. */
  key: string;

  /**
   * How long past its own `exp` a signed sign-in token is still passed on rather than refused
   * locally: a finite number of at least zero, 60 s by default. Below the controller's own tolerance,
   * the bridge refuses tokens the controller would accept.
   */
  localRefusalClockToleranceMs?: number;

  /** Receives every event emitted by the bridge, as described for {@link BridgeLogger}. */
  logger: BridgeLogger;

  /** The monotonic clock; `performance.now()` when omitted. */
  monotonicClock?: Clock;

  /**
   * The Usher token payload versions read by this bridge, sent with every exchange: a non-empty list
   * of distinct positive whole numbers, each readable by the token reader.
   */
  payloadVersions: NonEmpty<number>;

  /**
   * How long a check of the revocation channel may run, from its first page's start, before it is
   * aborted as a timeout; 10 s by default.
   */
  pollDeadlineMs?: number;

  /**
   * How long from a recorded check's start to the next poll's, jittered by 10% either way: at least
   * 1 s, 30 s by default. Start refuses it with `intervalsOutOfOrder` when it is below `pushIdleMs`,
   * whose default is 25 s.
   */
  pollIntervalMs?: number;

  /**
   * How long from one poll's start to the next while checks are failing, in place of
   * `pollIntervalMs`. It applies from a check whose immediate retry has also failed or been
   * malformed, until a check is recorded. Jittered by 10% either way, from 1 s up to
   * `pollIntervalMs`; the smaller of 10 s and `pollIntervalMs` by default.
   */
  pollRecoveryIntervalMs?: number;

  /**
   * How long the push may stay silent before it is replaced: at most `pollIntervalMs`, and 25 s by
   * default whatever the poll interval. Under twice the controller's heartbeat plus its jitter, a
   * healthy push is replaced as silent.
   */
  pushIdleMs?: number;

  /**
   * The most bytes read from the controller's answer to an exchange or a poll before it is refused
   * unread; 1 MiB by default.
   */
  responseCapBytes?: number;

  /** Bounds on the bridge's stores; each one left out takes its default. */
  stores?: Partial<StoreBounds>;

  /**
   * The longest the outcome of an exchange is held before the credential is exchanged again: an
   * accepted credential's access, a refusal, or the anonymous payload, each ending sooner at its
   * token's own expiry. 5 min by default.
   */
  tokenTtlMs?: number;

  /** The wall clock; `Date.now()` when omitted. */
  wallClock?: Clock;
}

/** The configuration once checked, with every default filled in. */
export interface ResolvedConfiguration {
  audience: string;
  clocks: Clocks;

  /** The controller's base URL, ending in `/` so that every request URL built relative to it keeps its path. */
  controllerUrl: URL;

  eventSource: string;
  exchangeTimeoutMs: number;
  filterClauseLimit: number;
  graceMs: number;
  inFlightMax: number;
  issuer: string;
  key: string;
  localRefusalClockToleranceMs: number;
  logger: BridgeLogger;
  payloadVersions: NonEmpty<number>;
  pollDeadlineMs: number;
  pollIntervalMs: number;
  pollRecoveryIntervalMs: number;
  pushIdleMs: number;
  responseCapBytes: number;
  stores: StoreBounds;
  tokenTtlMs: number;
}

/**
 * The outcome of {@link checkConfiguration}: the resolved configuration, or the first rule broken.
 * For `numberOutOfRange`, `problems` holds one entry per setting out of range, positioned at its
 * name; for every other rule it is empty.
 */
export type ConfigurationCheck =
  | { configuration: ResolvedConfiguration; ok: true }
  | {
      ok: false;
      problems: readonly ValidationProblem[];
      reason: StartRefusalReason;
    };

/**
 * Every default, frozen so that no bridge in the process can change another's. A configuration
 * giving no `pollRecoveryIntervalMs` gets the smaller of the value here and its own
 * `pollIntervalMs`.
 */
export const CONFIGURATION_DEFAULTS: Readonly<{
  exchangeTimeoutMs: number;
  filterClauseLimit: number;
  graceMs: number;
  inFlightMax: number;
  localRefusalClockToleranceMs: number;
  pollDeadlineMs: number;
  pollIntervalMs: number;
  pollRecoveryIntervalMs: number;
  pushIdleMs: number;
  responseCapBytes: number;
  stores: Readonly<StoreBounds>;
  tokenTtlMs: number;
}> = Object.freeze({
  exchangeTimeoutMs: 5_000,
  filterClauseLimit: 1_024,
  graceMs: 60_000,
  inFlightMax: 64,
  localRefusalClockToleranceMs: 60_000,
  pollDeadlineMs: 10_000,
  pollIntervalMs: 30_000,
  pollRecoveryIntervalMs: 10_000,
  // Fixed rather than derived from the poll interval: a derived one could fall below what the
  // controller's heartbeat needs and replace a healthy push as silent.
  pushIdleMs: 25_000,
  responseCapBytes: 1_048_576,
  stores: Object.freeze({
    failureHoldMs: 10_000,
    failureMax: 1_000,
    positiveMax: 10_000,
    refusalMax: 10_000,
  }),
  tokenTtlMs: 300_000,
});

/** The fixed text of each rule named by a refusal to start, never a configured value. */
export const START_REFUSAL_RULES: Readonly<Record<StartRefusalReason, string>> =
  Object.freeze({
    audienceEmpty: 'the audience is a non-empty string',
    audienceInUse: 'one bridge serves an audience in a process',
    clockInvalid: 'a clock given has a now method',
    controllerUrlInsecure:
      'the controller URL uses https, or plain http only to 127.0.0.1, localhost or [::1]',
    controllerUrlInvalid:
      'the controller URL is an http or https URL with no credentials, query or fragment',
    eventSourceEmpty: 'the event source is a non-empty URI reference',
    failureHoldOutOfBounds:
      'the failure hold is a whole number of milliseconds from 1000 to 60000',
    intervalsOutOfOrder:
      'the push idle timeout is at most the poll interval, the poll recovery interval is at most the poll interval, and the poll interval at its 10% jitter maximum, plus twice the poll deadline, stays below the grace period',
    issuerEmpty: 'the issuer is a non-empty string',
    keyUnusable:
      'the application key is 43 base64url characters in canonical form, with whitespace around it ignored',
    loggerInvalid: 'the logger has info, warn and error methods',
    notRegistered: 'register runs before start',
    numberOutOfRange:
      'each bound, interval, timeout and cap is a positive whole number, and the poll interval and the poll recovery interval are each at least 1000 milliseconds',
    payloadVersionsInvalid:
      'the payload versions are a non-empty list of distinct positive whole numbers',
    payloadVersionUnreadable:
      'every payload version listed is one the token reader can read',
    refusalToleranceInvalid:
      'the local refusal clock tolerance is a finite number of at least zero',
    startDefect:
      'the controller client, the token reader and the revocation channel build, and the channel starts, without throwing',
  });

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost',
]);

const FAILURE_HOLD_BOUNDS = { max: 60_000, min: 1_000 } as const;

/** The least poll interval and recovery interval, so a mistyped value cannot flood the controller. */
const POLL_INTERVAL_MIN_MS = 1_000;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isWholeAtLeast = (value: unknown, minimum: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

const isPositiveWhole = (value: unknown): boolean => isWholeAtLeast(value, 1);

/**
 * Each numeric setting judged by the range rule. A setting left out is never at fault: every default
 * passes, and the recovery interval's default is never below a poll interval that passes.
 */
const rangedSettings = (
  input: BridgeConfiguration,
): readonly (readonly [
  position: string,
  given: unknown,
  minimum: number,
])[] => [
  ['exchangeTimeoutMs', input.exchangeTimeoutMs, 1],
  ['filterClauseLimit', input.filterClauseLimit, 1],
  ['graceMs', input.graceMs, 1],
  ['inFlightMax', input.inFlightMax, 1],
  ['pollDeadlineMs', input.pollDeadlineMs, 1],
  ['pollIntervalMs', input.pollIntervalMs, POLL_INTERVAL_MIN_MS],
  [
    'pollRecoveryIntervalMs',
    input.pollRecoveryIntervalMs,
    POLL_INTERVAL_MIN_MS,
  ],
  ['pushIdleMs', input.pushIdleMs, 1],
  ['responseCapBytes', input.responseCapBytes, 1],
  ['stores.failureMax', input.stores?.failureMax, 1],
  ['stores.positiveMax', input.stores?.positiveMax, 1],
  ['stores.refusalMax', input.stores?.refusalMax, 1],
  ['tokenTtlMs', input.tokenTtlMs, 1],
];

const hasMethods = (value: unknown, names: readonly string[]): boolean =>
  typeof value === 'object' &&
  value !== null &&
  names.every((name) => typeof Reflect.get(value, name) === 'function');

/**
 * Whether a clock given in the configuration, or its absence, passes the start check: true when it
 * is absent or has a `now` method.
 */
export const isClockOrAbsent = (value: unknown): boolean =>
  value === undefined || hasMethods(value, ['now']);

/** Whether the configured logger passes the start check: it has info, warn and error methods. */
export const isLogger = (value: unknown): value is BridgeLogger =>
  hasMethods(value, ['error', 'info', 'warn']);

/** A key whose 43 characters decode to 32 bytes that encode back to the same text. */
const isCanonicalKey = (value: unknown): boolean =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/u.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;

const parsedUrl = (value: unknown): URL | undefined => {
  if (typeof value === 'string' || value instanceof URL) {
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const isPlainControllerUrl = (url: URL | undefined): boolean =>
  url !== undefined &&
  ['http:', 'https:'].includes(url.protocol) &&
  url.username === '' &&
  url.password === '' &&
  url.search === '' &&
  url.hash === '';

const withTrailingSlash = (url: URL): URL =>
  new URL(url.pathname.endsWith('/') ? url.href : `${url.href}/`);

const isPayloadVersionList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isPositiveWhole) &&
  new Set(value).size === value.length;

const orDefault = <Value>(value: Value | undefined, fallback: Value): Value =>
  value === undefined ? fallback : value;

/**
 * Checks a host's configuration against the start rules, and fills in every default. A broken rule
 * is returned as a refusal rather than thrown.
 *
 * - The rules are judged in a fixed order, and the first broken one is returned as a fixed code,
 *   never with the value that broke it.
 * - A `numberOutOfRange` refusal carries one problem for each setting given out of range, positioned
 *   at the setting's name.
 * - `pollIntervalMs` and `pollRecoveryIntervalMs` are each at least 1000 ms, and the recovery
 *   interval defaults to the smaller of 10000 and `pollIntervalMs`.
 * - `intervalsOutOfOrder` holds `pushIdleMs` and `pollRecoveryIntervalMs` each to at most
 *   `pollIntervalMs`, and requires 1.1 times `pollIntervalMs` plus twice `pollDeadlineMs` to stay
 *   below `graceMs`.
 */
export const checkConfiguration = (
  input: BridgeConfiguration,
): ConfigurationCheck => {
  const stores: StoreBounds = {
    failureHoldMs: orDefault(
      input.stores?.failureHoldMs,
      CONFIGURATION_DEFAULTS.stores.failureHoldMs,
    ),
    failureMax: orDefault(
      input.stores?.failureMax,
      CONFIGURATION_DEFAULTS.stores.failureMax,
    ),
    positiveMax: orDefault(
      input.stores?.positiveMax,
      CONFIGURATION_DEFAULTS.stores.positiveMax,
    ),
    refusalMax: orDefault(
      input.stores?.refusalMax,
      CONFIGURATION_DEFAULTS.stores.refusalMax,
    ),
  };
  const pollIntervalMs = orDefault(
    input.pollIntervalMs,
    CONFIGURATION_DEFAULTS.pollIntervalMs,
  );
  const bounds = {
    exchangeTimeoutMs: orDefault(
      input.exchangeTimeoutMs,
      CONFIGURATION_DEFAULTS.exchangeTimeoutMs,
    ),
    filterClauseLimit: orDefault(
      input.filterClauseLimit,
      CONFIGURATION_DEFAULTS.filterClauseLimit,
    ),
    graceMs: orDefault(input.graceMs, CONFIGURATION_DEFAULTS.graceMs),
    inFlightMax: orDefault(
      input.inFlightMax,
      CONFIGURATION_DEFAULTS.inFlightMax,
    ),
    pollDeadlineMs: orDefault(
      input.pollDeadlineMs,
      CONFIGURATION_DEFAULTS.pollDeadlineMs,
    ),
    pollIntervalMs,
    pollRecoveryIntervalMs: orDefault(
      input.pollRecoveryIntervalMs,
      Math.min(CONFIGURATION_DEFAULTS.pollRecoveryIntervalMs, pollIntervalMs),
    ),
    pushIdleMs: orDefault(input.pushIdleMs, CONFIGURATION_DEFAULTS.pushIdleMs),
    responseCapBytes: orDefault(
      input.responseCapBytes,
      CONFIGURATION_DEFAULTS.responseCapBytes,
    ),
    tokenTtlMs: orDefault(input.tokenTtlMs, CONFIGURATION_DEFAULTS.tokenTtlMs),
  };
  const tolerance = orDefault(
    input.localRefusalClockToleranceMs,
    CONFIGURATION_DEFAULTS.localRefusalClockToleranceMs,
  );
  const url = parsedUrl(input.controllerUrl);
  // Whitespace is never part of a key, and a pasted value often carries it.
  const key = typeof input.key === 'string' ? input.key.trim() : input.key;
  const outOfRange: readonly ValidationProblem[] = rangedSettings(
    input,
  ).flatMap(([position, given, minimum]) =>
    given === undefined || isWholeAtLeast(given, minimum)
      ? []
      : [{ position, rule: START_REFUSAL_RULES.numberOutOfRange }],
  );

  // The logger and the clocks come first, so that any later refusal can be logged.
  const rules: readonly (readonly [StartRefusalReason, () => boolean])[] = [
    ['loggerInvalid', () => isLogger(input.logger)],
    [
      'clockInvalid',
      () =>
        isClockOrAbsent(input.monotonicClock) &&
        isClockOrAbsent(input.wallClock),
    ],
    ['keyUnusable', () => isCanonicalKey(key)],
    ['audienceEmpty', () => isNonEmptyString(input.audience)],
    ['issuerEmpty', () => isNonEmptyString(input.issuer)],
    ['eventSourceEmpty', () => isNonEmptyString(input.eventSource)],
    ['controllerUrlInvalid', () => isPlainControllerUrl(url)],
    [
      'controllerUrlInsecure',
      () =>
        url?.protocol === 'https:' || LOOPBACK_HOSTS.has(url?.hostname ?? ''),
    ],
    [
      'payloadVersionsInvalid',
      () => isPayloadVersionList(input.payloadVersions),
    ],
    ['numberOutOfRange', () => outOfRange.length === 0],
    [
      'failureHoldOutOfBounds',
      () =>
        Number.isSafeInteger(stores.failureHoldMs) &&
        stores.failureHoldMs >= FAILURE_HOLD_BOUNDS.min &&
        stores.failureHoldMs <= FAILURE_HOLD_BOUNDS.max,
    ],
    [
      'refusalToleranceInvalid',
      () =>
        typeof tolerance === 'number' &&
        Number.isFinite(tolerance) &&
        tolerance >= 0,
    ],
    [
      'intervalsOutOfOrder',
      // 1.1 pollIntervalMs + 2 pollDeadlineMs < graceMs, multiplied by 10 so that whole numbers
      // compare without rounding.
      () =>
        bounds.pushIdleMs <= bounds.pollIntervalMs &&
        bounds.pollRecoveryIntervalMs <= bounds.pollIntervalMs &&
        11 * bounds.pollIntervalMs + 20 * bounds.pollDeadlineMs <
          10 * bounds.graceMs,
    ],
  ];

  const broken = rules.find(([, holds]) => !holds());

  // No rule broken means `controllerUrlInvalid` held, so `url` is defined: testing it only narrows
  // its type, and the fallback reason below is never reached.
  if (broken === undefined && url !== undefined) {
    return {
      configuration: {
        audience: input.audience,
        clocks: {
          monotonic: input.monotonicClock ?? { now: () => performance.now() },
          wall: input.wallClock ?? { now: () => Date.now() },
        },
        controllerUrl: withTrailingSlash(url),
        eventSource: input.eventSource,
        issuer: input.issuer,
        key,
        localRefusalClockToleranceMs: tolerance,
        logger: input.logger,
        payloadVersions: input.payloadVersions,
        stores,
        ...bounds,
      },
      ok: true,
    };
  }

  const reason = broken?.[0] ?? 'controllerUrlInvalid';
  return {
    ok: false,
    problems: reason === 'numberOutOfRange' ? outOfRange : [],
    reason,
  };
};
