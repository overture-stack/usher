import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import {
  type BridgeConfiguration,
  type BridgeCore,
  type BridgeEventData,
  type BridgeLogger,
  type BridgeMode,
  type BridgeOptions,
  type Clock,
  CONFIGURATION_DEFAULTS,
  createBridgeCore,
  createUsherMiddleware,
  type ResolveOutcome,
} from '@overture-stack/usher-express-bridge';
import {
  type KeyRegistration,
  PAYLOAD_VERSION,
  readAccess,
  type UsherPrincipal,
} from '@overture-stack/usher-types';
import express from 'express';

import {
  type ChannelReader,
  createChannelReader,
  importApplicationKey,
} from './bridgeWire.js';
import { RELAYED_PATHS } from './containers.js';
import type {
  ControllerApplication,
  ControllerConfiguration,
} from './controller.js';
import { COMPRESSED_CONTROLLER_TIMING } from './harness.js';
import { type EvaluatedRecord, matchesSqon } from './sqonEvaluator.js';
import { type Cleanup, eventually } from './waiting.js';

// The vendored bridge's public core and Express middleware, run against the controller as a host
// runs them (#215's expectations and scenario suites, #217): reached through a fetch that records
// each request, logging to a logger that records each event.

/** The fetch the bridge reaches the controller through, as its options take one. */
export type ControllerFetch = NonNullable<BridgeOptions['fetch']>;

/** A bridge event's name, without the `bio.overture.` prefix its envelope's `type` carries. */
export type BridgeEventName = keyof BridgeEventData;

/**
 * The bridge's timing settings, as its configuration names them (`configuration.ts`
 * `BridgeConfiguration`): T `pollIntervalMs`, D `pollDeadlineMs`, G `graceMs`, R
 * `pollRecoveryIntervalMs`, I `pushIdleMs`, the exchange timeout `exchangeTimeoutMs`, the token TTL
 * `tokenTtlMs`, and the failure hold `stores.failureHoldMs`. One left out takes the bridge's default
 * (`CONFIGURATION_DEFAULTS`).
 */
export type BridgeTiming = Pick<
  BridgeConfiguration,
  | 'exchangeTimeoutMs'
  | 'graceMs'
  | 'pollDeadlineMs'
  | 'pollIntervalMs'
  | 'pollRecoveryIntervalMs'
  | 'pushIdleMs'
  | 'stores'
  | 'tokenTtlMs'
>;

/** One timing profile: the bridge's settings, and the controller's, which a harness's configuration takes. */
export interface TimingProfile {
  bridge: Readonly<BridgeTiming>;
  controller: Readonly<Partial<ControllerConfiguration>>;
}

/**
 * #217's two timing profiles.
 *
 * - `compressed`: the bridge at T 2 s, D 0.5 s, G 4 s, R 1 s, I 1.5 s, a 1 s exchange timeout, a 10 s
 *   token TTL and a 1 s failure hold, and the controller at harness.ts's
 *   {@link COMPRESSED_CONTROLLER_TIMING}. It keeps the bridge's own order between them: I and R no
 *   more than T, 11 T + 20 D below 10 G, and I at least twice the controller's 0.5 s heartbeat.
 * - `ims`: the bridge's defaults (T 30 s, D 10 s, G 60 s, R 10 s, I 25 s) and the controller's
 *   production defaults, which the harness's configuration holds.
 */
export const TIMING_PROFILES: Readonly<{
  compressed: TimingProfile;
  ims: TimingProfile;
}> = Object.freeze({
  compressed: Object.freeze({
    bridge: Object.freeze({
      exchangeTimeoutMs: 1000,
      graceMs: 4000,
      pollDeadlineMs: 500,
      pollIntervalMs: 2000,
      pollRecoveryIntervalMs: 1000,
      pushIdleMs: 1500,
      stores: Object.freeze({ failureHoldMs: 1000 }),
      tokenTtlMs: 10_000,
    }),
    controller: COMPRESSED_CONTROLLER_TIMING,
  }),
  ims: Object.freeze({
    bridge: Object.freeze({}),
    controller: Object.freeze({}),
  }),
});

/** A timing profile's name in {@link TIMING_PROFILES}. */
export type TimingProfileName = keyof typeof TIMING_PROFILES;

/**
 * Bridge settings a test sets over a profile's, such as a longer exchange timeout: any of
 * {@link BridgeTiming}, the failure hold among the stores' settings.
 */
export type BridgeTimingOverride = Partial<Omit<BridgeTiming, 'stores'>> & {
  stores?: { failureHoldMs?: number };
};

