import {
  type CategoryName,
  type Enforcement,
  type KeyRegistration,
  keySegment,
  type Notice,
  type PermissionsPayload,
  subjectToLog,
  UsherContractError,
  type UsherPrincipal,
  type UsherRequestAccess,
  validateRegistration,
  type ValidationProblem,
} from '@overture-stack/usher-types';

import {
  type BoundedMap,
  createBoundedMap,
  type Expiry,
  hasExpired,
} from './boundedMap.js';
import type { Channel, ChannelCore } from './channel.js';
import type { Clock } from './clocks.js';
import {
  type BridgeConfiguration,
  checkConfiguration,
  isClockOrAbsent,
  isLogger,
  type ResolvedConfiguration,
  START_REFUSAL_RULES,
  type StartRefusalReason,
} from './configuration.js';
import {
  type BridgeEventData,
  type BridgeMode,
  createEventLog,
  createOverloadTally,
  type EventLog,
} from './events.js';
import { grantSet, holdsOnlyOpenTier } from './grants.js';
import { guardEventOf } from './guards.js';
import {
  type ApplicationKeys,
  credentialDigest,
  importApplicationKey,
  subjectTag,
} from './keys.js';
import { createModeMachine } from './modes.js';
import { createPositiveStore } from './positiveStore.js';
import {
  type CompiledKey,
  compileKey,
  renderKey,
  unenforcedEntries,
  type UnknownCategory,
  type UnmappedCategory,
} from './rendering.js';
import {
  isLocallyExpired,
  readSignedToken,
  type SignedTokenClaims,
} from './signInToken.js';
import { createSingleFlight } from './singleFlight.js';
import { isReadablePayloadVersion } from './tokenReader.js';

type TokenRejectionReason = BridgeEventData['token.rejection']['reason'];

/** What the controller answered an exchange with, as the controller client reads its status. */
export type ExchangeAnswer =
  | { cause: 'network' | 'status' | 'timeout'; kind: 'failed' }
  | { cause: 'assertionRefused' | 'status'; kind: 'unavailable' }
  | { kind: 'refused' }
  | { kind: 'token'; token: string }
  | { kind: 'unreadable'; reason: TokenRejectionReason };

/** Asks the controller to exchange a credential, or nothing for the anonymous exchange. */
export interface ControllerClient {
  /**
   * Exchanges `credential`, or nothing when it is `null`, for the controller's answer. `signal`
   * aborts once the exchange timeout has passed.
   */
  exchange(request: {
    credential: string | null;
    signal: AbortSignal;
  }): Promise<ExchangeAnswer>;
}

/** An Usher token read: its validated payload, or the fixed reason it was rejected. */
export type TokenReading =
  | { kind: 'payload'; payload: PermissionsPayload }
  | { kind: 'rejected'; reason: TokenRejectionReason };

/** Reads an Usher token into its validated payload, or the fixed reason it was rejected. */
export interface TokenReader {
  read(token: string): Promise<TokenReading>;
}

/** What each seam is built from. */
export interface SeamContext {
  /** The checked configuration, without the application key, which only the imported keys carry. */
  configuration: ConfigurationWithoutKey;

  /** The subkeys imported from the application key. */
  keys: ApplicationKeys;
}

/** The checked configuration without the application key. */
export type ConfigurationWithoutKey = Omit<ResolvedConfiguration, 'key'>;

/** What the revocation channel is built from. */
export interface ChannelContext extends SeamContext {
  /** The core members driven by the channel. */
  core: ChannelCore;

  /** The core's event log. */
  events: EventLog;
}

/** The parts of the core that reach outside it. */
export interface CoreSeams {
  /**
   * Releases what the seams hold, such as their connections, once nothing uses them; when omitted,
   * nothing is released.
   */
  close?: () => Promise<void>;

  /**
   * Builds the revocation channel, the only party that confirms a check: its context holds the only
   * reference to the core member that does. When omitted, no check is ever confirmed and the core
   * stays cold.
   */
  createChannel?(context: ChannelContext): Channel;

  /** Builds the client that exchanges credentials with the controller. */
  createControllerClient(context: SeamContext): ControllerClient;

  /** Builds the reader that decrypts and validates each Usher token. */
  createTokenReader(context: SeamContext): TokenReader;

  /** Uniform randomness in [0, 1), for the refresh's backoff jitter; `Math.random` when omitted. */
  random?: () => number;
}

/**
 * What one request resolves to:
 * - `access`: the request is served under the access given;
 * - `refused`: the credential is refused, and only a new one can be served;
 * - `unavailable`: access cannot be confirmed just now.
 */
export type ResolveOutcome =
  | { access: Readonly<UsherRequestAccess>; kind: 'access' }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

/**
 * The bridge's core, free of any web framework: it turns each request's credential into that
 * request's access.
 */
export interface BridgeCore {
  /**
   * Applies one revocation notice, dropping the cached access it affects; it never grants access.
   * Before start and after stop it does nothing.
   */
  applyNotice(notice: Notice): void;

  /**
   * The bridge's mode now, logging any change since the last reading:
   * - `normal` while the latest confirmed check started no more than the grace period ago;
   * - `uncertain` past the grace period while an anonymous payload is held;
   * - `cold` before start, after stop, until an anonymous payload has been accepted and a check
   *   confirmed, and past the grace period with no anonymous payload held.
   */
  mode(): BridgeMode;

