import type { Notice } from '@overture-stack/usher-types';
import { createParser, type EventSourceMessage } from 'eventsource-parser';

import { untilAborted } from './abortable.js';
import { type ChannelReader, NOTICE_VERSIONS } from './channelReader.js';
import type { ControllerFetch } from './controllerClient.js';
import type { BridgeEventData, EventLog } from './events.js';
import { NOTICE_VERSIONS_HEADER } from './poll.js';

type MalformedReason = BridgeEventData['revocationChannel.malformed']['reason'];

/** The most characters buffered by the parser across chunks before the stream is malformed. */
export const PUSH_BUFFER_CHARACTERS: number = 64 * 1024;

/** The first reconnect's backoff ceiling, doubled with each attempt up to the cap. */
const BACKOFF_BASE_MS = 1_000;

/** Where the push hands what it read and what it saw. */
export interface PushSink {
  /** Applies one pushed notice, in order. */
  applyNotice(notice: Notice): void;

  /** Applying a pushed notice, handing over the loss of history, or reporting silence threw. */
  defect(): void;

  /** History no longer reaches the push position: the push holds none until it opens from head again. */
  historyLost(): void;

  /** The push stayed silent past its idle timer: its connection is closed, to be replaced. */
  silent(): void;
}

/** What the push needs. */
export interface PushOptions {
  /** Signs a fresh channel assertion on each call. */
  assertion: () => Promise<string>;

  /** The controller's base URL, ending in `/`. */
  controllerUrl: URL;

  events: EventLog;
  fetch: ControllerFetch;

  /**
   * Where the push opens while it holds no position of its own. While it returns `undefined`, the
   * push waits out its backoff and asks again.
   */
  headPosition: () => string | undefined;

  /** How long the push may stay silent before it is replaced. */
  idleMs: number;

  /** The most a reconnect waits, however many attempts have failed. */
  maxBackoffMs: number;

  /** Uniform randomness in [0, 1), for the reconnect's full jitter. */
  random: () => number;

  reader: Pick<ChannelReader, 'readNotice'>;
  sink: PushSink;
}

/** The push: notices as they commit, between polls; never a check. */
export interface Push {
  /** Drops the push position and the connection, to open again from the next head. */
  forget(): void;

  /** The cursor to resume after, sent as `Last-Event-ID`, or `undefined` while the push holds none. */
  position(): string | undefined;

  /** Opens the push, and keeps it open until stopped; a second call does nothing. */
  start(): void;

  /**
   * Closes the connection and cancels every timer; nothing read afterwards is applied.
   *
   * @returns a promise settled once the connection in progress, if any, has ended.
   */
  stop(): Promise<void>;
}

/** Why one connection ended. */
type Ending =
  'closed' | 'historyLost' | 'malformed' | 'streamMissing' | 'versionsRefused';

/** How a connection answered with something other than an event stream ends. */
const endingForStatus = (status: number): Ending => {
  switch (status) {
    case 200:
      return 'streamMissing';
    case 406:
      return 'versionsRefused';
    case 410:
      return 'historyLost';
    default:
      return 'closed';
  }
};

/**
 * Creates the push, which reads the controller's `notices/stream` as Server-Sent Events, resuming
 * after its push position with `Last-Event-ID`, or opening from `headPosition` while it holds none.
 * The push confirms no check, and its timers are unreferenced.
 *
 * - Each attempt sends a fresh channel assertion and lists {@link NOTICE_VERSIONS}.
 * - Each `notice` event is read by the channel reader, applied, and moves the push position, but only
 *   when its SSE id equals the cursor inside it.
 * - An event that fails to read or to match its id, a 406, a 200 that is not an event stream and a
 *   parser overflow are logged as `revocationChannel.malformed`, and the push reconnects from the
 *   last applied position.
 * - A throw while applying a notice is handed to the sink as a defect, and the push reconnects from
 *   the last applied position too.
 * - A push silent past its idle timer is replaced, logged as `revocationChannel.pushReconnect`, and
 *   reported to the sink as silent.
 * - A 410 drops the push position and hands the loss of history to the sink, and the push reconnects
 *   from `headPosition`.
 * - A throw from the sink while it takes the loss of history or a silence is handed to the sink as a
 *   defect.
 * - Every reconnect waits a full-jitter exponential backoff, capped at `maxBackoffMs`.
 */
