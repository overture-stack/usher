import type { Notice } from '@overture-stack/usher-types';

import type { ChannelReader } from './channelReader.js';
import type { Clock } from './clocks.js';
import type { ControllerFetch } from './controllerClient.js';
import { createChannelFailureTally, type EventLog } from './events.js';
import { createPoll } from './poll.js';
import { createPush } from './push.js';

/** The members of the core driven by the channel. */
export interface ChannelCore {
  /** Applies one notice; the poll and the push may each deliver the same one. */
  applyNotice(notice: Notice): void;

  /** A check was recorded; `checkStartedAt` is its first page's start on the monotonic clock, in ms. */
  confirmChannel(checkStartedAt: number): void;

  /** History was lost: the controller answered 410 to the poll or the push. */
  reset(): void;
}

/** The revocation channel: the poll and the push. */
export interface Channel {
  start(): void;

  /**
   * Stops the poll and the push, and logs the failures still counted; a logger that throws as it
   * does so cannot keep the channel from stopping.
   *
   * @returns a promise settled once neither has a request in flight.
   */
  stop(): Promise<void>;
}

/** What the channel needs. */
export interface ChannelOptions {
  /** Signs a fresh channel assertion on each call. */
  assertion: () => Promise<string>;

  /** The controller's base URL, ending in `/`. */
  controllerUrl: URL;

  core: ChannelCore;

  /** How long a check of the poll may run, from its first page's start, before it is aborted. */
  deadlineMs: number;

  events: EventLog;
  fetch: ControllerFetch;

  /** How long the push may stay silent before it is replaced. */
  idleMs: number;

  /** The poll interval, which also caps the push's reconnect backoff. */
  intervalMs: number;

  monotonicClock: Clock;

  /** Uniform randomness in [0, 1), for the poll's jitter and the push's backoff. */
  random: () => number;

  reader: ChannelReader;

  /** The poll's recovery interval, at most `intervalMs`, in force while checks are failing. */
  recoveryIntervalMs: number;

  /** The most bytes read from a poll answer before it is refused unread. */
  responseCapBytes: number;
}

/**
 * Creates the revocation channel: the poll, the only check, and the push, which opens from the
 * poll's head and resumes from its own position. The tally's timer is unreferenced.
 *
 * - A 410 on either resets the core once and sends both to head. On the poll, the push drops its
 *   position and its connection; on the push, the poll forgets its position and polls at once.
 * - A push silent past its idle timer asks for a poll at once.
 * - A poll asked for by the push runs as a scheduled one does: a failure is retried at once, a failed
 *   retry times the next poll at the recovery interval, and a reset asks for head at once.
 * - Each failed check of the poll, and each defect thrown on the push while applying a notice or
 *   handing over a 410 or a silence, is counted by cause. One `revocationChannel.failure` per cause
 *   carries its count once an interval has passed since the first, or when the channel stops.
 */
export const createChannel = ({
  assertion,
  controllerUrl,
  core,
  deadlineMs,
  events,
  fetch,
  idleMs,
  intervalMs,
  monotonicClock,
  random,
  reader,
  recoveryIntervalMs,
  responseCapBytes,
}: ChannelOptions): Channel => {
  const failures = createChannelFailureTally(events);
  const poll = createPoll({
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
    sink: {
      applyNotice: (notice) => core.applyNotice(notice),
      confirmChannel: (checkStartedAt) => core.confirmChannel(checkStartedAt),
      failed: (cause) => failures.record(cause),
      reset: () => {
        core.reset();
        push.forget();
      },
    },
  });
  const push = createPush({
    assertion,
    controllerUrl,
    events,
    fetch,
    headPosition: () => poll.position(),
    idleMs,
    maxBackoffMs: intervalMs,
    random,
    reader,
    sink: {
      applyNotice: (notice) => core.applyNotice(notice),
      defect: () => failures.record('defect'),
      historyLost: () => {
        core.reset();
        poll.forget();
        poll.pollNow();
      },
      silent: () => {
        poll.pollNow();
      },
    },
  });

  return {
    start: () => {
      poll.start();
      push.start();
    },

    stop: async () => {
      const stopping = Promise.all([poll.stop(), push.stop()]);
      // The tally logs what it holds, so it stops once neither the poll nor the push can count more.
      failures.stop();
      await stopping;
    },
  };
};