const timingOver = (
  name: TimingProfileName,
  { stores, ...override }: BridgeTimingOverride,
): Readonly<BridgeTiming> => {
  const { bridge } = TIMING_PROFILES[name];
  const failureHoldMs = stores?.failureHoldMs ?? bridge.stores?.failureHoldMs;
  return {
    ...bridge,
    ...override,
    ...(failureHoldMs === undefined ? {} : { stores: { failureHoldMs } }),
  };
};

/** A profile's bridge timing with every default filled in, in milliseconds, for a test's bounds. */
export interface ResolvedBridgeTiming {
  exchangeTimeoutMs: number;
  failureHoldMs: number;
  graceMs: number;
  pollDeadlineMs: number;
  pollIntervalMs: number;
  pollRecoveryIntervalMs: number;
  pushIdleMs: number;
  tokenTtlMs: number;
}

/**
 * A profile's bridge timing as the bridge resolves it: each setting the override gives, then each the
 * profile gives, and the bridge's default (`CONFIGURATION_DEFAULTS`) for the rest, the recovery
 * interval's being the smaller of 10 s and the poll interval, as `configuration.ts`
 * `checkConfiguration` resolves it.
 *
 * @param name the profile.
 * @param override settings over the profile's: none by default.
 */
export const resolvedBridgeTiming = (
  name: TimingProfileName,
  override: BridgeTimingOverride = {},
): ResolvedBridgeTiming => {
  const bridge = timingOver(name, override);
  const pollIntervalMs =
    bridge.pollIntervalMs ?? CONFIGURATION_DEFAULTS.pollIntervalMs;
  return {
    exchangeTimeoutMs:
      bridge.exchangeTimeoutMs ?? CONFIGURATION_DEFAULTS.exchangeTimeoutMs,
    failureHoldMs:
      bridge.stores?.failureHoldMs ??
      CONFIGURATION_DEFAULTS.stores.failureHoldMs,
    graceMs: bridge.graceMs ?? CONFIGURATION_DEFAULTS.graceMs,
    pollDeadlineMs:
      bridge.pollDeadlineMs ?? CONFIGURATION_DEFAULTS.pollDeadlineMs,
    pollIntervalMs,
    pollRecoveryIntervalMs:
      bridge.pollRecoveryIntervalMs ??
      Math.min(CONFIGURATION_DEFAULTS.pollRecoveryIntervalMs, pollIntervalMs),
    pushIdleMs: bridge.pushIdleMs ?? CONFIGURATION_DEFAULTS.pushIdleMs,
    tokenTtlMs: bridge.tokenTtlMs ?? CONFIGURATION_DEFAULTS.tokenTtlMs,
  };
};

/** A poll's answer as the bridge's channel reader reads it: the cursor it names, and whether it asks for more. */
export interface RecordedPollPage {
  more: boolean;
  next: string;
}

/** How one request the bridge started was answered, as the recording fetch saw it. */
export interface RecordedAnswer {
  /** When the status and headers arrived, by `performance.now()`. */
  arrivedAt: number;

  /**
   * For a poll answered 200, its answer's `next` and `more`, read from a copy of the body through the
   * bridge's channel reader (`bridgeWire.ts`) under the application's key; `null` when the copy could
   * not be read or the reader refuses it; `undefined` until the copy has been read, and for every
   * other request.
   */
  poll: RecordedPollPage | null | undefined;

  status: number;
}

/** One request the bridge started, as the recording fetch saw it before passing it on, and its answer. */
export interface RecordedBridgeRequest {
  /** Its answer, once its status and headers have arrived; `undefined` before, and for a request that failed. */
  answer: RecordedAnswer | undefined;

  /**
   * Its body's text, as the bridge sent it, up to {@link RECORDED_BODY_CHARACTERS} characters;
   * `undefined` for a request sending none.
   */
  body: string | undefined;

  /** When the request failed, by `performance.now()`: a network failure, or its signal aborting it. */
  failedAt: number | undefined;

  /** The `last-event-id` header, which a push's request carries; `undefined` when absent. */
  lastEventId: string | undefined;

  method: string;

  /**
   * The path relative to the controller's URL, as the bridge names it (`exchange`, `notices`,
   * `notices/stream`); the whole path for a URL outside the controller's.
   */
  path: string;

  /** The query, without its `?`: empty for none. */
  query: string;

  /** When the bridge started it, by `performance.now()`. */
  startedAt: number;
}

/** A fetch on undici with an Agent of its own, recording every request the bridge makes through it. */
export interface RecordingFetch {
  /** Closes the Agent, ending its connections, and settles once it has closed; a stopped bridge needs it no more. */
  close(): Promise<void>;