  /**
   * Fetches the anonymous payload again, sharing any fetch already running. The payload is kept only
   * once a check has been confirmed since start or the last reset; before that it serves only as the
   * application key's self-test.
   *
   * @returns whether a readable anonymous payload arrived:
   * - `true` when one arrived, whether kept or used only as the self-test;
   * - `false` when the fetch failed, when a reset overtook it, or when a notice overtook both it and
   *   the one fetch made again after it.
   * @throws {UsherContractError} as a rejection, naming `START_REFUSAL_RULES.notRegistered` before
   * `register`, and `CORE_RULES.startFirst` before `start` has finished or after `stop`.
   */
  refreshAnonymous(): Promise<boolean>;

  /**
   * Registers every catalogue key with its registration, copied and frozen, so a later change to the
   * argument has no effect.
   *
   * @throws {UsherContractError}
   * - when called a second time, or after `start` or `stop` (`CORE_RULES.once`);
   * - when the map holds no key, or a key that is not a non-empty string other than `__proto__`
   *   (`CORE_RULES.keys`);
   * - when any registration breaks its rules (`CORE_RULES.registrations`), naming every problem of
   *   every registration, each positioned under its catalogue key as `keySegment` writes it, as in
   *   `files.resourceFieldName` or `["files.v2"].resourceFieldName`.
   */
  register(registrations: Readonly<Record<string, KeyRegistration>>): void;

  /**
   * Logs one of the Express layer's own events through the core's event log. Before start, or after
   * start refused the configuration, it logs through a log built from the configured logger, with a
   * fallback for an invalid event source or wall clock, and logs nothing when the logger itself is
   * invalid.
   */
  report<Name extends LayerEventName>(
    name: Name,
    data: BridgeEventData[Name],
  ): void;

  /**
   * Drops all cached access, and caches none until the next confirmed check:
   * - every exchanged credential's access and the anonymous payload are dropped, while refusals and
   *   held failures are kept;
   * - until the next confirmed check, an anonymous payload fetched serves only as the key's
   *   self-test, and an exchange started is served without being cached;
   * - an anonymous fetch already running is abandoned, and no later anonymous fetch joins it;
   * - an exchange already running is made again, and its answer served without being cached;
   * - each category gap logs `category.unmapped` or `category.unknown` again the next time a payload
   *   shows it.
   *
   * It logs `revocationChannel.reset`, never grants access, and does nothing before start or after
   * stop.
   */
  reset(): void;

  /**
   * Resolves one request's credential, or `null` for none, to one of:
   * - `access`: the principal's access, or the open tier for no credential; or the open tier,
   *   suspended, when the controller cannot be reached or the revocation channel is uncertain;
   * - `refused`: the controller refused the credential, or it is a signed token past its own `exp`;
   * - `unavailable`: the core is not running or is cold, the controller's answer could not be read,
   *   the in-flight bound is reached, or no open tier is held to serve.
   *
   * It rejects when the controller client or the token reader throws, or when tagging the payload's
   * subject fails.
   */
  resolve(credential: string | null): Promise<ResolveOutcome>;

  /**
   * Checks the configuration, imports the application key, and fetches the anonymous payload, which
   * serves as the key's self-test until a check is confirmed. It resolves once that fetch has ended,
   * whether or not it succeeded, and resolves without starting when `stop` lands while the key is
   * being imported.
   *
   * @throws {UsherContractError} as a rejection, naming the rule broken and leaving the core cold:
   * - when called a second time, or after `stop` (`CORE_RULES.startOnce`);
   * - when the configuration fails its check, naming each problem;
   * - when a listed payload version cannot be read, naming each at its index, as in
   *   `payloadVersions[1]`;
   * - when `register` has not run;
   * - when another bridge in this process already serves the audience;
   * - when the application key cannot be imported;
   * - when building the controller client, the token reader or the revocation channel throws, or
   *   starting the channel does, once whatever had started has stopped.
   *
   * Every refusal but `startOnce` is logged as `bridge.startRefusal`; a refused configuration is
   * logged through a fallback log, and not at all when its logger is unusable.
   */
  start(): Promise<void>;

  /**
   * Cancels every timer at once, and from then on starts no exchange or anonymous fetch. It then
   * waits for a `start` still running, for every exchange and anonymous fetch in flight, and for the
   * revocation channel's own stop, and only then closes the seams. Every exchange and fetch in flight
   * is left to finish rather than aborted. It never rejects, and calling it again returns the same
   * promise.
   *
   * @returns a promise settled once the seams are closed, which is when the audience is freed for
   * another bridge in this process.
   */
  stop(): Promise<void>;
}

/** The events the Express layer logs through the core. */
export type LayerEventName = 'bridge.internalError' | 'credential.malformed';

/**
 * The fixed text of each lifecycle rule enforced by the core, the message of the
 * `UsherContractError` thrown when it is broken.
 */
export const CORE_RULES: Readonly<{
  keys: string;
  once: string;
  registrations: string;
  startFirst: string;
  startOnce: string;
}> = Object.freeze({
  keys: 'register takes a map of at least one key, each a non-empty string other than __proto__',
  once: 'register runs once, before start',
  registrations: 'every registration holds to its rules',
  startFirst:
    'the anonymous payload is fetched only once the bridge has started',
  startOnce: 'start runs once, and never after stop',
});

/** How one anonymous fetch ended: installed, kept only as the self-test, overtaken by a reset, or failed. */
type AnonymousFetch = 'failed' | 'installed' | 'selfTest' | 'stale';

/**
 * The channel's state as a flight starts: the flight's answer is cached only when a check had been
 * confirmed by then and no reset has come since.
 */
interface FlightStart {
  afterCheck: boolean;
  generation: number;
}