export const createPush = ({
  assertion,
  controllerUrl,
  events,
  fetch,
  headPosition,
  idleMs,
  maxBackoffMs,
  random,
  reader,
  sink,
}: PushOptions): Push => {
  const state: {
    attempts: number;
    connection: AbortController | undefined;
    position: string | undefined;
    running: Promise<void> | undefined;
    started: boolean;
    stopped: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    attempts: 0,
    connection: undefined,
    position: undefined,
    running: undefined,
    started: false,
    stopped: false,
    timer: undefined,
  };

  const malformed = (reason: MalformedReason): 'malformed' => {
    events.emit('revocationChannel.malformed', { reason });
    return 'malformed';
  };

  /**
   * Applies one `notice` event, or names why the connection must end. A notice read once its
   * connection was aborted is not applied and does not move the position: the reconnect replays it,
   * and the poll carries it regardless.
   */
  const applyNoticeEvent = async (
    event: EventSourceMessage,
    signal: AbortSignal,
  ): Promise<'applied' | 'closed' | 'malformed'> => {
    const reading = await reader.readNotice(event.data);
    if (signal.aborted) {
      return 'closed';
    }
    if (reading.kind === 'malformed') {
      return malformed(reading.reason);
    }
    if (reading.notice.cursor !== event.id) {
      return malformed('idMismatch');
    }
    try {
      sink.applyNotice(reading.notice);
    } catch {
      sink.defect();
      return 'closed';
    }
    state.position = event.id;
    state.attempts = 0;
    return 'applied';
  };

  const handle = async (
    event: EventSourceMessage,
    signal: AbortSignal,
  ): Promise<'applied' | 'closed' | 'ignored' | 'malformed'> =>
    event.event === 'notice' ? applyNoticeEvent(event, signal) : 'ignored';

  /** Handles `pending` in order, stopping at the first event that ends the connection. */
  const handleAll = async (
    pending: readonly EventSourceMessage[],
    signal: AbortSignal,
  ): Promise<Ending | undefined> => {
    const [event, ...rest] = pending;
    if (event === undefined) {
      return undefined;
    }
    const outcome = await handle(event, signal);
    return outcome === 'applied' || outcome === 'ignored'
      ? handleAll(rest, signal)
      : outcome;
  };

  /** Reads the stream until it ends, is aborted, or carries something malformed. */
  const read = async (
    body: ReadableStream<Uint8Array>,
    connection: AbortController,
    armIdle: () => void,
  ): Promise<Ending> => {
    const pending: EventSourceMessage[] = [];
    const overflow = { seen: false };
    const parser = createParser({
      maxBufferSize: PUSH_BUFFER_CHARACTERS,
      onError: (error) => {
        if (error.type === 'max-buffer-size-exceeded') {
          overflow.seen = true;
        }
      },
      onEvent: (event) => pending.push(event),
    });
    const decoder = new TextDecoder();
    const reader = body.getReader();

    const next = async (): Promise<Ending> => {
      const { done, value } = await untilAborted(
        connection.signal,
        reader.read(),
      );
      if (done || state.stopped) {
        return 'closed';
      }
      armIdle();
      parser.feed(decoder.decode(value, { stream: true }));
      if (overflow.seen) {
        return malformed('parserOverflow');
      }
      const completed = pending.splice(0);
      const outcome = await handleAll(completed, connection.signal);
      return outcome ?? next();
    };

    try {
      return await next();
    } finally {
      connection.abort();
      void reader.cancel().catch(() => undefined);
    }
  };

  /**
   * One connection attempt, from opening the request to the stream's end. The idle timer runs from
   * the attempt's start, so a path that never answers, headers included, is replaced like a silent
   * one; every byte re-arms it.
   */
  const connect = async (from: string): Promise<Ending> => {
    const connection = new AbortController();
    state.connection = connection;
    const idle: { timer: ReturnType<typeof setTimeout> | undefined } = {
      timer: undefined,
    };
    const armIdle = (): void => {
      clearTimeout(idle.timer);
      idle.timer = setTimeout(() => {
        events.emit('revocationChannel.pushReconnect', {
          reason: 'idleTimeout',
        });
        connection.abort();
        try {
          sink.silent();
        } catch {
          sink.defect();
        }
      }, idleMs);
      idle.timer.unref?.();
    };
    armIdle();
    try {
      const response = await untilAborted(
        connection.signal,
        fetch(new URL('notices/stream', controllerUrl), {
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${await assertion()}`,
            'last-event-id': from,
            [NOTICE_VERSIONS_HEADER]: NOTICE_VERSIONS.join(','),
          },
          method: 'GET',
          redirect: 'error',
          signal: connection.signal,
        }),
      );
      const isStream = (response.headers.get('content-type') ?? '')
        .toLowerCase()
        .startsWith('text/event-stream');
      if (response.status === 200 && isStream && response.body !== null) {
        return await read(response.body, connection, armIdle);
      }
      void response.body?.cancel().catch(() => undefined);
      return endingForStatus(response.status);
    } catch {
      return 'closed';
    } finally {
      clearTimeout(idle.timer);
      state.connection = undefined;
    }
  };

  /** The most the next reconnect may wait, after `attempts` attempts with no notice applied. */
  const backoffCeiling = (attempts: number): number =>
    Math.min(maxBackoffMs, BACKOFF_BASE_MS * 2 ** attempts);

  const schedule = (delayMs: number): void => {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      attempt();
    }, delayMs);
    state.timer.unref?.();
  };

  const run = async (): Promise<void> => {
    const from = state.position ?? headPosition();
    if (from !== undefined) {
      const ending = await connect(from);
      if (state.stopped) {
        return;
      }
      if (ending === 'historyLost') {
        state.position = undefined;
        try {
          sink.historyLost();
        } catch {
          sink.defect();
        }
      }
      if (ending === 'streamMissing' || ending === 'versionsRefused') {
        malformed(ending);
      }
    }
    schedule(Math.floor(random() * backoffCeiling(state.attempts)));
    state.attempts += 1;
  };

  const attempt = (): void => {
    if (state.stopped || state.running !== undefined) {
      return;
    }
    state.running = run().finally(() => {
      state.running = undefined;
    });
  };

  return {
    forget: () => {
      state.position = undefined;
      state.connection?.abort();
    },

    position: () => state.position,

    start: () => {
      if (!state.started) {
        state.started = true;
        attempt();
      }
    },

    stop: async () => {
      state.stopped = true;
      clearTimeout(state.timer);
      state.timer = undefined;
      state.connection?.abort();
      await state.running;
    },
  };
};