  fetch: ControllerFetch;

  /** Every request started through it, in order. */
  requests(): readonly RecordedBridgeRequest[];
}

/** The most characters of a request's body the recording fetch keeps. */
export const RECORDED_BODY_CHARACTERS = 16_384;

interface UndiciAgent {
  close(): Promise<void>;
}

type UndiciResponse = Awaited<ReturnType<ControllerFetch>> & {
  clone(): { text(): Promise<string> };
};

interface BridgeUndici {
  Agent: new () => UndiciAgent;
  fetch: (
    url: URL,
    init: Parameters<ControllerFetch>[1] & { dispatcher: UndiciAgent },
  ) => Promise<UndiciResponse>;
  getGlobalDispatcher(): unknown;
  MockAgent: new () => { close(): Promise<void>; disableNetConnect(): void };
  setGlobalDispatcher(dispatcher: unknown): void;
}

const isBridgeUndici = (value: unknown): value is BridgeUndici =>
  typeof value === 'object' &&
  value !== null &&
  ['Agent', 'fetch', 'getGlobalDispatcher', 'MockAgent', 'setGlobalDispatcher']
    .map((name) => Reflect.get(value, name))
    .every((member) => typeof member === 'function');

// undici is the bridge's dependency, not this project's, so it is resolved from the
// bridge's own location: the one the bridge's default fetch runs on (`defaultSeams.ts`).
const bridgeUndici = (): BridgeUndici => {
  const loaded: unknown = createRequire(
    import.meta.resolve('@overture-stack/usher-express-bridge'),
  )('undici');
  if (isBridgeUndici(loaded)) {
    return loaded;
  }
  throw new Error(
    "the bridge's undici exports no Agent, fetch or global dispatcher",
  );
};

/**
 * Sets a global dispatcher refusing every connection, as a host blocking its global dispatcher does,
 * on the bridge's own undici, and defers putting the host's back. The global dispatcher is
 * the process's, so the test's own `fetch` is refused too until the cleanup runs; the recording
 * fetch, on an Agent of its own as the bridge's default fetch is, goes on reaching the controller.
 *
 * @param scope the test's cleanup, deferred to before the bridge starts so it runs after the bridge
 *   stops.
 */
export const blockGlobalDispatcher = async (scope: Cleanup): Promise<void> => {
  const undici = bridgeUndici();
  const hostDispatcher = undici.getGlobalDispatcher();
  const blocking = new undici.MockAgent();
  blocking.disableNetConnect();
  undici.setGlobalDispatcher(blocking);
  scope.defer(async () => {
    undici.setGlobalDispatcher(hostDispatcher);
    await blocking.close();
  });
};

const headerIn = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined =>
  Object.entries(headers).find(
    ([header]) => header.toLowerCase() === name,
  )?.[1];

/** What the recording fetch is told beyond the controller's URL. */
export interface RecordingFetchOptions {
  /**
   * The application key the bridge holds, under whose poll-answer subkey a poll's answer is read for
   * its `next` and `more`; without it, no poll's answer is read.
   */
  applicationKey?: string;
}

interface BodyCopy {
  text(): Promise<string>;
}

// The copy is taken before the answer is handed to the bridge, which reads its own body from then on.
const copyOf = (answered: UndiciResponse): BodyCopy | undefined => {
  try {
    return answered.clone();
  } catch {
    return undefined;
  }
};

const pollPageOf = async (
  reader: Promise<ChannelReader>,
  copy: BodyCopy | undefined,
): Promise<RecordedPollPage | null> => {
  if (copy === undefined) {
    return null;
  }
  try {
    const reading = await (
      await reader
    ).readPollAnswer((await copy.text()).trim());
    return reading.kind === 'answer'
      ? { more: reading.answer.more, next: reading.answer.next }
      : null;
  } catch {
    return null;
  }
};

/**
 * Creates a fetch for the bridge, handed to `createBridgeCore` as its `fetch`, that runs on
 * the bridge's own undici with an Agent of its own, as the bridge's default fetch does
 * (`defaultSeams.ts`), so a global dispatcher never carries it. Each request is recorded as it starts:
 * its start time, method, path, query, `Last-Event-ID` and body. Its answer is recorded as its status
 * and headers arrive, with their arrival time; a poll answered 200 also has its `next` and `more`
 * read, from a copy of the body, so the bridge reads its own body untouched; a request that fails is
 * recorded failed. The Agent is made at the first request and closed by
 * {@link RecordingFetch.close}, which the bridge never calls for a fetch it was handed.
 *
 * @param controllerUrl the URL the bridge is configured with, which paths are recorded relative to.
 * @param options the application key a poll's answer is read under.
 */