/**
 * How a flight ended. A degraded one names the subject carried by its verified Usher token, or
 * `null` when no token was verified, so the open tier served in its place can still name who was
 * served.
 */
type FlightOutcome =
  | { access: Readonly<UsherRequestAccess>; kind: 'granted' }
  | { kind: 'degraded'; subject: string | null }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

interface PositiveEntry {
  access: Readonly<UsherRequestAccess>;
  resources: ReadonlySet<string>;
  subjectTag: string;
}

interface AnonymousEntry {
  access: Readonly<UsherRequestAccess>;
  expiry: Expiry;
  grants: ReadonlySet<string>;
  resources: ReadonlySet<string>;
  suspended: Readonly<UsherRequestAccess>;
}

const REFUSED: ResolveOutcome = Object.freeze({ kind: 'refused' });
const UNAVAILABLE: ResolveOutcome = Object.freeze({ kind: 'unavailable' });
const DEGRADED_FLIGHT: FlightOutcome = Object.freeze({
  kind: 'degraded',
  subject: null,
});
const REFUSED_FLIGHT: FlightOutcome = Object.freeze({ kind: 'refused' });
const UNAVAILABLE_FLIGHT: FlightOutcome = Object.freeze({
  kind: 'unavailable',
});

const FOREVER: Expiry = Object.freeze({
  monotonicMs: Number.POSITIVE_INFINITY,
  wallMs: Number.POSITIVE_INFINITY,
});

const DATE_CLOCK: Clock = { now: () => Date.now() };

const UNCONFIGURED_SOURCE = 'urn:overture:usher-bridge:unconfigured';

const TIMED_OUT: ExchangeAnswer = Object.freeze({
  cause: 'timeout',
  kind: 'failed',
});

/**
 * The client's answer, or a timeout once the flight's signal aborts, so a client that ignores the
 * signal cannot hold a flight, or its place in the bound, for good.
 */
const answeredBy = (
  signal: AbortSignal,
  exchanging: Promise<ExchangeAnswer>,
): Promise<ExchangeAnswer> =>
  new Promise((resolve, reject) => {
    const timedOut = (): void => resolve(TIMED_OUT);
    if (signal.aborted) {
      timedOut();
    }
    signal.addEventListener('abort', timedOut, { once: true });
    exchanging
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', timedOut));
  });

/** How many distinct result sets are interned at once. */
const INTERN_MAX = 4_096;

/** How many category gaps of each kind are remembered as logged; one forgotten may be logged again. */
const LOGGED_GAPS_MAX = 4_096;

/** How many applied notices are kept for the overtaking test. */
const NOTICE_LOG_MAX = 1_024;

/**
 * The audiences of every bridge running in this process: at most one bridge serves each audience.
 */
const audiencesInUse = new Set<string>();

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const accessOf = (
  principal: UsherPrincipal,
  results: Readonly<Record<string, Enforcement>>,
): Readonly<UsherRequestAccess> =>
  deepFreeze({ principal: { ...principal }, results, version: 1 as const });

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const affectsPayload = (
  notice: Notice,
  payload: PermissionsPayload,
  tag: string | undefined,
): boolean => {
  switch (notice.kind) {
    case 'baseline':
    case 'global':
    case 'servedResources':
      return true;
    case 'category':
      return Object.hasOwn(payload.permissions, notice.resource);
    case 'principal':
      return tag !== undefined && notice.subjectTag === tag;
  }
};

/**
 * The notices applied lately, each numbered by the epoch it advanced the log to, for telling
 * whether a notice overtook a flight's answer.
 */
interface NoticeLog {
  /**
   * Whether any notice applied after epoch `since` bears on the payload, `tag` naming its subject's
   * tag; a log that no longer reaches back that far counts as affected.
   */
  affects(
    since: number,
    payload: PermissionsPayload,
    tag: string | undefined,
  ): boolean;

  /** The epoch of the notice applied last, or 0 before any. */
  epoch(): number;

  record(notice: Notice): void;
}

const createNoticeLog = (): NoticeLog => {
  const state: { applied: { epoch: number; notice: Notice }[]; epoch: number } =
    { applied: [], epoch: 0 };

  return {
    affects: (since, payload, tag) => {
      const later = state.applied.filter(({ epoch }) => epoch > since);
      return (
        state.epoch - since > later.length ||
        later.some(({ notice }) => affectsPayload(notice, payload, tag))
      );
    },
    epoch: () => state.epoch,
    record: (notice) => {
      state.epoch += 1;
      state.applied = [
        ...state.applied.slice(-(NOTICE_LOG_MAX - 1)),
        { epoch: state.epoch, notice },
      ];
    },
  };
};

interface Runtime {
  applyNotice(notice: Notice): void;
  confirmChannel(checkStartedAt: number): void;
  mode(): BridgeMode;
  refreshAnonymous(): Promise<boolean>;
  reset(): void;
  resolve(credential: string | null): Promise<ResolveOutcome>;

  /**
   * Cancels every timer at once and starts no further exchange or anonymous fetch, then settles once
   * no flight is held and the channel has stopped. It never rejects, even when the host's logger
   * throws.
   */
  stop(): Promise<void>;
}

/** A runtime whose revocation channel is built and not yet started. */
interface UnstartedRuntime extends Runtime {
  /** Starts the revocation channel, which may have started part of itself when it throws. */
  startChannel(): void;
}

