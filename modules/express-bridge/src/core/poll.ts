import { randomBytes } from 'node:crypto';

import type { Notice } from '@overture-stack/usher-types';

import { untilAborted } from './abortable.js';
import { type ChannelReader, NOTICE_VERSIONS } from './channelReader.js';
import type { Clock } from './clocks.js';
import type { ControllerFetch } from './controllerClient.js';
import type { BridgeEventData, EventLog } from './events.js';
import { textWithin } from './responseBody.js';

type MalformedReason = BridgeEventData['revocationChannel.malformed']['reason'];
type ChannelFailureCause =
  BridgeEventData['revocationChannel.failure']['cause'];

/** The request header carrying {@link NOTICE_VERSIONS} to the controller. */
export const NOTICE_VERSIONS_HEADER = 'usher-notice-versions';

/** What an answer from head echoes in place of the cursor it continued from. */
const HEAD = 'head';

/**
 * How one check ended: `checked` when recorded, `failed` when it failed or its answer was malformed,
 * `reset` when history was reset or a forget abandoned the check, and `stopped` once the poll stopped.
 */
export type CheckOutcome = 'checked' | 'failed' | 'reset' | 'stopped';

/** Where the poll hands what it reads and how each check ends. */
export interface PollSink {
  /** Applies one notice read from a page, in order. */
  applyNotice(notice: Notice): void;

  /** A check was recorded; `checkStartedAt` is its first page's start on the monotonic clock, in ms. */
  confirmChannel(checkStartedAt: number): void;

  /**
   * A check failed: `status` for an answer other than 200, 406 or 410, `network` for a request that
   * could not reach the controller, `timeout` for a check aborted at the deadline, and `defect` for a
   * throw while signing, reading or applying a page. A malformed answer is no failure, and a check
   * abandoned by a stop or a forget reports none.
   */
  failed(cause: ChannelFailureCause): void;

  /** The controller answered 410: history does not reach the poll position, which has been dropped. */
  reset(): void;
}

/** What the poll needs. */
export interface PollOptions {
  /** Signs a fresh channel assertion on each call. */
  assertion: () => Promise<string>;

  /** The controller's base URL, ending in `/`. */
  controllerUrl: URL;

  /** How long a check may run, from its first page's start, before it is aborted. */
  deadlineMs: number;

  events: EventLog;
  fetch: ControllerFetch;

  /**
   * The poll interval: from a recorded check's start to the next poll's, jittered by 10% either
   * way.
   */
  intervalMs: number;

  monotonicClock: Clock;

  /** Uniform randomness in [0, 1), for the interval's jitter. */
  random: () => number;

  reader: ChannelReader;

  /**
   * The recovery interval, at most `intervalMs` and jittered as it is: from the start of a retry that
   * failed or was malformed to the next poll's. Polls keep to it until a check is recorded.
   */
  recoveryIntervalMs: number;

  /** The most bytes read from an answer before it is refused unread. */
  responseCapBytes: number;

  sink: PollSink;
}

/** The poll: the channel's only check, and the recovery of any notice missed by the push. */
export interface Poll {
  /**
   * Runs one check now, joining one already running: every page from the poll position, under one
   * deadline from the first page's start. Resolves to how the check ended; once the poll has
   * stopped, it resolves to `stopped` without running one.
   */
  check(): Promise<CheckOutcome>;

  /**
   * Drops the poll position, so the next check asks for head, and abandons any check in flight: it
   * applies nothing more and records no check, and the next check starts afresh rather than joining
   * it.
   */
  forget(): void;

  /**
   * Polls at once, as the schedule would: a failure is retried at once and a reset asks for head at
   * once, and the next poll is timed from this check's start.
   */
  pollNow(): void;

  /** The next poll's `after` cursor, or `undefined` while the poll asks for head. */
  position(): string | undefined;

  /** Runs a check at once, then each on its schedule, until stopped; a second call does nothing. */
  start(): void;

  /**
   * Cancels the schedule, arming no timer afterwards, and aborts any check in flight; nothing read
   * afterwards is applied.
   *
   * @returns a promise settled once every check in flight, abandoned ones included, has ended.
   */
  stop(): Promise<void>;
}

type FetchedPage =
  | { kind: 'body'; text: string }
  | { cause: Exclude<ChannelFailureCause, 'status'>; kind: 'failed' }
  | { kind: 'status'; status: number }
  | { kind: 'tooLarge' };

type PageOutcome = CheckOutcome | 'more';

/** A check in flight; the next poll is timed from its `startedAt`. */
interface Running {
  outcome: Promise<CheckOutcome>;
  startedAt: number;
}

const query = (after: string | undefined, nonce: string): string =>
  new URLSearchParams(
    after === undefined ? { head: 'true', nonce } : { after, nonce },
  ).toString();