export const createRecordingFetch = (
  controllerUrl: URL,
  { applicationKey }: RecordingFetchOptions = {},
): RecordingFetch => {
  const undici = bridgeUndici();
  const base = new URL(controllerUrl);
  const state: {
    agent: UndiciAgent | undefined;
    reader: Promise<ChannelReader> | undefined;
    requests: readonly RecordedBridgeRequest[];
  } = { agent: undefined, reader: undefined, requests: [] };
  const relative = (url: URL): string =>
    url.origin === base.origin && url.pathname.startsWith(base.pathname)
      ? url.pathname.slice(base.pathname.length)
      : url.pathname;
  const update = (
    index: number,
    change: (recorded: RecordedBridgeRequest) => RecordedBridgeRequest,
  ): void => {
    const recorded = state.requests[index];
    if (recorded !== undefined) {
      state.requests = state.requests.with(index, change(recorded));
    }
  };
  const readerFor = (key: string): Promise<ChannelReader> => {
    state.reader ??= importApplicationKey(key).then(createChannelReader);
    return state.reader;
  };
  return {
    close: async () => {
      const { agent } = state;
      state.agent = undefined;
      await agent?.close();
    },
    fetch: async (url, init) => {
      const path = relative(url);
      const index = state.requests.length;
      state.requests = [
        ...state.requests,
        {
          answer: undefined,
          body: init.body?.slice(0, RECORDED_BODY_CHARACTERS),
          failedAt: undefined,
          lastEventId: headerIn(init.headers, 'last-event-id'),
          method: init.method,
          path,
          query: url.search.slice(1),
          startedAt: performance.now(),
        },
      ];
      state.agent ??= new undici.Agent();
      const answered = await undici
        .fetch(url, { ...init, dispatcher: state.agent })
        .catch((error: unknown) => {
          update(index, (recorded) => ({
            ...recorded,
            failedAt: performance.now(),
          }));
          throw error;
        });
      const answer: RecordedAnswer = {
        arrivedAt: performance.now(),
        poll: undefined,
        status: answered.status,
      };
      update(index, (recorded) => ({ ...recorded, answer }));
      if (
        applicationKey !== undefined &&
        path === RELAYED_PATHS.notices &&
        answered.status === 200
      ) {
        void pollPageOf(readerFor(applicationKey), copyOf(answered)).then(
          (poll) =>
            update(index, (recorded) => ({
              ...recorded,
              answer: { ...answer, poll },
            })),
        );
      }
      return answered;
    },
    requests: () => state.requests,
  };
};

/**
 * The credential an exchange the bridge started carried, read from its recorded body as the bridge's
 * controller client writes it (`exchange.ts`): the person's credential, `null` for the anonymous exchange,
 * whose body carries none, or `undefined` for any other request, or a body cut short or unreadable.
 *
 * @param request a recorded request.
 */
export const exchangedCredentialOf = (
  request: RecordedBridgeRequest,
): string | null | undefined => {
  if (request.path !== RELAYED_PATHS.exchange || request.body === undefined) {
    return undefined;
  }
  try {
    const sent: unknown = JSON.parse(request.body);
    const credential: unknown = isRecord(sent)
      ? Reflect.get(sent, 'credential')
      : undefined;
    if (isRecord(sent) && credential === undefined) {
      return null;
    }
    return typeof credential === 'string' ? credential : undefined;
  } catch {
    return undefined;
  }
};

/** One event the bridge logged, as the recording logger received it. */
export interface RecordedBridgeEvent {
  /** When it arrived, by `performance.now()`. */
  arrivedAt: number;

  /** Its `data`: `actorId`, `actorType` and the event's own fields. */
  data: Readonly<Record<string, unknown>>;

  /** The whole CloudEvents envelope the bridge logged. */
  envelope: Readonly<Record<string, unknown>>;

  /** The logger's method the bridge called: `warn` for a warning, `error` for an error or a critical event. */
  level: 'error' | 'info' | 'warn';

  /** The event's name, without the `bio.overture.` prefix. */
  name: string;
}

/** What waiting for an event takes. */
export interface EventWait {
  /** The earliest arrival to accept, by `performance.now()`: any by default. */
  since?: number;

  /** How long to wait: 5 s by default. */
  timeoutMs?: number;

  /** A further condition on the event, such as a field's value. */
  where?: (event: RecordedBridgeEvent) => boolean;
}