/** Creates everything that serves requests, leaving the revocation channel to be started. */
const createRuntime = ({
  configuration,
  events,
  keys,
  random,
  registrations,
  seams,
}: {
  configuration: ConfigurationWithoutKey;
  events: EventLog;
  keys: ApplicationKeys;
  random: () => number;
  registrations: Readonly<Record<string, CompiledKey>>;
  seams: CoreSeams;
}): UnstartedRuntime => {
  const { clocks, stores } = configuration;
  const modes = createModeMachine({
    events,
    graceMs: configuration.graceMs,
    monotonicClock: clocks.monotonic,
  });
  const tally = createOverloadTally(events);
  const positive = createPositiveStore<PositiveEntry>({
    clocks,
    max: stores.positiveMax,
  });
  const refusals = createBoundedMap<string, true>({
    clocks,
    max: stores.refusalMax,
  });
  const failures = createBoundedMap<string, 'failed' | 'rejected'>({
    clocks,
    max: stores.failureMax,
  });
  const interned = createBoundedMap<
    string,
    Readonly<Record<string, Enforcement>>
  >({ clocks, max: INTERN_MAX });
  const flights = createSingleFlight<FlightOutcome>({
    max: configuration.inFlightMax,
    onOverload: tally.record,
    overloaded: UNAVAILABLE_FLIGHT,
    timeoutMs: configuration.exchangeTimeoutMs,
  });
  const anonymousFlight = createSingleFlight<AnonymousFetch>({
    // One flight for the current reset generation, and one left running from before the last reset.
    max: 2,
    onOverload: () => {
      failedRefresh();
    },
    overloaded: 'failed',
    timeoutMs: configuration.exchangeTimeoutMs,
  });
  const notices = createNoticeLog();
  const context: SeamContext = { configuration, keys };
  const client = seams.createControllerClient(context);
  const reader = seams.createTokenReader(context);
  const unknownSeen = createBoundedMap<string, true>({
    clocks,
    max: LOGGED_GAPS_MAX,
  });
  const unmappedSeen = createBoundedMap<string, true>({
    clocks,
    max: LOGGED_GAPS_MAX,
  });
  /** `generation` counts resets, so a flight can tell whether one came while it ran. */
  const channel: { checkedSinceReset: boolean; generation: number } = {
    checkedSinceReset: false,
    generation: 0,
  };
  const flightStart = (): FlightStart => ({
    afterCheck: channel.checkedSinceReset,
    generation: channel.generation,
  });
  const anonymous: {
    entry: AnonymousEntry | undefined;
    installedOnce: boolean;
    retries: number;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    entry: undefined,
    installedOnce: false,
    retries: 0,
    timer: undefined,
  };
  /** Once set, no exchange or anonymous fetch starts. */
  const lifecycle: { stopped: boolean } = { stopped: false };

  const ttlFromNow = (): number =>
    clocks.monotonic.now() + configuration.tokenTtlMs;

  const credentialExpiry = (claims: SignedTokenClaims | undefined): number =>
    claims?.exp === undefined ? Number.POSITIVE_INFINITY : claims.exp * 1000;

  const refuse = (
    digest: string,
    claims: SignedTokenClaims | undefined,
  ): void => {
    refusals.set(digest, true, {
      monotonicMs: ttlFromNow(),
      wallMs: credentialExpiry(claims),
    });
    events.emit('credential.refusal', { origin: 'controller' });
  };

  const holdFailure = (digest: string, failure: 'failed' | 'rejected'): void =>
    failures.set(digest, failure, {
      monotonicMs: clocks.monotonic.now() + stores.failureHoldMs,
      wallMs: Number.POSITIVE_INFINITY,
    });

  const rejected = (
    digest: string,
    reason: TokenRejectionReason,
  ): FlightOutcome => {
    holdFailure(digest, 'rejected');
    events.emit('token.rejection', { reason });
    return UNAVAILABLE_FLIGHT;
  };

  const logUnenforced = (payload: PermissionsPayload): void =>
    unenforcedEntries(payload).forEach(({ category, entry, resourceId }) =>
      events.emit('category.unenforced', {
        category,
        entry,
        payloadVersion: payload.payloadVersion,
        reason: 'notImplemented',
        resourceId,
        userId: payload.sub,
      }),
    );

  /**
   * A logger of category gaps, logging each once per catalogue, category and resource, a global gap
   * having no resource, while it is among the last {@link LOGGED_GAPS_MAX} remembered and no reset
   * has come since.
   */
  const logGapsOnce =
    (
      logged: BoundedMap<string, true>,
      name: 'category.unknown' | 'category.unmapped',
    ): ((
      key: string,
      gaps: readonly (UnknownCategory | UnmappedCategory)[],
    ) => void) =>
    (key, gaps) =>
      gaps.forEach(({ category, resourceId }) => {
        const gap = JSON.stringify([key, category, resourceId ?? null]);
        if (logged.get(gap) === undefined) {
          logged.set(gap, true, FOREVER);
          events.emit(name, {
            catalogue: key,
            category,
            ...(resourceId === undefined ? {} : { resourceId }),
          });
        }
      });

  const logUnknown = logGapsOnce(unknownSeen, 'category.unknown');
  const logUnmapped = logGapsOnce(unmappedSeen, 'category.unmapped');

  /** Records a guard's denial of a key, once for each time the key is rendered. */
  const logGuard = (key: string, enforcement: Enforcement): void => {
    const event = guardEventOf(
      key,
      enforcement,
      configuration.filterClauseLimit,
    );
    if (event !== undefined) {
      events.emit(event.name, event.data);
    }
  };

  /** Renders every key once per payload received, sharing one frozen object among equal results. */
  const resultsFor = (
    payload: PermissionsPayload,
  ): Readonly<Record<string, Enforcement>> => {
    logUnenforced(payload);
    const rendered = Object.fromEntries(
      Object.entries(registrations).map(([key, compiled]) => {
        const { enforcement, unknown, unmapped } = renderKey(
          payload,
          compiled,
          configuration.filterClauseLimit,
        );
        logUnmapped(key, unmapped);
        logUnknown(key, unknown);
        logGuard(key, enforcement);
        return [key, enforcement] as const;
      }),
    );
    const internKey = JSON.stringify(rendered);
    const held = interned.get(internKey);
    if (held !== undefined) {
      return held;
    }
    const frozen = deepFreeze(rendered);
    interned.set(internKey, frozen, FOREVER);
    return frozen;
  };

  const usableAnonymous = (mode: BridgeMode): AnonymousEntry | undefined => {
    const { entry } = anonymous;
    return entry !== undefined &&
      (mode === 'uncertain' ||
        (mode === 'normal' && !hasExpired(clocks, entry.expiry)))
      ? entry
      : undefined;
  };

  /**
   * What a discard that ends its flight, the second or any after stop, ends in: the open tier,
   * suspended, while one is usable, and nothing otherwise.
   */
  const lastDiscardOutcome = (): 'abandoned' | 'servedOpenTier' =>
    usableAnonymous(modes.mode()) === undefined
      ? 'abandoned'
      : 'servedOpenTier';

  const servedFrom = (
    mode: BridgeMode,
    pick: (entry: AnonymousEntry) => Readonly<UsherRequestAccess>,
  ): ResolveOutcome => {
    const entry = usableAnonymous(mode);
    return entry === undefined
      ? UNAVAILABLE
      : { access: pick(entry), kind: 'access' };
  };

  const internalError = (): void =>
    events.emit('bridge.internalError', { stage: 'refreshAnonymous' });

  const failedRefresh = (): AnonymousFetch => {
    anonymous.retries += 1;
    const base = Math.min(
      configuration.pollIntervalMs,
      1_000 * 2 ** anonymous.retries,
    );
    scheduleRefresh(base * (0.5 + random() / 2));
    return 'failed';
  };

  /**
   * Fetches the anonymous payload in its own single flight, outside the in-flight bound. Each
   * reset generation has a flight of its own, so a fetch after a reset never joins one started
   * before it. A defect in the client or the reader is logged and retried like any failed fetch, so
   * retrying never stops.
   */
  const runAnonymous = (): Promise<AnonymousFetch> => {
    if (lifecycle.stopped) {
      return Promise.resolve('failed');
    }
    const start = flightStart();
    return anonymousFlight.run(`anonymous:${start.generation}`, (signal) =>
      fetchAnonymous(signal, start, false).catch(() => {
        internalError();
        return failedRefresh();
      }),
    );
  };

  const refreshAnonymous = (): Promise<boolean> =>
    runAnonymous().then(
      (fetched) => fetched === 'installed' || fetched === 'selfTest',
    );

  function scheduleRefresh(delayMs: number): void {
    // stop clears the timer once, so a fetch ending after it must not arm another.
    if (lifecycle.stopped) {
      return;
    }
    clearTimeout(anonymous.timer);
    anonymous.timer = setTimeout(() => {
      anonymous.timer = undefined;
      void runAnonymous();
    }, delayMs);
    anonymous.timer.unref?.();
  }

  const selfTestFailed = (): void => {
    if (!anonymous.installedOnce) {
      modes.probableKeyMismatch();
    }
  };

  const install = (payload: PermissionsPayload): void => {
    const results = resultsFor(payload);
    const receivedAt = clocks.wall.now();
    anonymous.entry = {
      access: accessOf(
        { credential: 'none', openTierOnly: true, suspended: false },
        results,
      ),
      expiry: { monotonicMs: ttlFromNow(), wallMs: payload.exp * 1000 },
      grants: grantSet(payload.permissions),
      resources: new Set(Object.keys(payload.permissions)),
      suspended: accessOf(
        { credential: 'unconfirmed', openTierOnly: true, suspended: true },
        results,
      ),
    };
    anonymous.installedOnce = true;
    anonymous.retries = 0;
    modes.anonymousAccepted();
    const endsAt = Math.min(
      payload.exp * 1000,
      receivedAt + configuration.tokenTtlMs,
    );
    scheduleRefresh(Math.max(0, (endsAt - receivedAt) * 0.8));
  };

  const fetchAnonymous = async (
    signal: AbortSignal,
    start: FlightStart,
    overtaken: boolean,
  ): Promise<AnonymousFetch> => {
    const since = notices.epoch();
    const answer = await answeredBy(
      signal,
      client.exchange({ credential: null, signal }),
    );
    if (answer.kind === 'unreadable') {
      events.emit('token.rejection', { reason: answer.reason });
      return failedRefresh();
    }
    if (answer.kind !== 'token') {
      events.emit('token.exchangeFailure', {
        cause: answer.kind === 'refused' ? 'status' : answer.cause,
      });
      if (
        answer.kind === 'unavailable' &&
        answer.cause === 'assertionRefused'
      ) {
        selfTestFailed();
      }
      return failedRefresh();
    }
    const reading = await reader.read(answer.token);
    if (reading.kind === 'rejected') {
      events.emit('token.rejection', { reason: reading.reason });
      if (reading.reason === 'decryptionFailed') {
        selfTestFailed();
      }
      if (reading.reason === 'audienceRejected') {
        modes.probableAudienceMismatch();
      }
      return failedRefresh();
    }
    if (reading.payload.sub !== null) {
      events.emit('token.rejection', { reason: 'subjectMismatch' });
      return failedRefresh();
    }
    if (channel.generation !== start.generation) {
      events.emit('token.overtaken', { outcome: 'abandoned' });
      return 'stale';
    }
    if (notices.affects(since, reading.payload, undefined)) {
      const lastDiscard = overtaken || lifecycle.stopped;
      events.emit('token.overtaken', {
        outcome: lastDiscard ? 'abandoned' : 'exchangedAgain',
      });
      if (lastDiscard) {
        return failedRefresh();
      }
      return fetchAnonymous(signal, start, true);
    }
    if (start.afterCheck) {
      install(reading.payload);
      return 'installed';
    }
    return 'selfTest';
  };

  const dropAnonymous = (): number => {
    if (anonymous.entry === undefined) {
      return 0;
    }
    anonymous.entry = undefined;
    modes.anonymousDropped();
    void runAnonymous();
    return 1;
  };

  const settleAnswer = (
    answer: Exclude<ExchangeAnswer, { kind: 'token' }>,
    digest: string,
    claims: SignedTokenClaims | undefined,
  ): FlightOutcome => {
    switch (answer.kind) {
      case 'failed':
        holdFailure(digest, 'failed');
        events.emit('token.exchangeFailure', { cause: answer.cause });
        return DEGRADED_FLIGHT;
      case 'refused':
        refuse(digest, claims);
        return REFUSED_FLIGHT;
      case 'unavailable':
        events.emit('token.exchangeFailure', { cause: answer.cause });
        return UNAVAILABLE_FLIGHT;
      case 'unreadable':
        return rejected(digest, answer.reason);
    }
  };

  const exchange = async (
    credential: string,
    digest: string,
    claims: SignedTokenClaims | undefined,
    signal: AbortSignal,
    overtaken: boolean,
  ): Promise<FlightOutcome> => {
    const since = notices.epoch();
    const start = flightStart();
    const anonymousGrants = anonymous.entry?.grants;
    const answer = await answeredBy(
      signal,
      client.exchange({ credential, signal }),
    );
    if (answer.kind !== 'token') {
      return settleAnswer(answer, digest, claims);
    }
    const reading = await reader.read(answer.token);
    if (reading.kind === 'rejected') {
      return rejected(digest, reading.reason);
    }
    const { payload } = reading;
    const subject = payload.sub;
    if (
      subject === null ||
      (claims?.subject !== undefined && claims.subject !== subject)
    ) {
      return rejected(digest, 'subjectMismatch');
    }
    const tag = await subjectTag(keys, subject);
    if (
      channel.generation !== start.generation ||
      notices.affects(since, payload, tag)
    ) {
      const lastDiscard = overtaken || lifecycle.stopped;
      events.emit('token.overtaken', {
        outcome: lastDiscard ? lastDiscardOutcome() : 'exchangedAgain',
      });
      return lastDiscard
        ? { kind: 'degraded', subject }
        : exchange(credential, digest, claims, signal, true);
    }
    const results = resultsFor(payload);
    const access = accessOf(
      {
        credential: 'confirmed',
        openTierOnly: holdsOnlyOpenTier(payload, anonymousGrants),
        subject,
        suspended: false,
      },
      results,
    );
    if (start.afterCheck) {
      positive.set(
        digest,
        {
          access,
          resources: new Set(Object.keys(payload.permissions)),
          subjectTag: tag,
        },
        {
          monotonicMs: ttlFromNow(),
          wallMs: Math.min(payload.exp * 1000, credentialExpiry(claims)),
        },
      );
    }
    return { access, kind: 'granted' };
  };

  /**
   * The open tier, suspended, for a credential: naming the subject vouched for by the controller,
   * for attribution alone, and unconfirmed when it vouched for none.
   */
  const suspendedFor = (
    mode: BridgeMode,
    subject: string | null,
  ): ResolveOutcome =>
    servedFrom(mode, (entry) =>
      isNonEmptyString(subject)
        ? accessOf(
            {
              attributionOnlySubject: subject,
              credential: 'confirmed',
              openTierOnly: true,
              suspended: true,
            },
            entry.access.results,
          )
        : entry.suspended,
    );

  const outcomeOf = (outcome: FlightOutcome): ResolveOutcome => {
    switch (outcome.kind) {
      case 'degraded':
        return suspendedFor(modes.mode(), outcome.subject);
      case 'granted': {
        const mode = modes.mode();
        return mode === 'normal'
          ? { access: outcome.access, kind: 'access' }
          : suspendedFor(mode, subjectToLog(outcome.access.principal));
      }
      case 'refused':
        return REFUSED;
      case 'unavailable':
        return UNAVAILABLE;
    }
  };

  const resolveCredential = async (
    credential: string,
    mode: BridgeMode,
  ): Promise<ResolveOutcome> => {
    const digest = credentialDigest(credential);
    if (refusals.get(digest) !== undefined) {
      events.emit('credential.refusal', { origin: 'cachedRefusal' });
      return REFUSED;
    }
    const claims = readSignedToken(credential);
    if (
      claims !== undefined &&
      isLocallyExpired(
        claims,
        clocks.wall.now(),
        configuration.localRefusalClockToleranceMs,
      )
    ) {
      // Nothing is stored: the token's own exp refuses it again on every request.
      events.emit('credential.refusal', { origin: 'localExpiry' });
      return REFUSED;
    }
    const failure = failures.get(digest);
    if (failure === 'rejected') {
      return UNAVAILABLE;
    }
    if (mode === 'uncertain' || failure === 'failed') {
      const vouched = positive.get(digest);
      return suspendedFor(
        mode,
        vouched === undefined ? null : subjectToLog(vouched.access.principal),
      );
    }
    const entry = positive.get(digest);
    if (entry !== undefined) {
      return { access: entry.access, kind: 'access' };
    }
    return outcomeOf(
      await flights.run(digest, (signal) =>
        exchange(credential, digest, claims, signal, false),
      ),
    );
  };

  const droppedBy = (notice: Notice): number => {
    switch (notice.kind) {
      case 'baseline':
      case 'servedResources':
        return positive.clear() + dropAnonymous();
      case 'category':
        return (
          positive.dropResource(notice.resource) +
          (anonymous.entry?.resources.has(notice.resource) === true
            ? dropAnonymous()
            : 0)
        );
      case 'global':
        return positive.clear() + refusals.clear() + dropAnonymous();
      case 'principal':
        return positive.dropSubjectTag(notice.subjectTag);
    }
  };

  const runtime: Runtime = {
    applyNotice: (notice) => {
      notices.record(notice);
      events.emit('notice.applied', {
        entriesDropped: droppedBy(notice),
        kind: notice.kind,
      });
    },

    confirmChannel: (checkStartedAt) => {
      modes.confirmCheck(checkStartedAt);
      if (!channel.checkedSinceReset) {
        channel.checkedSinceReset = true;
        void runAnonymous().then((fetched) =>
          fetched === 'selfTest' ? runAnonymous() : fetched,
        );
      }
    },

    mode: () => modes.mode(),

    refreshAnonymous,

    reset: () => {
      positive.clear();
      unknownSeen.clear();
      unmappedSeen.clear();
      if (anonymous.entry !== undefined) {
        anonymous.entry = undefined;
        modes.anonymousDropped();
      }
      channel.checkedSinceReset = false;
      channel.generation += 1;
      events.emit('revocationChannel.reset', {});
    },

    resolve: async (credential) => {
      const mode = modes.mode();
      if (mode === 'cold') {
        return UNAVAILABLE;
      }
      return credential === null
        ? servedFrom(mode, (entry) => entry.access)
        : resolveCredential(credential, mode);
    },

    stop: async () => {
      lifecycle.stopped = true;
      clearTimeout(anonymous.timer);
      anonymous.timer = undefined;
      modes.stop();
      // The tally logs what it holds, so it stops after every timer is cleared.
      tally.stop();
      await Promise.all([flights.whenIdle(), anonymousFlight.whenIdle()]);
    },
  };

  const revocationChannel = seams.createChannel?.({
    ...context,
    core: runtime,
    events,
  });

  return {
    ...runtime,
    startChannel: () => {
      revocationChannel?.start();
    },
    stop: async () => {
      await Promise.all([
        runtime.stop(),
        revocationChannel?.stop().catch(() => undefined),
      ]);
    },
  };
};