/**
 * Creates the poll, which asks the controller's `notices` endpoint for every notice after its poll
 * position, or for head explicitly while it holds none. Its timers are unreferenced.
 *
 * - Each page sends a fresh nonce and channel assertion and lists {@link NOTICE_VERSIONS}. Its answer
 *   must echo the nonce and the `after` it was sent.
 * - A check is recorded at its first page's start, and only once every page has answered 200 before
 *   the deadline, been read, echoed its request and been applied, the last with `more` false.
 * - The pages applied before an abort still move the position.
 * - A 410 drops the poll position, hands a reset to the sink, and asks for head. A 410 to a head
 *   request resets nothing: it is malformed, logged as `answerUnreadable`.
 * - A 406, an answer past the cap, one that fails to read or echo, and a page asking for more from a
 *   cursor already asked after in its check are logged as `revocationChannel.malformed`.
 * - A check that fails or is malformed is retried at once. A retry that ends the same way times the
 *   next poll at the recovery interval rather than the poll interval, and polls keep to the recovery
 *   interval until a check is recorded.
 */
export const createPoll = ({
  assertion,
  controllerUrl,
  deadlineMs,
  events,
  fetch,
  intervalMs,
  monotonicClock,
  random,
  reader,
  recoveryIntervalMs,
  responseCapBytes,
  sink,
}: PollOptions): Poll => {
  const state: {
    generation: number;
    inFlight: AbortController | undefined;
    position: string | undefined;
    running: Running | undefined;
    runs: Set<Promise<CheckOutcome>>;
    started: boolean;
    stopped: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    generation: 0,
    inFlight: undefined,
    position: undefined,
    running: undefined,
    runs: new Set(),
    started: false,
    stopped: false,
    timer: undefined,
  };

  /** Why a page stops after an await: the poll stopped, or it was forgotten since the check began. */
  const abandoned = (generation: number): CheckOutcome | undefined => {
    if (state.stopped) {
      return 'stopped';
    }
    return state.generation === generation ? undefined : 'reset';
  };

  const malformed = (reason: MalformedReason): 'failed' => {
    events.emit('revocationChannel.malformed', { reason });
    return 'failed';
  };

  const failure = (cause: ChannelFailureCause): 'failed' => {
    sink.failed(cause);
    return 'failed';
  };

  const signed = async (): Promise<string | undefined> => {
    try {
      return await assertion();
    } catch {
      return undefined;
    }
  };

  /**
   * A request or read that fails once the signal has aborted is a timeout. A stop or a forget also
   * aborts the signal, but abandons its check, so that failure is never reported.
   */
  const fetchPage = async (
    after: string | undefined,
    nonce: string,
    signal: AbortSignal,
  ): Promise<FetchedPage> => {
    const channelAssertion = await signed();
    if (channelAssertion === undefined) {
      return { cause: 'defect', kind: 'failed' };
    }
    try {
      const response = await untilAborted(
        signal,
        fetch(new URL(`notices?${query(after, nonce)}`, controllerUrl), {
          headers: {
            accept: 'application/jose',
            authorization: `Bearer ${channelAssertion}`,
            [NOTICE_VERSIONS_HEADER]: NOTICE_VERSIONS.join(','),
          },
          method: 'GET',
          redirect: 'error',
          signal,
        }),
      );
      if (response.status === 200) {
        const text = await untilAborted(
          signal,
          textWithin(response, responseCapBytes),
        );
        return text === undefined
          ? { kind: 'tooLarge' }
          : { kind: 'body', text: text.trim() };
      }
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'status', status: response.status };
    } catch {
      return { cause: signal.aborted ? 'timeout' : 'network', kind: 'failed' };
    }
  };

  /**
   * Ends a page that carried no body to read: as a failure, as malformed, or, on a 410 to a cursor,
   * as a reset.
   */
  const reportOrReset = (
    fetched: Exclude<FetchedPage, { kind: 'body' }>,
    after: string | undefined,
  ): 'failed' | 'reset' => {
    if (fetched.kind === 'failed') {
      return failure(fetched.cause);
    }
    if (fetched.kind === 'tooLarge') {
      return malformed('answerUnreadable');
    }
    if (fetched.status === 410) {
      if (after === undefined) {
        return malformed('answerUnreadable');
      }
      state.position = undefined;
      sink.reset();
      return 'reset';
    }
    if (fetched.status === 406) {
      return malformed('versionsRefused');
    }
    return failure('status');
  };

  const page = async (
    signal: AbortSignal,
    generation: number,
    after: string | undefined,
    requested: ReadonlySet<string>,
  ): Promise<PageOutcome> => {
    const nonce = randomBytes(16).toString('base64url');
    const fetched = await fetchPage(after, nonce, signal);
    const fetchedAbandoned = abandoned(generation);
    if (fetchedAbandoned !== undefined) {
      return fetchedAbandoned;
    }
    if (fetched.kind === 'body') {
      const reading = await reader.readPollAnswer(fetched.text);
      const readAbandoned = abandoned(generation);
      if (readAbandoned !== undefined) {
        return readAbandoned;
      }
      if (reading.kind === 'malformed') {
        return malformed(reading.reason);
      }
      const { answer } = reading;
      if (answer.nonce !== nonce || answer.after !== (after ?? HEAD)) {
        return malformed('echoMismatch');
      }
      if (answer.more && requested.has(answer.next)) {
        return malformed('cursorRepeated');
      }
      answer.notices.forEach((notice) => sink.applyNotice(notice));
      state.position = answer.next;
      return answer.more ? 'more' : 'checked';
    }
    return reportOrReset(fetched, after);
  };

  /**
   * Runs a check's pages in turn while each asks for more. A page asking for more must name, as
   * `next`, a cursor new to the check: none of its pages, the first included, was sent with it. A
   * page naming one already sent is malformed and ends the check. A last page, asking for no more,
   * may name the cursor it was sent with, as it does when no newer notice exists.
   */
  const pages = async (
    signal: AbortSignal,
    generation: number,
    requestedBefore: ReadonlySet<string> = new Set(),
  ): Promise<CheckOutcome> => {
    const after = state.position;
    const requested =
      after === undefined
        ? requestedBefore
        : new Set([...requestedBefore, after]);
    const outcome = await page(signal, generation, after, requested);
    return outcome === 'more' ? pages(signal, generation, requested) : outcome;
  };

  const run = async (startedAt: number): Promise<CheckOutcome> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), deadlineMs);
    deadline.unref?.();
    state.inFlight = controller;
    const { generation } = state;
    try {
      const outcome = await pages(controller.signal, generation);
      const since = abandoned(generation);
      if (since !== undefined) {
        return since;
      }
      if (outcome === 'checked') {
        sink.confirmChannel(startedAt);
      }
      return outcome;
    } catch {
      return abandoned(generation) ?? failure('defect');
    } finally {
      clearTimeout(deadline);
      if (state.inFlight === controller) {
        state.inFlight = undefined;
      }
    }
  };

  /** The check in flight, or a new one started now; a stopped poll starts none. */
  const begin = (): Running | undefined => {
    if (state.stopped) {
      return undefined;
    }
    if (state.running !== undefined) {
      return state.running;
    }
    const startedAt = monotonicClock.now();
    const outcome: Promise<CheckOutcome> = run(startedAt).finally(() => {
      state.runs.delete(outcome);
      if (state.running?.outcome === outcome) {
        state.running = undefined;
      }
    });
    state.running = { outcome, startedAt };
    state.runs.add(outcome);
    return state.running;
  };

  const check = (): Promise<CheckOutcome> =>
    begin()?.outcome ?? Promise.resolve('stopped');

  /** Arms the next step, replacing any already armed, so two steps ending together leave one. */
  const schedule = (delayMs: number, retrying: boolean): void => {
    // A check can end just before a stop, and the step awaiting it reaches here after the stop.
    if (state.stopped) {
      return;
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void cycle(retrying);
    }, delayMs);
    state.timer.unref?.();
  };

  /**
   * One step of the schedule. The next poll is timed from the start of the check joined by this
   * step: at the poll interval after a recorded check, and at the recovery interval after a failed
   * retry. A first failure is retried at once, and a reset asks for head at once. Recovery is held in
   * no state, so an abandoned check neither starts nor ends it.
   */
  const cycle = async (retrying: boolean): Promise<void> => {
    const running = begin();
    if (running === undefined) {
      return;
    }
    const { startedAt } = running;
    const outcome = await running.outcome;
    if (outcome === 'stopped') {
      return;
    }
    if (outcome === 'checked' || (outcome === 'failed' && retrying)) {
      const interval =
        (outcome === 'checked' ? intervalMs : recoveryIntervalMs) *
        (0.9 + 0.2 * random());
      schedule(
        Math.max(0, Math.floor(startedAt + interval - monotonicClock.now())),
        false,
      );
      return;
    }
    schedule(0, outcome === 'failed');
  };

  return {
    check,

    forget: () => {
      state.generation += 1;
      state.position = undefined;
      state.inFlight?.abort();
      state.running = undefined;
    },

    pollNow: () => {
      void cycle(false);
    },

    position: () => state.position,

    start: () => {
      if (!state.started) {
        state.started = true;
        void cycle(false);
      }
    },

    stop: async () => {
      state.stopped = true;
      clearTimeout(state.timer);
      state.timer = undefined;
      state.inFlight?.abort();
      await Promise.all(state.runs);
    },
  };
};