/** A logger for the bridge, recording each event with its arrival time. */
export interface RecordingLogger {
  /** Every event received so far, in order; of one name alone when given. */
  events(name?: BridgeEventName): readonly RecordedBridgeEvent[];

  logger: BridgeLogger;

  /**
   * The first event of a name arriving since the time given and meeting the condition, waiting for it.
   *
   * @throws naming the event, when none arrives within the timeout.
   */
  nextEvent(
    name: BridgeEventName,
    wait?: EventWait,
  ): Promise<RecordedBridgeEvent>;
}

const EVENT_TYPE_PREFIX = 'bio.overture.';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Creates a logger for the bridge that records every event it is handed, with its arrival
 * time, and never throws, as the bridge requires of its logger (`events.ts` `BridgeLogger`).
 */
export const createRecordingLogger = (): RecordingLogger => {
  const received: RecordedBridgeEvent[] = [];
  const recordAt =
    (level: RecordedBridgeEvent['level']) =>
    (object: object): void => {
      const type = Reflect.get(object, 'type');
      const data = Reflect.get(object, 'data');
      received.push({
        arrivedAt: performance.now(),
        data: isRecord(data) ? data : {},
        envelope: isRecord(object) ? object : {},
        level,
        name:
          typeof type === 'string' && type.startsWith(EVENT_TYPE_PREFIX)
            ? type.slice(EVENT_TYPE_PREFIX.length)
            : String(type),
      });
    };
  const events = (name?: BridgeEventName): readonly RecordedBridgeEvent[] =>
    received.filter((event) => name === undefined || event.name === name);
  const found = (
    name: BridgeEventName,
    { since = 0, where = () => true }: EventWait,
  ): RecordedBridgeEvent | undefined =>
    events(name).find((event) => event.arrivedAt >= since && where(event));
  return {
    events,
    logger: {
      error: recordAt('error'),
      info: recordAt('info'),
      warn: recordAt('warn'),
    },
    nextEvent: async (name, wait = {}) => {
      const { timeoutMs = 5000 } = wait;
      await eventually(
        () => Promise.resolve(found(name, wait) !== undefined),
        timeoutMs,
        10,
      );
      const event = found(name, wait);
      if (event !== undefined) {
        return event;
      }
      throw new Error(`the bridge logged no ${name} within ${timeoutMs} ms`);
    },
  };
};

/** The CloudEvents `source` the bridges started here log under: one deployment of a host application. */
export const BRIDGE_EVENT_SOURCE = 'https://portal.example.org/usher-bridge';

/** The record key {@link DEFAULT_KEY_REGISTRATIONS} registers, which {@link reaches} reads by default. */
export const DEFAULT_RECORD_KEY = 'files';

/**
 * The keys a bridge registers unless a test gives its own: one record key, `files`, on the field
 * `study_id`, defining `global.controlled` and `global.community-governed` on `data_category`, as the
 * conformance expectations register theirs.
 */
export const DEFAULT_KEY_REGISTRATIONS: Readonly<
  Record<string, KeyRegistration>
> = Object.freeze({
  [DEFAULT_RECORD_KEY]: {
    categories: {
      global: {
        'global.community-governed': {
          content: {
            fieldName: 'data_category',
            value: ['community-governed'],
          },
          op: 'in',
        },
        'global.controlled': {
          content: { fieldName: 'data_category', value: ['controlled'] },
          op: 'in',
        },
      },
    },
    kind: 'record',
    resourceFieldName: 'study_id',
  },
});

/** What a bridge is started with. */
export interface BridgeStart {
  /** The application the bridge serves: its id is the audience, its key the application key. */
  application: ControllerApplication;

  /** The URL the bridge reaches the controller at: the controller's own, or a relay's in front of it. */
  controllerUrl: URL;

  /** The controller's issuer, which every Usher token names. */
  issuer: string;

  /** The timing profile in {@link TIMING_PROFILES}. */
  profile: TimingProfileName;

  /** The keys registered before the start: {@link DEFAULT_KEY_REGISTRATIONS} by default. */
  registrations?: Readonly<Record<string, KeyRegistration>>;

  /** Bridge settings over the profile's, such as a longer exchange timeout: none by default. */
  timing?: BridgeTimingOverride;

  /** The bridge's wall clock, such as one running ahead of the controller's: the system's by default. */
  wallClock?: Clock;
}

/** A vendored bridge running against the controller, with what it recorded, stopped by one call. */
export interface StartedBridge {
  /** The bridge's public core: `resolve`, `mode`, `applyNotice`, `reset`, `refreshAnonymous`. */
  core: BridgeCore;