const ownMember = (record: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(record, key)?.value;

/**
 * The registrations validated by usher-types, copied, compiled and frozen; it throws naming what
 * broke.
 */
const registeredCopy = (
  registrations: unknown,
): Readonly<Record<string, CompiledKey>> => {
  const record: object =
    typeof registrations === 'object' &&
    registrations !== null &&
    !Array.isArray(registrations)
      ? registrations
      : {};
  const keys = Reflect.ownKeys(record);
  const named = keys.filter(
    (key): key is string => isNonEmptyString(key) && key !== '__proto__',
  );
  if (keys.length === 0 || named.length !== keys.length) {
    throw new UsherContractError(CORE_RULES.keys);
  }
  const results = named.map(
    (key) => [key, validateRegistration(ownMember(record, key))] as const,
  );
  const problems = results.flatMap(([key, result]) =>
    result.success
      ? []
      : result.problems.map(({ position, rule }) => ({
          // Catalogue keys are the operator's configuration, never request content, so a problem
          // may name them.
          position:
            position === '(root)'
              ? keySegment(key)
              : `${keySegment(key)}.${position}`,
          rule,
        })),
  );
  if (problems.length > 0) {
    throw new UsherContractError(CORE_RULES.registrations, problems);
  }
  return deepFreeze(
    Object.fromEntries(
      results.flatMap(([key, result]) =>
        result.success ? [[key, compileKey(result.registration)]] : [],
      ),
    ),
  );
};

const needsResourceList = (key: CompiledKey): boolean =>
  key.kind === 'record' && key.resources?.length === 0;

/**
 * Creates the bridge's core on the seams given. Creating it checks nothing: `start` checks the
 * configuration.
 */
export const createBridgeCoreWithSeams = (
  configuration: BridgeConfiguration,
  seams: CoreSeams,
): BridgeCore => {
  const state: {
    audience: string | undefined;
    events: EventLog | undefined;
    phase: 'new' | 'running' | 'starting' | 'stopped';
    registrations: Readonly<Record<string, CompiledKey>> | undefined;
    runtime: Runtime | undefined;
    starting: Promise<void> | undefined;
    stopping: Promise<void> | undefined;
  } = {
    audience: undefined,
    events: undefined,
    phase: 'new',
    registrations: undefined,
    runtime: undefined,
    starting: undefined,
    stopping: undefined,
  };

  const refusal = (
    reason: StartRefusalReason,
    events: EventLog | undefined,
    problems: readonly ValidationProblem[] = [],
  ): UsherContractError => {
    events?.emit('bridge.startRefusal', { reason });
    return new UsherContractError(START_REFUSAL_RULES[reason], problems);
  };

  /**
   * Only what `settingsLog` needs, taken out of the configuration so that no closure holds the
   * configuration, and with it the key, past start.
   */
  const { eventSource, logger, wallClock } = configuration;

  /** The configuration, held only until start has checked it and taken the key. */
  const pending: { configuration: BridgeConfiguration | undefined } = {
    configuration,
  };

  /**
   * The log for when the core has none of its own: none for an invalid logger, and otherwise one
   * on the configured event source and wall clock, each replaced by its fallback when it would not
   * pass the start check.
   */
  const settingsLog = (): EventLog | undefined =>
    isLogger(logger)
      ? createEventLog({
          logger,
          source: isNonEmptyString(eventSource)
            ? eventSource
            : UNCONFIGURED_SOURCE,
          wallClock:
            wallClock !== undefined && isClockOrAbsent(wallClock)
              ? wallClock
              : DATE_CLOCK,
        })
      : undefined;

  /**
   * A function rather than an inline comparison: TypeScript keeps `state.phase` narrowed across an
   * await, during which a stop may land.
   */
  const isStopped = (): boolean => state.phase === 'stopped';

  const start = async (): Promise<void> => {
    const input = pending.configuration;
    if (state.phase !== 'new' || input === undefined) {
      throw new UsherContractError(CORE_RULES.startOnce);
    }
    pending.configuration = undefined;
    state.phase = 'starting';
    const check = checkConfiguration(input);
    if (!check.ok) {
      throw refusal(check.reason, settingsLog(), check.problems);
    }
    const { key, ...checked } = check.configuration;
    const events = createEventLog({
      logger: checked.logger,
      source: checked.eventSource,
      wallClock: checked.clocks.wall,
    });
    state.events = events;
    const unreadable = checked.payloadVersions.flatMap((version, index) =>
      isReadablePayloadVersion(version)
        ? []
        : [
            {
              position: `payloadVersions[${index}]`,
              rule: START_REFUSAL_RULES.payloadVersionUnreadable,
            },
          ],
    );
    if (unreadable.length > 0) {
      throw refusal('payloadVersionUnreadable', events, unreadable);
    }
    const { registrations } = state;
    if (registrations === undefined) {
      throw refusal('notRegistered', events);
    }
    if (audiencesInUse.has(checked.audience)) {
      throw refusal('audienceInUse', events);
    }
    audiencesInUse.add(checked.audience);
    state.audience = checked.audience;
    const keys = await importApplicationKey(key).catch(() => {
      audiencesInUse.delete(checked.audience);
      state.audience = undefined;
      throw refusal('keyUnusable', events);
    });
    if (isStopped()) {
      return;
    }
    const built: { runtime: UnstartedRuntime | undefined } = {
      runtime: undefined,
    };
    try {
      built.runtime = createRuntime({
        configuration: checked,
        events,
        keys,
        random: seams.random ?? Math.random,
        registrations,
        seams,
      });
      built.runtime.startChannel();
    } catch {
      // A channel that throws as it starts may have started part of itself, so what was built is
      // stopped before the refusal settles, and a stop that fails cannot replace the refusal.
      await built.runtime?.stop().catch(() => undefined);
      audiencesInUse.delete(checked.audience);
      state.audience = undefined;
      throw refusal('startDefect', events);
    }
    const { runtime } = built;
    state.runtime = runtime;
    state.phase = 'running';
    Object.entries(registrations)
      .filter(([, registration]) => needsResourceList(registration))
      .forEach(([catalogue]) =>
        events.emit('catalogue.resourceListMissing', { catalogue }),
      );
    await runtime.refreshAnonymous();
  };

  /**
   * Closes the seams and frees the audience only once start, every flight and the channel have
   * ended: those use the seams' connections, and no work of this core may overlap a successor's on
   * the same audience.
   */
  const stopInOrder = async (): Promise<void> => {
    const { starting } = state;
    const ending = state.runtime?.stop();
    pending.configuration = undefined;
    state.runtime = undefined;
    state.phase = 'stopped';
    await starting?.catch(() => undefined);
    await ending;
    await seams.close?.().catch(() => undefined);
    if (state.audience !== undefined) {
      audiencesInUse.delete(state.audience);
      state.audience = undefined;
    }
  };

  // Of the members reachable by a host, applyNotice, reset and refreshAnonymous can only take
  // access away. Recording a check, which keeps the mode normal, is reachable only from the
  // revocation channel's context.
  return {
    applyNotice: (notice) => state.runtime?.applyNotice(notice),

    mode: () => state.runtime?.mode() ?? 'cold',

    refreshAnonymous: () =>
      state.runtime === undefined
        ? Promise.reject(
            new UsherContractError(
              state.registrations === undefined
                ? START_REFUSAL_RULES.notRegistered
                : CORE_RULES.startFirst,
            ),
          )
        : state.runtime.refreshAnonymous(),

    register: (registrations) => {
      if (state.registrations !== undefined || state.phase !== 'new') {
        throw new UsherContractError(CORE_RULES.once);
      }
      state.registrations = registeredCopy(registrations);
    },

    report: (name, data) => (state.events ?? settingsLog())?.emit(name, data),

    reset: () => state.runtime?.reset(),

    resolve: (credential) =>
      state.runtime === undefined
        ? Promise.resolve(UNAVAILABLE)
        : state.runtime.resolve(credential),

    start: () => {
      const starting = start();
      state.starting ??= starting;
      return starting;
    },

    stop: () => {
      state.stopping ??= stopInOrder();
      return state.stopping;
    },
  };
};