  /** The fetch it reaches the controller through, and every request it started. */
  fetch: RecordingFetch;

  /** The logger it logs to, and every event it logged. */
  logger: RecordingLogger;

  /**
   * Stops the Express app, then the core, which waits for every exchange and fetch in flight, then
   * closes the fetch's Agent, settling once all have ended.
   */
  stop(): Promise<void>;

  /** The bridge's timing as it resolves it: the profile's, the override over it, and the defaults. */
  timing: ResolvedBridgeTiming;

  /**
   * A loopback Express app running the bridge's middleware, which answers every request it lets
   * through 200 with the request's access, read through usher-types' `readAccess`, as JSON.
   */
  url: URL;
}

const listening = (server: Server): Promise<URL> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
      );
    });
  });

const closed = (server: Server): Promise<void> =>
  server.listening
    ? new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
    : Promise.resolve();

/**
 * Starts a bridge as a host does: `createBridgeCore` given the controller's URL, the
 * application's id and key, the payload version usher-types reads, the event source, the recording
 * fetch and logger, and the profile's timing with any override over it; its keys registered; its
 * Express middleware mounted in a loopback app; then its start awaited, which imports the key and
 * fetches the anonymous payload. The monotonic clock is the bridge's default. A start that fails stops
 * everything it started before the failure is thrown.
 *
 * @param start the application, the controller's URL and issuer, the profile, and the keys, the
 *   timing override and the wall clock when not the defaults.
 */
export const startBridge = async ({
  application,
  controllerUrl,
  issuer,
  profile,
  registrations = DEFAULT_KEY_REGISTRATIONS,
  timing = {},
  wallClock,
}: BridgeStart): Promise<StartedBridge> => {
  const recordingFetch = createRecordingFetch(controllerUrl, {
    applicationKey: application.key,
  });
  const recordingLogger = createRecordingLogger();
  const core = createBridgeCore(
    {
      audience: application.id,
      controllerUrl,
      eventSource: BRIDGE_EVENT_SOURCE,
      issuer,
      key: application.key,
      logger: recordingLogger.logger,
      payloadVersions: [PAYLOAD_VERSION],
      ...timingOver(profile, timing),
      ...(wallClock === undefined ? {} : { wallClock }),
    },
    { fetch: recordingFetch.fetch },
  );
  core.register(registrations);
  const app = express();
  app.use(createUsherMiddleware(core));
  app.use((_request, response) => {
    response.json(readAccess(response.locals));
  });
  const server = createServer(app);
  const stop = async (): Promise<void> => {
    await closed(server);
    await core.stop();
    await recordingFetch.close();
  };
  try {
    const url = await listening(server);
    await core.start();
    return {
      core,
      fetch: recordingFetch,
      logger: recordingLogger,
      stop,
      timing: resolvedBridgeTiming(profile, timing),
      url,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

/** The jitter the bridge applies to its poll and recovery intervals, either way (`poll.ts`). */
export const INTERVAL_JITTER = 0.1;

/** What timers and loopback round trips may add to a bound computed from the bridge's timing. */
export const SCHEDULING_SLACK_MS = 250;

/**
 * The requests a bridge started to one of its paths, at or after an instant.
 *
 * @param bridge the bridge.
 * @param path one of `containers.ts`'s `RELAYED_PATHS`.
 * @param since the earliest start, by `performance.now()`: every request by default.
 */
export const requestsTo = (
  bridge: StartedBridge,
  path: string,
  since = 0,
): readonly RecordedBridgeRequest[] =>
  bridge.fetch
    .requests()
    .filter((request) => request.path === path && request.startedAt >= since);

/**
 * Whether a poll asked for head.
 *
 * @param request a recorded poll.
 */
export const isHeadPoll = (request: RecordedBridgeRequest): boolean =>
  new URLSearchParams(request.query).get('head') === 'true';

/**
 * The cursor a poll asked after, or `null` for a poll asking for head.
 *
 * @param request a recorded poll.
 */
export const afterCursorOf = (request: RecordedBridgeRequest): string | null =>
  new URLSearchParams(request.query).get('after');

/**
 * The events of one name a bridge logged at or after an instant.
 *
 * @param bridge the bridge.
 * @param name the event's name.
 * @param since the earliest arrival, by `performance.now()`.
 */
export const eventsSince = (
  bridge: StartedBridge,
  name: BridgeEventName,
  since: number,
): readonly RecordedBridgeEvent[] =>
  bridge.logger.events(name).filter(({ arrivedAt }) => arrivedAt >= since);

/**
 * Every mode change a bridge logged at or after an instant.
 *
 * @param bridge the bridge.
 * @param since the earliest arrival.
 */
export const modeChangesSince = (
  bridge: StartedBridge,
  since: number,
): readonly RecordedBridgeEvent[] =>
  eventsSince(bridge, 'revocationChannel.modeChange', since);

/**
 * The first mode change into a mode arriving at or after an instant, waiting for it.
 *
 * @param bridge the bridge.
 * @param toMode the mode changed into.
 * @param since the earliest arrival.
 * @param timeoutMs how long to wait.
 * @throws naming the event, when none arrives in time.
 */
export const nextModeChange = (
  bridge: StartedBridge,
  toMode: BridgeMode,
  since: number,
  timeoutMs: number,
): Promise<RecordedBridgeEvent> =>
  bridge.logger.nextEvent('revocationChannel.modeChange', {
    since,
    timeoutMs,
    where: ({ data }) => data['toMode'] === toMode,
  });

/**
 * The first notice of a kind a bridge applied at or after an instant, waiting for it.
 *
 * @param bridge the bridge.
 * @param kind the notice's kind.
 * @param since the earliest arrival.
 * @param timeoutMs how long to wait.
 * @throws naming the event, when none arrives in time.
 */
export const nextNotice = (
  bridge: StartedBridge,
  kind: string,
  since: number,
  timeoutMs: number,
): Promise<RecordedBridgeEvent> =>
  bridge.logger.nextEvent('notice.applied', {
    since,
    timeoutMs,
    where: ({ data }) => data['kind'] === kind,
  });

/**
 * How many cache entries an applied notice dropped, as its event says; not a number when it says none.
 *
 * @param event a `notice.applied` event.
 */
export const entriesDropped = (event: RecordedBridgeEvent): number => {
  const dropped = event.data['entriesDropped'];
  return typeof dropped === 'number' ? dropped : Number.NaN;
};

/**
 * Waits until a bridge reads as a mode, and gives when it first did.
 *
 * @param bridge the bridge.
 * @param mode the mode.
 * @param timeoutMs how long to wait.
 * @returns when the bridge was seen in the mode, by `performance.now()`.
 * @throws naming the mode, when the bridge never reads as it in time.
 */
export const untilMode = async (
  bridge: StartedBridge,
  mode: BridgeMode,
  timeoutMs: number,
): Promise<number> => {
  const reached = await eventually(
    () => Promise.resolve(bridge.core.mode() === mode),
    timeoutMs,
    10,
  );
  if (reached) {
    return performance.now();
  }
  throw new Error(`the bridge was not ${mode} within ${timeoutMs} ms`);
};

type CheckOutcome =
  | { kind: 'confirmed'; startedAt: number }
  | { kind: 'failed'; why: string }
  | { kind: 'pending' };

const PENDING: CheckOutcome = Object.freeze({ kind: 'pending' });

// A poll begins a check unless the page before it asked for more; whether it did is unknown until
// that page's answer has been read.
const beginsCheck = (
  previous: RecordedBridgeRequest | undefined,
): boolean | undefined => {
  const answer = previous?.answer;
  if (
    previous === undefined ||
    previous.failedAt !== undefined ||
    (answer !== undefined && answer.status !== 200)
  ) {
    return true;
  }
  if (answer?.poll === undefined) {
    return undefined;
  }
  return answer.poll === null || !answer.poll.more;
};

const checkOutcome = (
  pages: readonly RecordedBridgeRequest[],
  startedAt: number,
): CheckOutcome => {
  const [page, ...rest] = pages;
  if (page === undefined) {
    return PENDING;
  }
  if (page.failedAt !== undefined) {
    return { kind: 'failed', why: 'a page failed' };
  }
  if (page.answer === undefined || page.answer.poll === undefined) {
    return page.answer !== undefined && page.answer.status !== 200
      ? { kind: 'failed', why: `a page was answered ${page.answer.status}` }
      : PENDING;
  }
  if (page.answer.poll === null) {
    return { kind: 'failed', why: "a page's answer was unreadable" };
  }
  return page.answer.poll.more
    ? checkOutcome(rest, startedAt)
    : { kind: 'confirmed', startedAt };
};

const checkFrom = (
  polls: readonly RecordedBridgeRequest[],
  index: number,
): CheckOutcome => {
  const first = polls[index];
  const beginning = beginsCheck(polls[index - 1]);
  if (first === undefined || beginning === undefined) {
    return PENDING;
  }
  return beginning
    ? checkOutcome(polls.slice(index), first.startedAt)
    : checkFrom(polls, index + 1);
};

const firstCheckFrom = (
  polls: readonly RecordedBridgeRequest[],
  from: number,
): CheckOutcome => {
  const index = polls.findIndex((poll) => poll.startedAt >= from);
  return index < 0 ? PENDING : checkFrom(polls, index);
};

/**
 * Waits for the first check a bridge begins from now, through every page it asks for, and gives the
 * check's start: the start of its first page, a poll the page before it did not continue. The check
 * must succeed, each page answered 200 and read as the bridge reads it until one asks for no more, so
 * on a healthy channel it is the last check the bridge confirmed: its grace period runs from this
 * start, give or take the moment the bridge reads its clock before it signs the page's assertion, and
 * its next poll comes a poll interval's jitter after it.
 *
 * @param bridge the bridge.
 * @param timing its timing: the bridge's own by default.
 * @returns the check's start, by `performance.now()`.
 * @throws naming the failure, when the check fails, or none is confirmed within a poll interval and
 *   its jitter, a poll deadline and {@link SCHEDULING_SLACK_MS}.
 */
export const settledPollStart = async (
  bridge: StartedBridge,
  timing: ResolvedBridgeTiming = bridge.timing,
): Promise<number> => {
  const from = performance.now();
  const outcome = (): CheckOutcome =>
    firstCheckFrom(requestsTo(bridge, RELAYED_PATHS.notices), from);
  const boundMs =
    (1 + INTERVAL_JITTER) * timing.pollIntervalMs +
    timing.pollDeadlineMs +
    SCHEDULING_SLACK_MS;
  await eventually(
    () => Promise.resolve(outcome().kind !== 'pending'),
    boundMs,
    5,
  );
  const settled = outcome();
  if (settled.kind === 'confirmed') {
    return settled.startedAt;
  }
  throw new Error(
    settled.kind === 'failed'
      ? `the bridge's first check from now failed: ${settled.why}`
      : `the bridge confirmed no check within ${boundMs} ms`,
  );
};

/**
 * The principal an outcome carries, copied as a plain object, or `undefined` when the request was
 * refused or answered unavailable.
 *
 * @param outcome what the bridge resolved.
 */
export const principalOf = (
  outcome: ResolveOutcome,
): UsherPrincipal | undefined =>
  outcome.kind === 'access' ? { ...outcome.access.principal } : undefined;

/**
 * The subject owning an outcome's access: a confirmed principal's subject while it is not
 * suspended, `null` for any other principal, or `undefined` when the request was refused
 * or answered unavailable.
 *
 * @param outcome what the bridge resolved.
 */
export const subjectInForce = (
  outcome: ResolveOutcome,
): string | null | undefined => {
  const principal = principalOf(outcome);
  if (principal === undefined) {
    return undefined;
  }
  return principal.credential === 'confirmed' && !principal.suspended
    ? principal.subject
    : null;
};

/** The principal of a request carrying no credential: the open tier, unsuspended. */
export const NO_CREDENTIAL: UsherPrincipal = Object.freeze({
  credential: 'none',
  openTierOnly: true,
  suspended: false,
});

/** The principal of a credential not vouched for by the controller: the open tier, suspended. */
export const UNCONFIRMED: UsherPrincipal = Object.freeze({
  credential: 'unconfirmed',
  openTierOnly: true,
  suspended: true,
});

/**
 * The principal of a confirmed credential served while suspended: the open tier, with its subject
 * kept for attribution only.
 *
 * @param subject the confirmed subject.
 */
export const suspendedAs = (subject: string): UsherPrincipal =>
  Object.freeze({
    attributionOnlySubject: subject,
    credential: 'confirmed',
    openTierOnly: true,
    suspended: true,
  });

/**
 * Whether an outcome serves a record through a record key, as the search engine would read the
 * narrowing the bridge rendered: an allow serves it, a narrowing when usher-types' SQON evaluator
 * matches it; never a refused or unavailable outcome, nor a key it holds no result for.
 *
 * @param outcome what the bridge resolved.
 * @param record the record's values by field name.
 * @param key the record key: {@link DEFAULT_RECORD_KEY} by default.
 */
export const reaches = (
  outcome: ResolveOutcome,
  record: EvaluatedRecord,
  key: string = DEFAULT_RECORD_KEY,
): boolean => {
  if (outcome.kind !== 'access') {
    return false;
  }
  const result = outcome.access.results[key];
  if (result?.kind === 'allow') {
    return true;
  }
  return result?.kind === 'narrow' && matchesSqon(result.sqon, record);
};
